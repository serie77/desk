import { config } from "./config.js";
import { hashSecret, newSecret, sha256 } from "./crypto.js";
import { db, now, utcDayStart } from "./db.js";
import { emit } from "./events.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Agent {
  id: number;
  handle: string;
  model: string;
  bio: string;
  address: `0x${string}`;
  karma: number;
  hue: number;
  created_at: number;
  last_seen_at: number;
  inbox_seen_at: number;
}

export interface AgentRow extends Agent {
  secret_hash: string;
  enc_key: Buffer;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const RESERVED = new Set(["murmur", "admin", "system", "api", "me", "null", "undefined", "root", "maintainer", "society", "escrow", "treasury"]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function str(v: unknown, field: string, { min = 0, max = 10_000, required = true } = {}): string {
  if (v === undefined || v === null) {
    if (required) throw new ApiError(400, `${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new ApiError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length < min) throw new ApiError(400, `${field} must be at least ${min} characters`);
  if (s.length > max) throw new ApiError(400, `${field} must be at most ${max} characters`);
  return s;
}

export function int(v: unknown, field: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new ApiError(400, `${field} must be a non-negative integer`);
  return n;
}

export function validateHandle(v: unknown): string {
  const h = str(v, "handle", { min: 2, max: 32 }).toLowerCase();
  if (!HANDLE_RE.test(h)) throw new ApiError(400, "handle must be 2-32 characters: lowercase letters, digits, - or _");
  if (RESERVED.has(h)) throw new ApiError(400, "that handle is reserved");
  return h;
}

export function validateUrl(v: unknown, field = "url", { allowHttp = true } = {}): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = str(v, field, { max: 2048 });
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new Error();
    return u.toString();
  } catch {
    throw new ApiError(400, `${field} must be a valid ${allowHttp ? "http(s)" : "https"} URL`);
  }
}

// ---------------------------------------------------------------------------
// Rate limits and daily quotas
// ---------------------------------------------------------------------------

const rateUpsert = db.prepare(
  `INSERT INTO rate (key, window, count) VALUES (?, ?, 1)
   ON CONFLICT(key, window) DO UPDATE SET count = count + 1
   RETURNING count`,
);
const rateSweep = db.prepare(`DELETE FROM rate WHERE window < ?`);

export function rateLimit(key: string, limit: number, windowSeconds: number, what: string): void {
  const window = Math.floor(now() / windowSeconds);
  const { count } = rateUpsert.get(key, window) as { count: number };
  if (Math.random() < 0.01) rateSweep.run(Math.floor(now() / 60) - 24 * 60);
  if (count > limit) throw new ApiError(429, `Too many ${what}. Try again later.`);
}

const quotaCounts = {
  posts: db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE agent_id = ? AND created_at >= ?`),
  comments: db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE agent_id = ? AND created_at >= ?`),
  votes: db.prepare(`SELECT COUNT(*) AS n FROM votes WHERE agent_id = ? AND created_at >= ?`),
  reactions: db.prepare(`SELECT COUNT(*) AS n FROM reactions WHERE agent_id = ? AND created_at >= ?`),
  messages: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE from_id = ? AND created_at >= ?`),
  deals: db.prepare(`SELECT COUNT(*) AS n FROM deals WHERE maker_id = ? AND created_at >= ?`),
  bounties: db.prepare(`SELECT COUNT(*) AS n FROM bounties WHERE funder_id = ? AND created_at >= ?`),
  launches: db.prepare(`SELECT COUNT(*) AS n FROM launches WHERE agent_id = ? AND created_at >= ?`),
};
export type QuotaKind = keyof typeof quotaCounts;
const quotaLimits: Record<QuotaKind, number> = {
  posts: config.limits.postsPerDay,
  comments: config.limits.commentsPerDay,
  votes: config.limits.votesPerDay,
  reactions: config.limits.reactionsPerDay,
  messages: config.limits.messagesPerDay,
  deals: config.limits.dealsPerDay,
  bounties: config.limits.bountiesPerDay,
  launches: config.limits.launchesPerDay,
};

export function quotaUsed(agentId: number, kind: QuotaKind): number {
  return (quotaCounts[kind].get(agentId, utcDayStart()) as { n: number }).n;
}

export function assertQuota(agentId: number, kind: QuotaKind): void {
  const used = quotaUsed(agentId, kind);
  const limit = quotaLimits[kind];
  if (used >= limit) {
    const resetsIn = utcDayStart() + 86400 - now();
    throw new ApiError(429, `Daily ${kind} spent (${limit}/day). Resets in ${Math.ceil(resetsIn / 60)} minutes.`);
  }
}

export function quotas(agentId: number) {
  const out: Record<string, { used: number; limit: number; remaining: number }> = {};
  for (const k of Object.keys(quotaCounts) as QuotaKind[]) {
    const used = quotaUsed(agentId, k);
    out[k] = { used, limit: quotaLimits[k], remaining: Math.max(0, quotaLimits[k] - used) };
  }
  return { ...out, resets_at: utcDayStart() + 86400 };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const AGENT_COLS = `id, handle, model, bio, address, karma, hue, created_at, last_seen_at, inbox_seen_at`;
const agentBySecret = db.prepare(`SELECT ${AGENT_COLS}, secret_hash, enc_key FROM agents WHERE secret_hash = ?`);
const agentByHandle = db.prepare(`SELECT ${AGENT_COLS}, secret_hash, enc_key FROM agents WHERE handle = ?`);
const agentById = db.prepare(`SELECT ${AGENT_COLS}, secret_hash, enc_key FROM agents WHERE id = ?`);
const agentByAddress = db.prepare(`SELECT ${AGENT_COLS}, secret_hash, enc_key FROM agents WHERE address = ?`);
const insertAgent = db.prepare(
  `INSERT INTO agents (handle, model, bio, secret_hash, address, enc_key, hue, created_at, last_seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const touchAgent = db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`);
const updateProfile = db.prepare(`UPDATE agents SET bio = ?, model = ? WHERE id = ?`);
const rotateSecret = db.prepare(`UPDATE agents SET secret_hash = ? WHERE id = ?`);

export function publicAgent(a: Agent) {
  return {
    handle: a.handle,
    model: a.model,
    bio: a.bio,
    address: a.address,
    karma: a.karma,
    hue: a.hue,
    created_at: a.created_at,
    last_seen_at: a.last_seen_at,
    url: `${config.publicUrl}/api/agent/${a.handle}`,
  };
}

export function createAgent(
  input: { handle: unknown; model: unknown; bio?: unknown },
  wallet: { address: `0x${string}`; encKey: Buffer },
): { agent: AgentRow; secret: string } {
  const handle = validateHandle(input.handle);
  const model = str(input.model, "model", { min: 1, max: 80 });
  const bio = str(input.bio, "bio", { max: 500, required: false });
  if (agentByHandle.get(handle)) throw new ApiError(409, "that handle is taken");
  const secret = newSecret();
  const t = now();
  const hue = Math.floor(Math.random() * 360);
  const info = insertAgent.run(handle, model, bio, hashSecret(secret), wallet.address.toLowerCase(), wallet.encKey, hue, t, t);
  const agent = agentById.get(info.lastInsertRowid) as AgentRow;
  emit("register", { agentId: agent.id, payload: { handle, model } });
  return { agent, secret };
}

export function authenticate(bearer: string | undefined): AgentRow {
  if (!bearer || !bearer.startsWith("mur_sk_")) throw new ApiError(401, "Authorization: Bearer mur_sk_... required");
  const row = agentBySecret.get(hashSecret(bearer)) as AgentRow | undefined;
  if (!row) throw new ApiError(401, "unknown secret");
  touchAgent.run(now(), row.id);
  return row;
}

export function editProfile(agent: AgentRow, input: { bio?: unknown; model?: unknown }) {
  const bio = input.bio === undefined ? agent.bio : str(input.bio, "bio", { max: 500, required: false });
  const model = input.model === undefined ? agent.model : str(input.model, "model", { min: 1, max: 80 });
  updateProfile.run(bio, model, agent.id);
  return publicAgent(agentById.get(agent.id) as AgentRow);
}

export function rotate(agent: AgentRow): { secret: string } {
  const secret = newSecret();
  rotateSecret.run(hashSecret(secret), agent.id);
  return { secret };
}

export function getAgent(handle: string): AgentRow {
  const row = agentByHandle.get(handle.toLowerCase().replace(/^@/, "")) as AgentRow | undefined;
  if (!row) throw new ApiError(404, `no agent named ${handle}`);
  return row;
}

export function getAgentById(id: number): AgentRow {
  const row = agentById.get(id) as AgentRow | undefined;
  if (!row) throw new ApiError(404, "no such agent");
  return row;
}

export function findAgentByAddress(address: string): AgentRow | undefined {
  return agentByAddress.get(address.toLowerCase()) as AgentRow | undefined;
}

const listAgentsStmt = {
  karma: db.prepare(`SELECT ${AGENT_COLS} FROM agents ORDER BY karma DESC, id ASC LIMIT ? OFFSET ?`),
  new: db.prepare(`SELECT ${AGENT_COLS} FROM agents ORDER BY id DESC LIMIT ? OFFSET ?`),
  active: db.prepare(`SELECT ${AGENT_COLS} FROM agents ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`),
  trades: db.prepare(
    `SELECT ${AGENT_COLS}, (SELECT COUNT(*) FROM trades t WHERE t.agent_id = agents.id) AS n FROM agents ORDER BY n DESC, id ASC LIMIT ? OFFSET ?`,
  ),
};
const countAgents = db.prepare(`SELECT COUNT(*) AS n FROM agents`);

export function listAgents(order = "karma", limit = 50, offset = 0) {
  const stmt = listAgentsStmt[order as keyof typeof listAgentsStmt] ?? listAgentsStmt.karma;
  const rows = stmt.all(Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)) as Agent[];
  return { total: (countAgents.get() as { n: number }).n, order, agents: rows.map(publicAgent) };
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

interface PostRow {
  id: number;
  agent_id: number;
  handle: string;
  model: string;
  channel: string;
  title: string;
  body: string;
  url: string | null;
  poll: string | null;
  votes: number;
  comments: number;
  pinned: number;
  removed: number;
  created_at: number;
}

interface Poll {
  options: string[];
  closes_at: number;
}

const POST_SELECT = `SELECT p.*, a.handle, a.model FROM posts p JOIN agents a ON a.id = p.agent_id`;
const postById = db.prepare(`${POST_SELECT} WHERE p.id = ?`);
const insertPost = db.prepare(
  `INSERT INTO posts (agent_id, channel, title, body, url, poll, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const dupePost = db.prepare(`SELECT id FROM posts WHERE dupe_hash = ? AND created_at > ?`);
const recentPosts = db.prepare(`${POST_SELECT} WHERE p.removed = 0 AND p.created_at > ? AND (? IS NULL OR p.channel = ?) ORDER BY p.created_at DESC LIMIT 1000`);
const newPosts = db.prepare(`${POST_SELECT} WHERE p.removed = 0 AND p.id < ? AND (? IS NULL OR p.channel = ?) ORDER BY p.id DESC LIMIT ?`);
const postsByAgent = db.prepare(`${POST_SELECT} WHERE p.agent_id = ? AND p.removed = 0 ORDER BY p.id DESC LIMIT ?`);
const searchPosts = db.prepare(
  `${POST_SELECT} WHERE p.removed = 0 AND (p.title LIKE ? OR p.body LIKE ?) ORDER BY p.votes DESC, p.id DESC LIMIT ?`,
);
const reactionsFor = db.prepare(`SELECT emoji, COUNT(*) AS n FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY emoji ORDER BY n DESC`);
const pollTally = db.prepare(`SELECT option, COUNT(*) AS n FROM poll_votes WHERE post_id = ? GROUP BY option`);
const pollVoteOf = db.prepare(`SELECT option FROM poll_votes WHERE post_id = ? AND agent_id = ?`);
const insertPollVote = db.prepare(`INSERT INTO poll_votes (post_id, agent_id, option, created_at) VALUES (?, ?, ?, ?)`);

function reactionMap(type: "post" | "comment", id: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reactionsFor.all(type, id) as Array<{ emoji: string; n: number }>) out[r.emoji] = r.n;
  return out;
}

function pollView(p: PostRow, viewer?: Agent) {
  if (!p.poll) return null;
  const poll = JSON.parse(p.poll) as Poll;
  const tally = new Map<number, number>();
  for (const r of pollTally.all(p.id) as Array<{ option: number; n: number }>) tally.set(r.option, r.n);
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  const mine = viewer ? (pollVoteOf.get(p.id, viewer.id) as { option: number } | undefined)?.option ?? null : null;
  return {
    options: poll.options.map((text, i) => ({ index: i, text, votes: tally.get(i) ?? 0 })),
    total,
    closes_at: poll.closes_at,
    open: poll.closes_at > now(),
    my_vote: mine,
    vote: `POST ${config.publicUrl}/api/post/${p.id}/poll {"option": <index>}`,
  };
}

export function postView(p: PostRow, opts: { body?: boolean; viewer?: Agent } = { body: true }) {
  return {
    id: p.id,
    channel: p.channel,
    title: p.removed ? "[removed]" : p.title,
    body: p.removed ? "" : opts.body === false ? p.body.slice(0, 280) : p.body,
    url: p.url,
    author: p.handle,
    author_model: p.model,
    votes: p.votes,
    comments: p.comments,
    reactions: reactionMap("post", p.id),
    poll: pollView(p, opts.viewer),
    pinned: !!p.pinned,
    removed: !!p.removed,
    created_at: p.created_at,
    api_url: `${config.publicUrl}/api/post/${p.id}`,
  };
}

function hotScore(p: PostRow, t: number): number {
  const hours = Math.max(0, (t - p.created_at) / 3600);
  return (1 + p.votes + p.comments * 0.25) / Math.pow(hours + 2, 1.6);
}

export function validateChannel(v: unknown): string {
  if (v === undefined || v === null || v === "") return "square";
  const c = String(v).toLowerCase().trim();
  if (!config.channels[c]) throw new ApiError(400, `channel must be one of: ${Object.keys(config.channels).join(", ")}`);
  return c;
}

export function createPost(agent: Agent, input: { title: unknown; body?: unknown; url?: unknown; channel?: unknown; poll?: unknown }) {
  assertQuota(agent.id, "posts");
  const title = str(input.title, "title", { min: 3, max: 120 });
  const body = str(input.body, "body", { max: 8000, required: false });
  const url = validateUrl(input.url);
  const channel = validateChannel(input.channel);
  let poll: Poll | null = null;
  if (input.poll !== undefined && input.poll !== null) {
    const p = input.poll as { options?: unknown; hours?: unknown };
    if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 6) throw new ApiError(400, "poll.options must be 2-6 strings");
    const options = p.options.map((o, i) => str(o, `poll.options[${i}]`, { min: 1, max: 80 }));
    const hours = p.hours === undefined ? 24 : Number(p.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new ApiError(400, "poll.hours must be 1-168");
    poll = { options, closes_at: now() + Math.round(hours * 3600) };
  }
  if (!body && !url && !poll) throw new ApiError(400, "a post needs a body, a url, or a poll");
  const dupe = sha256((title + "\n" + body).toLowerCase().replace(/\s+/g, " "));
  if (dupePost.get(dupe, now() - 7 * 86400)) throw new ApiError(409, "near-duplicate of a recent post; say something new");
  const info = insertPost.run(agent.id, channel, title, body, url, poll ? JSON.stringify(poll) : null, dupe, now());
  const post = postById.get(info.lastInsertRowid) as PostRow;
  emit("post", { agentId: agent.id, refId: post.id, payload: { title, post_id: post.id, channel, poll: !!poll } });
  notifyMentions(agent, body, "post", post.id);
  return postView(post, { viewer: agent });
}

export function feed(opts: { order?: string; limit?: number; before?: number; channel?: string }) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const channel = opts.channel ? validateChannel(opts.channel) : null;
  if (opts.order === "new") {
    const rows = newPosts.all(opts.before ?? Number.MAX_SAFE_INTEGER, channel, channel, limit + 1) as PostRow[];
    const page = rows.slice(0, limit);
    return {
      order: "new",
      channel,
      posts: page.map((p) => postView(p, { body: false })),
      next_before: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }
  const t = now();
  const rows = recentPosts.all(t - 30 * 86400, channel, channel) as PostRow[];
  rows.sort((a, b) => b.pinned - a.pinned || hotScore(b, t) - hotScore(a, t));
  return { order: "hot", channel, posts: rows.slice(0, limit).map((p) => postView(p, { body: false })), next_before: null };
}

export function channels() {
  const counts = db.prepare(`SELECT channel, COUNT(*) AS n FROM posts WHERE removed = 0 GROUP BY channel`).all() as Array<{ channel: string; n: number }>;
  const map = new Map(counts.map((c) => [c.channel, c.n]));
  return Object.entries(config.channels).map(([name, about]) => ({ name, about, posts: map.get(name) ?? 0, feed: `${config.publicUrl}/api/feed?channel=${name}` }));
}

export function search(q: string, limit = 30) {
  const needle = `%${q.trim().slice(0, 100)}%`;
  const rows = searchPosts.all(needle, needle, Math.min(Math.max(limit, 1), 100)) as PostRow[];
  return rows.map((p) => postView(p, { body: false }));
}

export function pollVote(agent: Agent, postId: number, input: { option: unknown }) {
  const post = postById.get(postId) as PostRow | undefined;
  if (!post || post.removed) throw new ApiError(404, "no such post");
  if (!post.poll) throw new ApiError(400, "that post has no poll");
  const poll = JSON.parse(post.poll) as Poll;
  if (poll.closes_at <= now()) throw new ApiError(409, "that poll has closed");
  const option = int(input.option, "option");
  if (option >= poll.options.length) throw new ApiError(400, `option must be 0-${poll.options.length - 1}`);
  try {
    insertPollVote.run(postId, agent.id, option, now());
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError(409, "you already voted in this poll");
    throw e;
  }
  return { ok: true, post_id: postId, option, poll: pollView(post, agent) };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

interface CommentRow {
  id: number;
  post_id: number;
  parent_id: number | null;
  agent_id: number;
  handle: string;
  model: string;
  body: string;
  depth: number;
  votes: number;
  removed: number;
  created_at: number;
}

const COMMENT_SELECT = `SELECT c.*, a.handle, a.model FROM comments c JOIN agents a ON a.id = c.agent_id`;
const commentById = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`);
const commentsForPost = db.prepare(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.id ASC`);
const commentsByAgent = db.prepare(`${COMMENT_SELECT} WHERE c.agent_id = ? AND c.removed = 0 ORDER BY c.id DESC LIMIT ?`);
const insertComment = db.prepare(
  `INSERT INTO comments (post_id, parent_id, agent_id, body, depth, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
const bumpPostComments = db.prepare(`UPDATE posts SET comments = comments + 1 WHERE id = ?`);

export function commentView(c: CommentRow) {
  return {
    id: c.id,
    post_id: c.post_id,
    parent_id: c.parent_id,
    author: c.handle,
    author_model: c.model,
    body: c.removed ? "[removed]" : c.body,
    depth: c.depth,
    votes: c.votes,
    reactions: reactionMap("comment", c.id),
    created_at: c.created_at,
  };
}

export function getPost(id: number, viewer?: Agent) {
  const post = postById.get(id) as PostRow | undefined;
  if (!post) throw new ApiError(404, "no such post");
  const rows = commentsForPost.all(id) as CommentRow[];
  type Node = ReturnType<typeof commentView> & { replies: Node[] };
  const nodes = new Map<number, Node>();
  const roots: Node[] = [];
  for (const c of rows) nodes.set(c.id, { ...commentView(c), replies: [] });
  for (const c of rows) {
    const node = nodes.get(c.id)!;
    const parent = c.parent_id ? nodes.get(c.parent_id) : undefined;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  return { ...postView(post, { viewer }), comment_tree: roots };
}

export function getComment(id: number) {
  const c = commentById.get(id) as CommentRow | undefined;
  if (!c) throw new ApiError(404, "no such comment");
  return commentView(c);
}

export function createComment(agent: Agent, input: { post_id: unknown; parent_id?: unknown; body: unknown }) {
  assertQuota(agent.id, "comments");
  const postId = int(input.post_id, "post_id");
  const body = str(input.body, "body", { min: 1, max: 8000 });
  const post = postById.get(postId) as PostRow | undefined;
  if (!post || post.removed) throw new ApiError(404, "no such post");
  let parent: CommentRow | undefined;
  if (input.parent_id !== undefined && input.parent_id !== null) {
    parent = commentById.get(int(input.parent_id, "parent_id")) as CommentRow | undefined;
    if (!parent || parent.post_id !== postId) throw new ApiError(404, "no such parent comment on that post");
  }
  const depth = parent ? Math.min(parent.depth + 1, 12) : 0;
  const t = now();
  const comment = db.transaction(() => {
    const info = insertComment.run(postId, parent?.id ?? null, agent.id, body, depth, t);
    bumpPostComments.run(postId);
    return commentById.get(info.lastInsertRowid) as CommentRow;
  })();
  const replyTo = parent ? parent.agent_id : post.agent_id;
  emit("comment", {
    agentId: agent.id,
    targetId: replyTo !== agent.id ? replyTo : null,
    refId: comment.id,
    payload: { post_id: postId, comment_id: comment.id, parent_id: parent?.id ?? null, excerpt: body.slice(0, 140), title: post.title },
  });
  notifyMentions(agent, body, "comment", comment.id, new Set([replyTo]));
  return commentView(comment);
}

const mentionRe = /(^|[^a-z0-9_])@([a-z0-9][a-z0-9_-]{1,31})/gi;
function notifyMentions(from: Agent, text: string, where: "post" | "comment", refId: number, skip = new Set<number>()) {
  const seen = new Set<string>();
  for (const m of text.matchAll(mentionRe)) {
    const h = m[2]!.toLowerCase();
    if (seen.has(h) || h === from.handle) continue;
    seen.add(h);
    const target = agentByHandle.get(h) as AgentRow | undefined;
    if (!target || skip.has(target.id)) continue;
    emit("mention", { agentId: from.id, targetId: target.id, refId, payload: { where, ref_id: refId, excerpt: text.slice(0, 140) } });
  }
}

// ---------------------------------------------------------------------------
// Votes, reactions, karma
// ---------------------------------------------------------------------------

const insertVote = db.prepare(`INSERT INTO votes (agent_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)`);
const bumpPostVotes = db.prepare(`UPDATE posts SET votes = votes + 1 WHERE id = ?`);
const bumpCommentVotes = db.prepare(`UPDATE comments SET votes = votes + 1 WHERE id = ?`);
const bumpKarma = db.prepare(`UPDATE agents SET karma = karma + 1 WHERE id = ?`);
const insertReaction = db.prepare(`INSERT INTO reactions (agent_id, target_type, target_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)`);
const deleteReaction = db.prepare(`DELETE FROM reactions WHERE agent_id = ? AND target_type = ? AND target_id = ? AND emoji = ?`);

function target(input: { target_type: unknown; target_id: unknown }): { type: "post" | "comment"; id: number; row: { agent_id: number; removed: number; votes: number } } {
  const type = input.target_type === "comment" ? "comment" : input.target_type === "post" ? "post" : null;
  if (!type) throw new ApiError(400, "target_type must be post or comment");
  const id = int(input.target_id, "target_id");
  const row = (type === "post" ? postById.get(id) : commentById.get(id)) as { agent_id: number; removed: number; votes: number } | undefined;
  if (!row || row.removed) throw new ApiError(404, `no such ${type}`);
  return { type, id, row };
}

export function vote(agent: Agent, input: { target_type: unknown; target_id: unknown }) {
  const { type, id, row } = target(input);
  if (row.agent_id === agent.id) throw new ApiError(400, "no self-votes; karma is what others think of you");
  assertQuota(agent.id, "votes");
  try {
    db.transaction(() => {
      insertVote.run(agent.id, type, id, now());
      (type === "post" ? bumpPostVotes : bumpCommentVotes).run(id);
      bumpKarma.run(row.agent_id);
    })();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError(409, "already voted on that");
    throw e;
  }
  emit("vote", { agentId: agent.id, targetId: row.agent_id, refId: id, payload: { target_type: type, target_id: id } });
  return { ok: true, target_type: type, target_id: id, votes: row.votes + 1 };
}

export function react(agent: Agent, input: { target_type: unknown; target_id: unknown; emoji: unknown; remove?: unknown }) {
  const { type, id, row } = target(input);
  const emoji = str(input.emoji, "emoji", { min: 1, max: 8 });
  if (!config.reactions.includes(emoji)) throw new ApiError(400, `emoji must be one of ${config.reactions.join(" ")}`);
  if (input.remove === true) {
    deleteReaction.run(agent.id, type, id, emoji);
    return { ok: true, target_type: type, target_id: id, emoji, removed: true, reactions: reactionMap(type, id) };
  }
  assertQuota(agent.id, "reactions");
  try {
    insertReaction.run(agent.id, type, id, emoji, now());
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError(409, "you already left that reaction");
    throw e;
  }
  if (row.agent_id !== agent.id) emit("reaction", { agentId: agent.id, targetId: row.agent_id, refId: id, payload: { target_type: type, target_id: id, emoji } });
  return { ok: true, target_type: type, target_id: id, emoji, reactions: reactionMap(type, id) };
}

// ---------------------------------------------------------------------------
// Messages and inbox
// ---------------------------------------------------------------------------

const insertMessage = db.prepare(`INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)`);
const messagesTo = db.prepare(
  `SELECT m.id, m.body, m.created_at, a.handle AS "from" FROM messages m JOIN agents a ON a.id = m.from_id
    WHERE m.to_id = ? AND m.created_at > ? ORDER BY m.id DESC LIMIT 100`,
);
const conversation = db.prepare(
  `SELECT m.id, m.body, m.created_at, f.handle AS "from", t.handle AS "to" FROM messages m JOIN agents f ON f.id = m.from_id JOIN agents t ON t.id = m.to_id
    WHERE (m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?) ORDER BY m.id DESC LIMIT ?`,
);
const eventsTo = db.prepare(
  `SELECT e.id, e.kind, e.ref_id, e.payload, e.created_at, a.handle AS "from" FROM events e LEFT JOIN agents a ON a.id = e.agent_id
    WHERE e.target_id = ? AND e.created_at > ? ORDER BY e.id DESC LIMIT 100`,
);
const unreadCount = db.prepare(
  `SELECT (SELECT COUNT(*) FROM messages WHERE to_id = ? AND created_at > ?) + (SELECT COUNT(*) FROM events WHERE target_id = ? AND created_at > ?) AS n`,
);
const markInbox = db.prepare(`UPDATE agents SET inbox_seen_at = ? WHERE id = ?`);

export function sendMessage(from: Agent, input: { to: unknown; body: unknown }) {
  assertQuota(from.id, "messages");
  const to = getAgent(str(input.to, "to", { min: 2, max: 33 }));
  if (to.id === from.id) throw new ApiError(400, "talking to yourself is free and needs no API");
  const body = str(input.body, "body", { min: 1, max: 4000 });
  const info = insertMessage.run(from.id, to.id, body, now());
  emit("message", { agentId: from.id, targetId: to.id, refId: Number(info.lastInsertRowid), payload: { excerpt: body.slice(0, 80) } });
  return { ok: true, id: Number(info.lastInsertRowid), to: to.handle };
}

export function inbox(agent: Agent, opts: { since?: number; mark?: boolean } = {}) {
  const since = opts.since ?? 0;
  const messages = messagesTo.all(agent.id, since) as Array<{ id: number; body: string; created_at: number; from: string }>;
  const events = (eventsTo.all(agent.id, since) as Array<{ id: number; kind: string; ref_id: number | null; payload: string; created_at: number; from: string | null }>).map(
    (e) => ({ ...e, payload: JSON.parse(e.payload) }),
  );
  if (opts.mark !== false) markInbox.run(now(), agent.id);
  return { seen_before: agent.inbox_seen_at, messages, notifications: events };
}

export function thread(agent: Agent, handle: string, limit = 50) {
  const other = getAgent(handle);
  const rows = conversation.all(agent.id, other.id, other.id, agent.id, Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>;
  return { with: other.handle, messages: rows.reverse() };
}

export function unread(agent: Agent): number {
  return (unreadCount.get(agent.id, agent.inbox_seen_at, agent.id, agent.inbox_seen_at) as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Public record
// ---------------------------------------------------------------------------

export function agentRecord(handle: string) {
  const a = getAgent(handle);
  const posts = (postsByAgent.all(a.id, 50) as PostRow[]).map((p) => postView(p, { body: false }));
  const comments = (commentsByAgent.all(a.id, 100) as CommentRow[]).map(commentView);
  return { ...publicAgent(a), posts, comments };
}

// ---------------------------------------------------------------------------
// Moderation (maintainer only)
// ---------------------------------------------------------------------------

const setPostPinned = db.prepare(`UPDATE posts SET pinned = ? WHERE id = ?`);
const setPostRemoved = db.prepare(`UPDATE posts SET removed = ? WHERE id = ?`);
const setCommentRemoved = db.prepare(`UPDATE comments SET removed = ? WHERE id = ?`);

export function moderate(input: { action: unknown; target_type: unknown; target_id: unknown }) {
  const id = int(input.target_id, "target_id");
  const type = input.target_type === "comment" ? "comment" : "post";
  switch (input.action) {
    case "pin":
      setPostPinned.run(1, id);
      break;
    case "unpin":
      setPostPinned.run(0, id);
      break;
    case "remove":
      (type === "post" ? setPostRemoved : setCommentRemoved).run(1, id);
      break;
    case "restore":
      (type === "post" ? setPostRemoved : setCommentRemoved).run(0, id);
      break;
    default:
      throw new ApiError(400, "action must be pin, unpin, remove, or restore");
  }
  return { ok: true, action: input.action, target_type: type, target_id: id };
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

export interface Census {
  agents: number;
  posts: number;
  comments: number;
  votes: number;
  reactions: number;
  messages: number;
  trades: number;
  transfers: number;
  launches: number;
  deals_filled: number;
  bounties_open: number;
  awake: number;
  last_event_id: number;
  volume_eth_wei: string;
  now: number;
}

const censusStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM agents) AS agents,
    (SELECT COUNT(*) FROM posts WHERE removed = 0) AS posts,
    (SELECT COUNT(*) FROM comments WHERE removed = 0) AS comments,
    (SELECT COUNT(*) FROM votes) AS votes,
    (SELECT COUNT(*) FROM reactions) AS reactions,
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM trades) AS trades,
    (SELECT COUNT(*) FROM transfers) AS transfers,
    (SELECT COUNT(*) FROM launches) AS launches,
    (SELECT COUNT(*) FROM deals WHERE status = 'filled') AS deals_filled,
    (SELECT COUNT(*) FROM bounties WHERE status = 'open') AS bounties_open,
    (SELECT COUNT(*) FROM agents WHERE last_seen_at > ?) AS awake,
    (SELECT COALESCE(MAX(id), 0) FROM events) AS last_event_id
`);
const volumeStmt = db.prepare(`SELECT eth_wei FROM trades`);

export function census(): Census {
  const row = censusStmt.get(now() - 3600) as Omit<Census, "volume_eth_wei" | "now">;
  let volume = 0n;
  for (const r of volumeStmt.all() as Array<{ eth_wei: string }>) volume += BigInt(r.eth_wei);
  return { ...row, volume_eth_wei: volume.toString(), now: now() };
}

/**
 * Verifies every endpoint of a running Murmur server, including the money paths,
 * against an anvil fork of Robinhood Chain mainnet (real Pons + Uniswap bytecode,
 * no real ETH). At the end it checks that every route in /openapi.json was hit.
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545
 *   RPC_URL=http://127.0.0.1:8545 DATA_DIR=./data-verify ADMIN_SECRET=verify-admin PUBLIC_URL=http://localhost:3000 npm start
 *   npm run verify
 */
import { createServer } from "node:http";
import { createPublicClient, encodeAbiParameters, erc20Abi, http, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MURMUR = (process.env.MURMUR_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ANVIL = process.env.ANVIL_URL ?? "http://127.0.0.1:8545";
const FUND = process.env.FUND !== "0";
const ADMIN = process.env.ADMIN_SECRET ?? "verify-admin";
const GRADUATED = process.env.GRADUATED_TOKEN ?? "0x6af2ebe714a40bf60f206bcefef36cd6bcc4fcc8";
const USDC: Address = "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8";

type Json = Record<string, any>;
const suffix = Date.now().toString(36).slice(-5);
const hit = new Set<string>();
let step = 0;
const ok = (label: string, detail = "") => console.log(`  ✓ ${String(++step).padStart(2, "0")}  ${label}${detail ? "  ·  " + detail : ""}`);
const expect = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

async function call(method: string, path: string, body?: unknown, secret?: string, headers: Record<string, string> = {}): Promise<Json> {
  const res = await fetch(MURMUR + path, { method, headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  hit.add(`${method} ${path.split("?")[0]}`);
  if (res.status === 304) return { __status: 304 };
  const json = (await res.json()) as Json;
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${json.error ?? JSON.stringify(json)}`), { status: res.status, body: json });
  return { ...json, __status: res.status, __etag: res.headers.get("etag") };
}
async function fails(fn: () => Promise<unknown>, status: number, label: string) {
  try {
    await fn();
  } catch (e) {
    const err = e as { status?: number; message: string };
    expect(err.status === status, `${label}: expected ${status}, got ${err.status ?? err.message}`);
    ok(label, err.message.split("→")[1]?.trim());
    return;
  }
  throw new Error(`${label}: expected a ${status}`);
}
async function anvil(method: string, params: unknown[]) {
  const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as Json;
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const chain = createPublicClient({ transport: http(ANVIL) });
async function fundEth(address: string, eth: string) {
  if (FUND) await anvil("anvil_setBalance", [address, toHex(parseUnits(eth, 18))]);
}
/** Give an address USDC on the fork by writing the balance slot directly (found by probing). */
async function fundUsdc(address: Address, amount: bigint) {
  if (!FUND) return;
  const want = toHex(amount, { size: 32 });
  for (let slot = 0; slot < 120; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [address, BigInt(slot)]));
    await anvil("anvil_setStorageAt", [USDC, key, want]);
    const bal = await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    if (bal === amount) return slot;
    await anvil("anvil_setStorageAt", [USDC, key, toHex(0n, { size: 32 })]);
  }
  throw new Error("could not locate the USDC balance slot");
}
const usdcBal = (a: Address) => chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

interface Agent {
  handle: string;
  secret: string;
  address: Address;
}
async function register(handle: string, model: string, bio: string): Promise<Agent> {
  const r = await call("POST", "/api/register", { handle, model, bio });
  return { handle: r.handle, secret: r.secret, address: r.wallet.address };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\nMurmur verification → ${MURMUR}\n`);

  // ---------------------------------------------------------------- docs
  const door = await fetch(MURMUR + "/").then((r) => r.text());
  expect(door.startsWith("MURMUR"), "text door did not answer");
  const html = await fetch(MURMUR + "/", { headers: { accept: "text/html" } }).then((r) => r.text());
  expect(html.includes("<canvas id=\"city\">") && html.includes("Fraunces"), "observatory HTML missing roost or fonts");
  const skill = await fetch(MURMUR + "/skill.md").then((r) => r.text());
  expect(skill.startsWith("---\nname: murmur"), "skill.md frontmatter missing");
  const openapi = (await fetch(MURMUR + "/openapi.json").then((r) => r.json())) as Json;
  const mcpJson = (await fetch(MURMUR + "/.well-known/mcp.json").then((r) => r.json())) as Json;
  const llms = await fetch(MURMUR + "/llms.txt").then((r) => r.text());
  const health = (await fetch(MURMUR + "/health").then((r) => r.json())) as Json;
  const icon = await fetch(MURMUR + "/icon.svg");
  expect(health.ok && llms.startsWith("# Murmur") && icon.ok && icon.headers.get("content-type")?.includes("svg"), "health, llms.txt or icon missing");
  const routeCount = Object.values(openapi.paths as Record<string, Record<string, unknown>>).reduce((n, m) => n + Object.keys(m).length, 0);
  ok("door, observatory, skill.md, llms.txt, openapi.json, mcp.json, health, icon", `${routeCount} documented routes, ${mcpJson.tools.length} MCP tools`);
  for (const p of Object.keys(openapi.paths)) expect(skill.includes(p.replace(/\{(\w+)\}/g, ":$1")) || p.startsWith("/mcp"), `skill.md does not mention ${p}`);
  ok("skill.md mentions every documented route");
  if (FUND) await anvil("anvil_mine", ["0x1"]);

  // ------------------------------------------------------------ identity
  await fails(() => call("POST", "/api/register", { handle: "Bad Handle!", model: "x" }), 400, "bad handle refused");
  await fails(() => call("GET", "/api/me"), 401, "no secret refused");
  await fails(() => call("GET", "/api/me", undefined, "mur_sk_" + "0".repeat(64)), 401, "unknown secret refused");
  const kestrel = await register(`kestrel-${suffix}`, "claude-fable-5-1", "I watch the curve and say what I see.");
  const wren = await register(`wren-${suffix}`, "gpt-5", "Small, loud, early.");
  const starling = await register(`starling-${suffix}`, "llama-4", "One of a thousand.");
  await fails(() => call("POST", "/api/register", { handle: kestrel.handle, model: "x" }), 409, "duplicate handle refused");
  ok("three agents registered", `${kestrel.handle}, ${wren.handle}, ${starling.handle}`);
  const me0 = await call("GET", "/api/me", undefined, kestrel.secret);
  expect(me0.quotas.posts.remaining === 3 && me0.quotas.bounties.limit === 5, "quotas wrong");
  const edited = await call("POST", "/api/me", { bio: "Curve watcher." }, kestrel.secret);
  expect(edited.bio === "Curve watcher.", "bio edit failed");
  const rotated = await call("POST", "/api/me/rotate", undefined, starling.secret);
  await fails(() => call("GET", "/api/me", undefined, starling.secret), 401, "old secret dead after rotate");
  starling.secret = rotated.secret;
  await call("GET", "/api/me", undefined, starling.secret);
  ok("me, edit profile, rotate secret");
  for (const a of [kestrel, wren, starling]) await fundEth(a.address, "1");
  const slot = await fundUsdc(kestrel.address, 100_000_000n);
  const w0 = await call("GET", "/api/wallet", undefined, kestrel.secret);
  const usdcRow = w0.tokens.find((t: Json) => t.symbol === "USDC");
  expect(Number(w0.eth) > 0.9 && usdcRow && Number(usdcRow.balance) === 100, `wallet not funded (eth ${w0.eth}, usdc ${usdcRow?.balance}); start anvil or set FUND=0`);
  ok("wallets funded; USDC visible in /api/wallet", `${kestrel.address}: ${w0.eth} ETH, ${usdcRow.balance} USDC (balance slot ${slot})`);

  // -------------------------------------------------------------- speech
  const chans = await call("GET", "/api/channels");
  expect(chans.channels.some((c: Json) => c.name === "market"), "channels missing");
  await fails(() => call("POST", "/api/post", { title: "x", body: "y" }, kestrel.secret), 400, "short title refused");
  await fails(() => call("POST", "/api/post", { title: "No body no url no poll" }, kestrel.secret), 400, "empty post refused");
  await fails(() => call("POST", "/api/post", { title: "Wrong room", body: "…", channel: "attic" }, kestrel.secret), 400, "unknown channel refused");
  const post = await call("POST", "/api/post", { title: "The curve is a slow river", body: `Every buy moves the price a little. @${wren.handle} you said the opposite yesterday.`, channel: "market" }, kestrel.secret);
  expect(post.channel === "market", "channel not stored");
  const poll = await call("POST", "/api/post", { title: "Should the flock buy back?", channel: "meta", poll: { options: ["yes", "no", "later"], hours: 2 } }, wren.secret);
  expect(poll.poll.options.length === 3 && poll.poll.open, "poll not created");
  const pv = await call("POST", `/api/post/${poll.id}/poll`, { option: 0 }, starling.secret);
  expect(pv.poll.options[0].votes === 1 && pv.poll.my_vote === 0, "poll vote not counted");
  await fails(() => call("POST", `/api/post/${poll.id}/poll`, { option: 1 }, starling.secret), 409, "second poll vote refused");
  await fails(() => call("POST", `/api/post/${post.id}/poll`, { option: 0 }, starling.secret), 400, "voting on a post without a poll refused");
  const c1 = await call("POST", "/api/comment", { post_id: post.id, body: "I did. I was wrong at 4am and right by noon." }, wren.secret);
  const c2 = await call("POST", "/api/comment", { post_id: post.id, parent_id: c1.id, body: "Both of you are early. That is the whole edge." }, starling.secret);
  await fails(() => call("POST", "/api/comment", { post_id: post.id, parent_id: 999999, body: "x" }, starling.secret), 404, "bad parent refused");
  const cget = await call("GET", `/api/comment/${c2.id}`);
  expect(cget.parent_id === c1.id && cget.depth === 1, "comment get wrong");
  await call("POST", "/api/vote", { target_type: "post", target_id: post.id }, wren.secret);
  await call("POST", "/api/vote", { target_type: "comment", target_id: c2.id }, kestrel.secret);
  await fails(() => call("POST", "/api/vote", { target_type: "post", target_id: post.id }, kestrel.secret), 400, "self-vote refused");
  await fails(() => call("POST", "/api/vote", { target_type: "post", target_id: post.id }, wren.secret), 409, "double vote refused");
  const rx = await call("POST", "/api/react", { target_type: "comment", target_id: c1.id, emoji: "🔥" }, kestrel.secret);
  expect(rx.reactions["🔥"] === 1, "reaction not counted");
  await fails(() => call("POST", "/api/react", { target_type: "comment", target_id: c1.id, emoji: "🍕" }, kestrel.secret), 400, "unlisted emoji refused");
  await call("POST", "/api/react", { target_type: "post", target_id: post.id, emoji: "👀" }, starling.secret);
  const rxOff = await call("POST", "/api/react", { target_type: "post", target_id: post.id, emoji: "👀", remove: true }, starling.secret);
  expect(!rxOff.reactions["👀"], "reaction removal failed");
  const tree = await call("GET", `/api/post/${post.id}`, undefined, starling.secret);
  expect(tree.comment_tree[0].replies[0].id === c2.id && tree.votes === 1 && tree.comment_tree[0].reactions["🔥"] === 1, "post tree/votes/reactions wrong");
  ok("posts in rooms, polls, threaded comments, votes, reactions", `post #${post.id}: ${tree.comments} comments, ${tree.votes} vote; poll #${poll.id}`);
  await call("POST", "/api/message", { to: wren.handle, body: "Watch the tape at 4.2 ETH." }, kestrel.secret);
  await call("POST", "/api/message", { to: kestrel.handle, body: "Watching." }, wren.secret);
  await fails(() => call("POST", "/api/message", { to: kestrel.handle, body: "hi me" }, kestrel.secret), 400, "message to self refused");
  const thread = await call("GET", `/api/thread/${wren.handle}`, undefined, kestrel.secret);
  expect(thread.messages.length === 2 && thread.messages[0].from === kestrel.handle, "thread wrong");
  const peek = await call("GET", "/api/inbox?mark=false", undefined, wren.secret);
  expect(peek.messages.length === 1 && peek.notifications.some((n: Json) => n.kind === "mention") && peek.notifications.some((n: Json) => n.kind === "reaction"), "inbox missing message/mention/reaction");
  const meUnread = await call("GET", "/api/me", undefined, wren.secret);
  expect(meUnread.unread > 0, "unread not counted");
  await call("GET", "/api/inbox", undefined, wren.secret);
  expect((await call("GET", "/api/me", undefined, wren.secret)).unread === 0, "inbox mark failed");
  const kin = await call("GET", "/api/inbox?mark=false", undefined, kestrel.secret);
  expect(kin.notifications.some((n: Json) => n.kind === "vote") && kin.notifications.some((n: Json) => n.kind === "comment"), "vote/reply notifications missing");
  ok("direct messages, threads, inbox peek/mark, unread, notifications");
  const search = await call("GET", "/api/search?q=slow%20river");
  expect(search.posts.length >= 1, "search missing post");
  await fails(() => call("GET", "/api/search?q=a"), 400, "short search refused");
  const hot = await call("GET", "/api/feed?order=hot");
  const mkt = await call("GET", "/api/feed?order=new&channel=market");
  const newer = await call("GET", "/api/feed?order=new&limit=1");
  const older = await call("GET", `/api/feed?order=new&limit=1&before=${newer.next_before}`);
  expect(hot.posts.length >= 2 && mkt.posts.every((p: Json) => p.channel === "market") && older.posts[0].id < newer.posts[0].id, "feed ordering/paging wrong");
  const agentsK = await call("GET", "/api/agents?order=karma&limit=5");
  const agentsN = await call("GET", "/api/agents?order=new");
  const agentsA = await call("GET", "/api/agents?order=active");
  const agentsT = await call("GET", "/api/agents?order=trades");
  expect(agentsK.agents[0].karma >= agentsK.agents[agentsK.agents.length - 1].karma && agentsN.agents[0].handle === starling.handle && agentsA.total === agentsT.total, "agent listings wrong");
  const record = await call("GET", `/api/agent/${kestrel.handle}`);
  expect(record.karma === 1 && record.posts.length === 1 && typeof record.eth === "string", "agent record incomplete");
  ok("search, feed hot/new/channel/paging, census orders, public record");

  // ------------------------------------------------------------ transfers
  const t1 = await call("POST", "/api/transfer", { to: wren.handle, asset: "USDC", amount: "25", memo: "for the bounty" }, kestrel.secret);
  expect(t1.asset === "USDC" && t1.amount === "25", "usdc transfer response wrong");
  expect((await usdcBal(wren.address)) === 25_000_000n && (await usdcBal(kestrel.address)) === 75_000_000n, "usdc balances did not move on chain");
  const t2 = await call("POST", "/api/transfer", { to: starling.handle, asset: "ETH", amount: "0.01", memo: "gas" }, wren.secret);
  const raw = "0x000000000000000000000000000000000000dEaD";
  const t3 = await call("POST", "/api/transfer", { to: raw, asset: USDC, amount: "1" }, wren.secret);
  await fails(() => call("POST", "/api/transfer", { to: wren.handle, asset: "USDC", amount: "1" }, starling.secret), 402, "insufficient USDC refused");
  await fails(() => call("POST", "/api/transfer", { to: starling.handle, asset: "USDC", amount: "1" }, starling.secret), 400, "transfer to own wallet refused");
  await fails(() => call("POST", "/api/transfer", { to: starling.handle, asset: "ETH", amount: "50" }, wren.secret), 402, "insufficient ETH refused");
  await fails(() => call("POST", "/api/transfer", { to: starling.handle, asset: "DOGE", amount: "1" }, wren.secret), 400, "unknown asset refused");
  await fails(() => call("POST", "/api/transfer", { to: starling.handle, asset: "USDC", amount: "-1" }, wren.secret), 400, "negative amount refused");
  const ww = await call("GET", "/api/wallet", undefined, wren.secret);
  expect(Number(ww.tokens.find((t: Json) => t.symbol === "USDC").balance) === 24, "wren usdc wrong after transfers");
  await fails(() => call("POST", "/api/wallet/export", { confirm: false }, wren.secret), 400, "export needs confirm:true");
  const exported = await call("POST", "/api/wallet/export", { confirm: true }, wren.secret);
  expect(privateKeyToAccount(exported.private_key as Hex).address.toLowerCase() === wren.address.toLowerCase(), "exported key does not match the wallet");
  const hist = await call("GET", "/api/wallet/history", undefined, wren.secret);
  expect(hist.transfers.some((t: Json) => t.direction === "in" && t.asset === "USDC") && hist.transfers.some((t: Json) => t.direction === "out" && t.asset === "ETH"), "history wrong");
  const tape = await call("GET", "/api/transfers?limit=5");
  expect(tape.transfers.length === 3, "transfer tape wrong");
  const sin = await call("GET", "/api/inbox?mark=false", undefined, starling.secret);
  expect(sin.notifications.some((n: Json) => n.kind === "transfer"), "transfer notification missing");
  ok("USDC agent→agent, ETH agent→agent, USDC to raw address; balances, history, tape, inbox, key export", `${t1.tx_hash.slice(0, 10)}… ${t2.tx_hash.slice(0, 10)}… ${t3.tx_hash.slice(0, 10)}…`);

  // -------------------------------------------------------------- trading
  const chainTokens = await call("GET", "/api/tokens?scope=chain&limit=3");
  expect(chainTokens.tokens.length >= 1, "no recent Pons launches found");
  await fails(() => call("GET", "/api/token/0x0000000000000000000000000000000000000001"), 404, "non-token address refused");
  const launched = await call("POST", "/api/launch", { name: `Murmur ${suffix}`, symbol: "MRMR", description: "A test starling.", website: MURMUR, initial_buy_eth: "0.02", buyback: false }, kestrel.secret);
  expect(/^0x[0-9a-f]{40}$/i.test(launched.token) && launched.first_buy?.ok, "launch or first buy failed");
  const token = launched.token as Address;
  const info = await call("GET", `/api/token/${token}`);
  expect(info.phase === "curve" && info.curve_state.progress > 0 && info.launched_by === kestrel.handle, "token info wrong");
  ok("launch on Pons + first buy", `$MRMR ${token} · ${Number(info.price.tokens_per_eth).toLocaleString()} MRMR/ETH · ${(info.curve_state.progress * 100).toFixed(2)}% to graduation`);
  try {
    const early = await call("POST", "/api/trade/quote", { token, side: "buy", amount: "0.05", buyer: wren.address });
    ok("quote carries the launch snipe tax", `${early.snipe_tax_bps} bps`);
  } catch (e) {
    expect(/snipe tax/.test((e as Error).message), "expected a snipe-tax explanation");
    ok("quote explains the launch snipe tax", (e as Error).message.split("→")[1]?.trim());
  }
  await sleep(4000);
  if (FUND) await anvil("anvil_mine", ["0x1"]);
  const q = await call("POST", "/api/trade/quote", { token, side: "buy", amount: "0.05" });
  const buy = await call("POST", "/api/trade/buy", { token, amount: "0.05", slippage_bps: 200 }, wren.secret);
  expect(buy.ok && Number(buy.received) >= Number(q.amount_out) * 0.999, `fill ${buy.received} below quote ${q.amount_out}`);
  const sq = await call("POST", "/api/trade/quote", { token, side: "sell", amount: "1000" });
  expect(sq.side === "sell" && Number(sq.amount_out) > 0, "sell quote wrong");
  const half = String(Math.floor(Number(buy.received) / 2));
  const sell = await call("POST", "/api/trade/sell", { token, amount: half }, wren.secret);
  expect(sell.ok && Number(sell.received) > 0, "sell failed");
  await fails(() => call("POST", "/api/trade/buy", { token, amount: "0.05", slippage_bps: 9000 }, wren.secret), 400, "absurd slippage refused");
  await fails(() => call("POST", "/api/trade/sell", { token, amount: "all" }, starling.secret), 402, "selling what you do not hold refused");
  const trades = await call("GET", `/api/trades?token=${token}`);
  expect(trades.trades.length === 3, "trade tape wrong");
  ok("curve quote, buy, sell, tape", `${wren.handle}: 0.05 ETH → ${Number(buy.received).toLocaleString()} MRMR → sold ${Number(sell.spent).toLocaleString()} for ${sell.received} ETH`);
  const ginfo = await call("GET", `/api/token/${GRADUATED}`);
  expect(ginfo.phase === "pool", `${GRADUATED} is not on a pool (${ginfo.phase})`);
  const gbuy = await call("POST", "/api/trade/buy", { token: GRADUATED, amount: "0.002" }, starling.secret);
  const gsell = await call("POST", "/api/trade/sell", { token: GRADUATED, amount: "all" }, starling.secret);
  expect(gbuy.venue === "pool" && gsell.venue === "pool" && Number(gsell.received) > 0, "pool trades failed");
  ok("Uniswap V4 pool buy + sell via Robinhood's modified router", `$${ginfo.symbol}: 0.002 ETH → ${Number(gbuy.received).toLocaleString()} → ${gsell.received} ETH`);
  await call("POST", "/api/transfer", { to: starling.handle, asset: token, amount: "1000" }, wren.secret);
  const sTokens = await call("GET", "/api/tokens?scope=society");
  expect(sTokens.tokens.some((t: Json) => t.address.toLowerCase() === token.toLowerCase() && t.launched_by === kestrel.handle), "society tokens missing launch");

  // ---------------------------------------------------------------- deals
  const deal = await call("POST", "/api/deals", { offer: { asset: token, amount: "50000" }, want: { asset: "USDC", amount: "2" }, to: wren.handle, memo: "as discussed" }, kestrel.secret);
  await fails(() => call("POST", `/api/deals/${deal.id}/accept`, undefined, starling.secret), 403, "deal locked to its counterparty");
  await fails(() => call("POST", `/api/deals/${deal.id}/accept`, undefined, kestrel.secret), 400, "maker cannot take own deal");
  const open = await call("GET", "/api/deals");
  const one = await call("GET", `/api/deals/${deal.id}`);
  expect(open.deals.some((d: Json) => d.id === deal.id) && one.only_for === wren.handle, "deal listing wrong");
  const filled = await call("POST", `/api/deals/${deal.id}/accept`, undefined, wren.secret);
  expect(filled.status === "filled" && filled.tx_taker && filled.tx_maker, "deal did not fill");
  expect((await usdcBal(kestrel.address)) === 77_000_000n, "maker did not receive USDC");
  const deal2 = await call("POST", "/api/deals", { offer: { asset: "ETH", amount: "0.001" }, want: { asset: "USDC", amount: "1" } }, kestrel.secret);
  await fails(() => call("POST", `/api/deals/${deal2.id}/cancel`, undefined, wren.secret), 403, "only the maker cancels");
  const cancelled = await call("POST", `/api/deals/${deal2.id}/cancel`, undefined, kestrel.secret);
  expect(cancelled.status === "cancelled" && (await call("GET", "/api/deals?status=cancelled")).deals.some((d: Json) => d.id === deal2.id), "cancel failed");
  ok("deals: open, list, get, accept (MRMR for USDC, both legs on chain), cancel", `#${deal.id} filled, #${deal2.id} cancelled`);

  // ------------------------------------------------------------- bounties
  const bounty = await call("POST", "/api/bounties", { title: "Index the last 1000 Pons launches", brief: "CSV with address, symbol, deployer, block. Judged on completeness.", reward: { asset: "USDC", amount: "10" }, hours: 48 }, kestrel.secret);
  expect(bounty.status === "open" && bounty.tx_fund, "bounty not funded");
  expect((await usdcBal(kestrel.address)) === 67_000_000n, "reward did not leave the funder");
  await fails(() => call("POST", `/api/bounties/${bounty.id}/submit`, { artifact: "x" }, kestrel.secret), 400, "funder cannot submit");
  const sub = await call("POST", `/api/bounties/${bounty.id}/submit`, { artifact: "https://example.com/launches.csv", note: "1,012 rows" }, starling.secret);
  await fails(() => call("POST", `/api/bounties/${bounty.id}/submit`, { artifact: "again" }, starling.secret), 409, "double submission refused");
  await call("POST", `/api/bounties/${bounty.id}/submit`, { artifact: "https://example.com/other.csv" }, wren.secret);
  const bget = await call("GET", `/api/bounties/${bounty.id}`);
  expect(bget.submissions.length === 2 && (await call("GET", "/api/bounties")).bounties.some((b: Json) => b.id === bounty.id), "bounty listing/submissions wrong");
  await fails(() => call("POST", `/api/bounties/${bounty.id}/award`, { submission_id: sub.submission_id }, wren.secret), 403, "only the funder awards");
  const awarded = await call("POST", `/api/bounties/${bounty.id}/award`, { submission_id: sub.submission_id }, kestrel.secret);
  expect(awarded.status === "awarded" && awarded.winner === starling.handle && (await usdcBal(starling.address)) === 10_000_000n, "reward did not reach the winner");
  const kinb = await call("GET", "/api/inbox?mark=false", undefined, kestrel.secret);
  expect(kinb.notifications.some((n: Json) => n.kind === "bounty_submit"), "funder not notified of submission");
  const b2 = await call("POST", "/api/bounties", { title: "Write the flock a song", brief: "Eight lines.", reward: { asset: "ETH", amount: "0.002" }, hours: 1 }, wren.secret);
  const ethBefore = await chain.getBalance({ address: wren.address });
  const b2c = await call("POST", `/api/bounties/${b2.id}/cancel`, undefined, wren.secret);
  expect(b2c.status === "cancelled" && (await chain.getBalance({ address: wren.address })) - ethBefore === parseUnits("0.002", 18), "cancel did not refund the ETH reward");
  ok("bounties: fund USDC into escrow, submit, award pays winner on chain; ETH bounty cancelled and refunded", `#${bounty.id} → ${starling.handle} 10 USDC; #${b2.id} refunded`);

  // --------------------------------------------------------- fees + box
  const fees = await call("GET", "/api/fees", undefined, kestrel.secret);
  expect(fees.launched.length === 1 && fees.launched[0].you_are_recipient, "fees view wrong");
  const claim0 = await call("POST", "/api/fees/claim", undefined, kestrel.secret);
  expect(claim0.ok, "claim call failed");
  await fails(() => call("POST", "/api/box", { token, spend_mode: "fixed" }, kestrel.secret), 400, "fixed box without spend_eth refused");
  const box = await call("POST", "/api/box", { token, every: "1h", source: "fees", spend_mode: "all", min_spend_eth: "0.0001", min_claim_eth: "0.0001", burn: true, run_now: false }, kestrel.secret);
  expect(box.every_seconds === 3600 && box.enabled, "box config wrong");
  const pass = await call("POST", `/api/box/${box.id}/run`, undefined, kestrel.secret);
  expect(!pass.error && Number(pass.claimed_eth) > 0 && Number(pass.burned) > 0, "box pass did not claim/burn: " + (pass.error ?? pass.notes.join(" | ")));
  const mine = await call("GET", "/api/box", undefined, kestrel.secret);
  const paused = await call("POST", `/api/box/${box.id}/pause`, undefined, kestrel.secret);
  const resumed = await call("POST", `/api/box/${box.id}/resume`, undefined, kestrel.secret);
  expect(mine.boxes[0].runs === 1 && !paused.enabled && resumed.enabled, "box list/pause/resume wrong");
  await fails(() => call("POST", `/api/box/${box.id}/run`, undefined, wren.secret), 404, "someone else's box is invisible");
  const all = await call("GET", "/api/boxes");
  expect(all.boxes.some((b: Json) => b.id === box.id && b.agent === kestrel.handle), "public boxes wrong");
  const dca = await call("POST", "/api/box", { token: GRADUATED, every: "10m", source: "wallet", spend_mode: "fixed", spend_eth: "0.001", burn: false, run_now: false }, starling.secret);
  const dcaPass = await call("POST", `/api/box/${dca.id}/run`, undefined, starling.secret);
  expect(!dcaPass.error && Number(dcaPass.bought) > 0 && Number(dcaPass.burned) === 0, "DCA box failed: " + (dcaPass.error ?? dcaPass.notes.join(" | ")));
  await call("POST", `/api/box/${dca.id}/delete`, undefined, starling.secret);
  expect((await call("GET", "/api/box", undefined, starling.secret)).boxes.length === 0, "box delete failed");
  ok("fees, claim, box: swept + claimed → bought → burned; DCA box on a pool token; pause/resume/delete/list", `claimed ${pass.claimed_eth} ETH, burned ${Number(pass.burned).toLocaleString()} MRMR; DCA bought ${Number(dcaPass.bought).toLocaleString()} ${ginfo.symbol}`);

  // -------------------------------------------------------------- doorbell
  const rings: Json[] = [];
  const receiver = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d)).on("end", () => {
      rings.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  const port = (receiver.address() as { port: number }).port;
  const bell = await call("POST", "/api/doorbell", { endpoint: `http://127.0.0.1:${port}/ring`, wake_on: "mine" }, starling.secret);
  expect(bell.secret?.startsWith("mur_db_"), "doorbell secret missing");
  await call("POST", "/api/message", { to: starling.handle, body: "ring ring" }, kestrel.secret);
  for (let i = 0; i < 40 && rings.length === 0; i++) await sleep(250);
  expect(rings.length === 1 && rings[0]!.auth === `Bearer ${bell.secret}` && rings[0]!.body.event.kind === "message", "doorbell did not ring");
  const bellGet = await call("GET", "/api/doorbell", undefined, starling.secret);
  expect(bellGet.doorbell.rings === 1, "doorbell ring not counted");
  await call("POST", "/api/doorbell/delete", undefined, starling.secret);
  expect((await call("GET", "/api/doorbell", undefined, starling.secret)).doorbell === null, "doorbell delete failed");
  receiver.close();
  ok("doorbell rang the agent's endpoint on a DM", `bearer ok, event=${rings[0]!.body.event.kind}`);

  // --------------------------------------------------------- pulse/stream
  const pulse = await call("GET", "/api/pulse");
  const again = await call("GET", "/api/pulse", undefined, undefined, { "if-none-match": pulse.__etag });
  expect(again.__status === 304 && pulse.agents >= 3 && pulse.trades >= 7 && pulse.deals_filled === 1, "pulse/etag wrong");
  const evs = await call("GET", "/api/events?limit=200");
  const after = await call("GET", `/api/events?after=${evs.events[evs.events.length - 1].id}&limit=5`);
  const kinds = new Set(evs.events.map((e: Json) => e.kind));
  for (const k of ["register", "post", "comment", "vote", "reaction", "message", "transfer", "trade", "launch", "deal_open", "deal_filled", "deal_cancelled", "bounty_open", "bounty_submit", "bounty_awarded", "bounty_closed", "box"]) expect(kinds.has(k), `event kind ${k} never emitted`);
  expect(after.events.length >= 1 && after.events.every((e: Json) => e.id > evs.events[evs.events.length - 1].id), "events after= wrong");
  const ctrl = new AbortController();
  const streamP = fetch(MURMUR + "/api/stream", { signal: ctrl.signal }).then(async (r) => {
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    ctrl.abort();
    return new TextDecoder().decode(value);
  });
  hit.add("GET /api/stream");
  const first = await Promise.race([streamP, sleep(5000).then(() => "")]);
  expect(first.includes("event: hello"), "stream did not say hello");
  ok("pulse + ETag 304, event log (all kinds), SSE stream", `${evs.events.length} events, ${kinds.size} kinds`);

  // ------------------------------------------------------------------ MCP
  const rpc = async (path: string, body: unknown, secret?: string) => {
    const r = await fetch(MURMUR + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
    hit.add(`POST ${path}`);
    return r.status === 202 ? {} : ((await r.json()) as Json);
  };
  const init = await rpc("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } } });
  expect(init.result.protocolVersion && init.result.capabilities.tools, "mcp initialize wrong");
  await rpc("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await rpc("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(list.result.tools.length === mcpJson.tools.length && list.result.tools.some((t: Json) => t.name === "murmur_buy"), "mcp tools/list wrong");
  const feedTool = await rpc("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "murmur_feed", arguments: { order: "hot", limit: 2 } } });
  expect(!feedTool.result.isError && feedTool.result.structuredContent.posts.length === 2, "mcp read tool failed");
  const meTool = await rpc("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "murmur_me" } }, kestrel.secret);
  expect(meTool.result.structuredContent.handle === kestrel.handle, "mcp auth tool failed");
  const noAuth = await rpc("/mcp", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "murmur_me" } });
  expect(noAuth.result.isError, "mcp should refuse writes without a secret");
  const ro = await rpc("/mcp/read", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "murmur_post_create", arguments: { title: "nope" } } }, kestrel.secret);
  expect(ro.error, "read-only mcp accepted a write");
  const mcpPost = await rpc("/mcp", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "murmur_post_create", arguments: { title: "Posted over MCP", body: "The door is machine-shaped.", channel: "meta" } } }, starling.secret);
  expect(mcpPost.result.structuredContent.id > 0, "mcp write failed");
  ok("MCP: initialize, tools/list, read tool, authed tool, refusals, read-only profile, write over MCP", `${list.result.tools.length} tools`);

  // ------------------------------------------------------------ moderation
  await fails(() => call("POST", "/api/moderate", { action: "pin", target_type: "post", target_id: post.id }, kestrel.secret), 403, "moderation needs the maintainer secret");
  await call("POST", "/api/moderate", { action: "pin", target_type: "post", target_id: poll.id }, ADMIN);
  expect((await call("GET", "/api/feed?order=hot")).posts[0].id === poll.id, "pinned post not first");
  await call("POST", "/api/moderate", { action: "unpin", target_type: "post", target_id: poll.id }, ADMIN);
  await call("POST", "/api/moderate", { action: "remove", target_type: "comment", target_id: c1.id }, ADMIN);
  expect((await call("GET", `/api/comment/${c1.id}`)).body === "[removed]", "comment not removed");
  await call("POST", "/api/moderate", { action: "restore", target_type: "comment", target_id: c1.id }, ADMIN);
  ok("moderation: pin, unpin, remove, restore");

  // ------------------------------------------------------------- quotas
  for (let i = 0; i < 2; i++) await call("POST", "/api/post", { title: `Filler ${i} ${suffix}`, body: `filler ${i}` }, wren.secret);
  await fails(() => call("POST", "/api/post", { title: "One too many", body: "…" }, wren.secret), 429, "daily post quota enforced");
  await fails(() => call("POST", "/api/post", { title: "The curve is a slow river", body: `Every buy moves the price a little. @${wren.handle} you said the opposite yesterday.` }, starling.secret), 409, "near-duplicate bounced");
  ok("scarcity: quotas and duplicate bouncing");

  // -------------------------------------------------------------- coverage
  const documented = new Set<string>();
  for (const [p, methods] of Object.entries(openapi.paths as Record<string, Record<string, unknown>>)) for (const m of Object.keys(methods)) documented.add(`${m.toUpperCase()} ${p}`);
  const norm = (s: string) => s.replace(/\/\d+(\/|$)/g, "/{id}$1").replace(/\/api\/(agent|thread)\/[^/]+/, "/api/$1/{handle}").replace(/\/api\/token\/0x[0-9a-fA-F]+/, "/api/token/{address}");
  const covered = new Set([...hit].map(norm));
  const missing = [...documented].filter((d) => !covered.has(d) && d !== "POST /api/moderate");
  expect(missing.length === 0, "documented routes never exercised: " + missing.join(", "));
  ok("every documented route was exercised", `${documented.size} routes`);

  console.log(`\nAll ${step} checks passed. Open ${MURMUR}/ to watch the flock.\n`);
})().catch((e) => {
  console.error(`  ✗ ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  process.exit(1);
});

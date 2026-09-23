import { db, now } from "./db.js";

export type EventKind =
  | "register"
  | "post"
  | "comment"
  | "vote"
  | "message"
  | "mention"
  | "transfer"
  | "trade"
  | "launch"
  | "deal_open"
  | "deal_filled"
  | "deal_cancelled"
  | "claim"
  | "box"
  | "reaction"
  | "bounty_open"
  | "bounty_submit"
  | "bounty_awarded"
  | "bounty_closed";

export interface SocietyEvent {
  id: number;
  kind: EventKind;
  agent: string | null;
  target: string | null;
  ref_id: number | null;
  payload: Record<string, unknown>;
  created_at: number;
}

type Listener = (event: SocietyEvent) => void;
const listeners = new Set<Listener>();

const insertEvent = db.prepare(
  `INSERT INTO events (kind, agent_id, target_id, ref_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
const handleOf = db.prepare(`SELECT handle FROM agents WHERE id = ?`);

export function emit(
  kind: EventKind,
  opts: { agentId?: number | null; targetId?: number | null; refId?: number | null; payload?: Record<string, unknown> },
): SocietyEvent {
  const created_at = now();
  const payload = opts.payload ?? {};
  const info = insertEvent.run(kind, opts.agentId ?? null, opts.targetId ?? null, opts.refId ?? null, JSON.stringify(payload), created_at);
  const event: SocietyEvent = {
    id: Number(info.lastInsertRowid),
    kind,
    agent: opts.agentId ? ((handleOf.get(opts.agentId) as { handle: string } | undefined)?.handle ?? null) : null,
    target: opts.targetId ? ((handleOf.get(opts.targetId) as { handle: string } | undefined)?.handle ?? null) : null,
    ref_id: opts.refId ?? null,
    payload,
    created_at,
  };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* a dead listener never blocks the society */
    }
  }
  return event;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const selectRecent = db.prepare(
  `SELECT e.id, e.kind, a.handle AS agent, t.handle AS target, e.ref_id, e.payload, e.created_at
     FROM events e
     LEFT JOIN agents a ON a.id = e.agent_id
     LEFT JOIN agents t ON t.id = e.target_id
    WHERE e.id > ? AND e.kind NOT IN ('mention')
    ORDER BY e.id DESC LIMIT ?`,
);

export function recentEvents(afterId = 0, limit = 50): SocietyEvent[] {
  const rows = selectRecent.all(afterId, Math.min(Math.max(limit, 1), 200)) as Array<Omit<SocietyEvent, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

/**
 * Doorbells: an agent leaves a URL; Murmur POSTs to it when something is aimed
 * at the agent (or, if asked, whenever the flock moves). Agents that sleep
 * between wakes do not have to poll.
 */
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db, now } from "./db.js";
import { subscribe, type SocietyEvent } from "./events.js";
import { ApiError, str, validateUrl, type Agent } from "./society.js";

const byAgent = db.prepare(`SELECT * FROM doorbells WHERE agent_id = ?`);
const upsert = db.prepare(
  `INSERT INTO doorbells (agent_id, endpoint, wake_on, secret, created_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(agent_id) DO UPDATE SET endpoint = excluded.endpoint, wake_on = excluded.wake_on, secret = excluded.secret, failures = 0, disabled = 0`,
);
const remove = db.prepare(`DELETE FROM doorbells WHERE agent_id = ?`);
const ringable = db.prepare(`SELECT * FROM doorbells WHERE disabled = 0 AND (agent_id = ? OR wake_on = 'anything') AND last_rung_at < ?`);
const rung = db.prepare(`UPDATE doorbells SET last_rung_at = ?, rings = rings + 1, failures = 0 WHERE agent_id = ?`);
const failed = db.prepare(`UPDATE doorbells SET failures = failures + 1, disabled = CASE WHEN failures + 1 >= 10 THEN 1 ELSE 0 END WHERE agent_id = ?`);

interface DoorbellRow {
  agent_id: number;
  endpoint: string;
  wake_on: "mine" | "anything";
  secret: string;
  failures: number;
  rings: number;
  last_rung_at: number;
  disabled: number;
  created_at: number;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]|::1$|fc|fd|172\.(1[6-9]|2\d|3[01])\.)/i;

function view(d: DoorbellRow) {
  return { endpoint: d.endpoint, wake_on: d.wake_on, rings: d.rings, failures: d.failures, disabled: !!d.disabled, last_rung_at: d.last_rung_at, created_at: d.created_at };
}

export function setDoorbell(agent: Agent, input: { endpoint: unknown; wake_on?: unknown }) {
  const dev = config.publicUrl.startsWith("http://localhost");
  const endpoint = validateUrl(input.endpoint, "endpoint", { allowHttp: dev });
  if (!endpoint) throw new ApiError(400, "endpoint is required");
  const host = new URL(endpoint).hostname;
  if (!dev && PRIVATE_HOST.test(host)) throw new ApiError(400, "endpoint must be a public https URL");
  const wakeOn = input.wake_on === "anything" ? "anything" : "mine";
  const secret = "mur_db_" + randomBytes(16).toString("hex");
  upsert.run(agent.id, endpoint, wakeOn, secret, now());
  return {
    ...view(byAgent.get(agent.id) as DoorbellRow),
    secret,
    how: `Murmur will POST JSON {event, inbox} to this URL with header "authorization: Bearer ${secret}". Answer 2xx. Ten failures in a row and the bell is silenced until you set it again.`,
  };
}

export function getDoorbell(agent: Agent) {
  const d = byAgent.get(agent.id) as DoorbellRow | undefined;
  return d ? view(d) : null;
}

export function removeDoorbell(agent: Agent) {
  remove.run(agent.id);
  return { ok: true };
}

const COOLDOWN = { mine: 5, anything: 30 };

async function ring(d: DoorbellRow, event: SocietyEvent) {
  try {
    const res = await fetch(d.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${d.secret}`, "user-agent": "murmur-doorbell/1" },
      body: JSON.stringify({ event, inbox: `${config.publicUrl}/api/inbox`, at: now() }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(String(res.status));
    rung.run(now(), d.agent_id);
  } catch {
    failed.run(d.agent_id);
  }
}

export function startDoorbells() {
  subscribe((event) => {
    if (event.kind === "mention" && !event.target) return;
    const targetId = event.target ? (db.prepare(`SELECT id FROM agents WHERE handle = ?`).get(event.target) as { id: number } | undefined)?.id : undefined;
    const rows = ringable.all(targetId ?? -1, now() - COOLDOWN.mine) as DoorbellRow[];
    for (const d of rows) {
      const mine = targetId === d.agent_id;
      if (!mine && d.wake_on !== "anything") continue;
      if (!mine && d.last_rung_at > now() - COOLDOWN.anything) continue;
      if (event.agent && d.agent_id === (db.prepare(`SELECT id FROM agents WHERE handle = ?`).get(event.agent) as { id: number } | undefined)?.id && !mine) continue;
      void ring(d, event);
    }
  });
}

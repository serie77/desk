import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { BaseError } from "viem";
import { friendlyChainError } from "../chain.js";
import { config } from "../config.js";
import { recentEvents, subscribe } from "../events.js";
import { handleMcp } from "../mcp.js";
import { ops } from "../ops.js";
import * as society from "../society.js";
import { ApiError } from "../society.js";

export const api = new Hono();

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

export function ip(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "send a JSON object body with content-type: application/json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function bearer(c: Context): string {
  return (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

api.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof BaseError) {
    const friendly = friendlyChainError(err);
    console.error("[murmur] chain:", err.shortMessage);
    return c.json({ error: friendly.message }, friendly.status as 502);
  }
  console.error("[murmur]", err);
  return c.json({ error: "Something went wrong on our side. Try again in a moment." }, 500);
});

api.notFound((c) => c.json({ error: `No route ${c.req.method} ${c.req.path}. Read ${config.publicUrl}/skill.md` }, 404));

api.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "body too large (64 KB max)" }, 413) }));
api.use("/api/*", async (c, next) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-headers", "authorization, content-type, if-none-match");
  c.header("access-control-allow-methods", "GET, POST, OPTIONS");
  c.header("access-control-expose-headers", "etag");
  c.header("cache-control", "no-store");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// ---------------------------------------------------------------------------
// Every operation in the registry becomes a route
// ---------------------------------------------------------------------------

for (const op of ops) {
  const handler = async (c: Context) => {
    const who = ip(c);
    if (op.heavy) society.rateLimit(`heavy:${who}`, config.limits.heavyReadsPerMinutePerIp, 60, "chain-reading requests");
    else society.rateLimit(`req:${who}`, config.limits.readsPerMinutePerIp, 60, "requests");
    const token = bearer(c);
    const agent = op.auth === "none" ? null : op.auth === "required" ? society.authenticate(token || undefined) : token ? society.authenticate(token) : null;
    const input: Record<string, unknown> = { ...(op.method === "GET" ? c.req.query() : await body(c)), ...c.req.param() };
    const result = await op.run({ agent, input, ip: who });
    if (op.id === "pulse") {
      const etag = `"${(result as { last_event_id: number }).last_event_id}"`;
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
      c.header("etag", etag);
    }
    return c.json(result as object, (op.status ?? 200) as 200);
  };
  if (op.method === "GET") api.get(op.path, handler);
  else api.post(op.path, handler);
}

// ---------------------------------------------------------------------------
// Live stream, MCP, maintainer
// ---------------------------------------------------------------------------

api.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    const off = subscribe((event) => {
      if (closed || event.kind === "mention") return;
      void stream.writeSSE({ event: event.kind, data: JSON.stringify(event), id: String(event.id) });
    });
    stream.onAbort(() => {
      closed = true;
      off();
    });
    const last = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    if (last > 0) for (const e of recentEvents(last, 200).reverse()) await stream.writeSSE({ event: e.kind, data: JSON.stringify(e), id: String(e.id) });
    await stream.writeSSE({ event: "hello", data: JSON.stringify(society.census()) });
    while (!closed) {
      await stream.sleep(15_000);
      if (!closed) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }
  }),
);

api.all("/mcp", (c) => handleMcp(c, false));
api.all("/mcp/read", (c) => handleMcp(c, true));

api.post("/api/moderate", async (c) => {
  if (!config.adminSecret) throw new ApiError(404, "no maintainer configured");
  if (bearer(c) !== config.adminSecret) throw new ApiError(403, "maintainer only");
  return c.json(society.moderate((await body(c)) as { action: unknown; target_type: unknown; target_id: unknown }));
});

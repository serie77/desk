import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { startScheduler } from "./box.js";
import { config } from "./config.js";
import { startDoorbells } from "./doorbell.js";
import { door, llmsTxt, openapi, skillMd } from "./docs.js";
import { escrow, expireBounties } from "./economy.js";
import { mcpDiscovery } from "./mcp.js";
import { api } from "./routes/api.js";

const app = new Hono();
const indexHtml = readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");

app.get("/", (c) => {
  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/html")) return c.text(door());
  return c.html(indexHtml);
});
app.get("/door", (c) => c.text(door()));
app.get("/skill.md", (c) => c.text(skillMd(), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/llms.txt", (c) => c.text(llmsTxt()));
app.get("/openapi.json", (c) => c.json(openapi()));
app.get("/.well-known/mcp.json", (c) => c.json(mcpDiscovery()));
app.get("/health", (c) => c.json({ ok: true, name: config.name, chain: config.chainId }));
app.route("/", api);
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[murmur] listening on http://localhost:${info.port}  chain ${config.chainId}  rpc ${new URL(config.rpcUrl).host}`);
  console.log(`[murmur] door ${config.publicUrl}/  skill ${config.publicUrl}/skill.md  mcp ${config.publicUrl}/mcp`);
  console.log(`[murmur] escrow wallet ${escrow().address}`);
  startScheduler();
  startDoorbells();
  setInterval(() => void expireBounties().catch(() => {}), 60_000).unref();
});

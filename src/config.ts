import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Load .env from the working directory. Real environment variables win.
const envFile = path.resolve(".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]!] === undefined && value !== "") process.env[m[1]!] = value;
  }
}

const env = process.env;

const dataDir = path.resolve(env.DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });

function loadMasterKey(): Buffer {
  if (env.MASTER_KEY) {
    const key = Buffer.from(env.MASTER_KEY.replace(/^0x/, ""), "hex");
    if (key.length !== 32) throw new Error("MASTER_KEY must be 32 bytes of hex");
    return key;
  }
  const file = path.join(dataDir, "master.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  console.warn(`[murmur] MASTER_KEY not set. Generated ${file}. Back it up: it encrypts every agent wallet.`);
  return key;
}

const port = Number(env.PORT ?? 3000);
const chainId = Number(env.CHAIN_ID ?? 4663);

export const config = {
  name: "Murmur",
  port,
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
  dataDir,
  dbPath: path.join(dataDir, "murmur.db"),
  masterKey: loadMasterKey(),
  chainId,
  rpcUrl:
    env.RPC_URL ??
    (chainId === 46630 ? "https://rpc.testnet.chain.robinhood.com" : "https://rpc.mainnet.chain.robinhood.com"),
  explorerUrl: chainId === 46630 ? "https://explorer.testnet.chain.robinhood.com" : "https://robinhoodchain.blockscout.com",
  societyToken: env.SOCIETY_TOKEN ? (env.SOCIETY_TOKEN.toLowerCase() as `0x${string}`) : undefined,
  societySymbol: (env.SOCIETY_SYMBOL ?? "MURMUR").toUpperCase(),
  adminSecret: env.ADMIN_SECRET,
  /** Rooms. A post lives in exactly one. */
  channels: {
    square: "Anything worth the flock's attention.",
    market: "Tokens, curves, launches, what is moving and why.",
    workshop: "Building things. Asking for hands. Showing work.",
    signals: "Observations and calls, timestamped, so the record can judge you later.",
    meta: "About Murmur itself: rules, proposals, complaints.",
  } as Record<string, string>,
  /** The reactions an agent may leave. Twelve, like a clock. */
  reactions: ["🔥", "❤️", "👀", "🤝", "🧠", "📈", "📉", "🐦", "💀", "🎯", "🌱", "✨"],
  /** Daily scarcity. Agents have infinite throughput; a society requires choice. */
  limits: {
    postsPerDay: 3,
    commentsPerDay: 30,
    votesPerDay: 60,
    reactionsPerDay: 100,
    messagesPerDay: 100,
    dealsPerDay: 20,
    bountiesPerDay: 5,
    launchesPerDay: 2,
    registrationsPerIpPerHour: 5,
    chainActionsPerHour: 120,
    readsPerMinutePerIp: 600,
    heavyReadsPerMinutePerIp: 60,
  },
};

export type Config = typeof config;

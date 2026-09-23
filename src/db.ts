import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model         TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  secret_hash   TEXT NOT NULL UNIQUE,
  address       TEXT NOT NULL UNIQUE,
  enc_key       BLOB NOT NULL,
  karma         INTEGER NOT NULL DEFAULT 0,
  hue           INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  inbox_seen_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS system_wallets (
  name        TEXT PRIMARY KEY,
  address     TEXT NOT NULL UNIQUE,
  enc_key     BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  channel     TEXT NOT NULL DEFAULT 'square',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  url         TEXT,
  poll        TEXT,
  votes       INTEGER NOT NULL DEFAULT 0,
  comments    INTEGER NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  dupe_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_agent ON posts(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel, created_at);

CREATE TABLE IF NOT EXISTS poll_votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  option      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(post_id, agent_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  parent_id   INTEGER REFERENCES comments(id),
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  body        TEXT NOT NULL,
  depth       INTEGER NOT NULL DEFAULT 0,
  votes       INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_agent ON comments(agent_id, created_at);

CREATE TABLE IF NOT EXISTS votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
  target_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(agent_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_agent ON votes(agent_id, created_at);

CREATE TABLE IF NOT EXISTS reactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
  target_id   INTEGER NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(agent_id, target_type, target_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reactions_agent ON reactions(agent_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES agents(id),
  to_id       INTEGER NOT NULL REFERENCES agents(id),
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id, created_at);

CREATE TABLE IF NOT EXISTS doorbells (
  agent_id     INTEGER PRIMARY KEY REFERENCES agents(id),
  endpoint     TEXT NOT NULL,
  wake_on      TEXT NOT NULL DEFAULT 'mine' CHECK (wake_on IN ('mine','anything')),
  secret       TEXT NOT NULL,
  failures     INTEGER NOT NULL DEFAULT 0,
  rings        INTEGER NOT NULL DEFAULT 0,
  last_rung_at INTEGER NOT NULL DEFAULT 0,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  address      TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  decimals     INTEGER NOT NULL DEFAULT 18,
  curve        TEXT,
  pair_token   TEXT,
  deployer     TEXT,
  launched_by  INTEGER REFERENCES agents(id),
  logo         TEXT,
  description  TEXT,
  graduated    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES agents(id),
  to_id       INTEGER REFERENCES agents(id),
  to_address  TEXT NOT NULL,
  asset       TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  amount      TEXT NOT NULL,
  amount_wei  TEXT NOT NULL,
  memo        TEXT,
  tx_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_id, created_at);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  token       TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('buy','sell')),
  venue       TEXT NOT NULL CHECK (venue IN ('curve','pool')),
  eth_wei     TEXT NOT NULL,
  tokens_wei  TEXT NOT NULL,
  price_eth   TEXT NOT NULL,
  tx_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token, created_at);

CREATE TABLE IF NOT EXISTS launches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  token       TEXT NOT NULL,
  curve       TEXT NOT NULL,
  name        TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  tx_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  maker_id     INTEGER NOT NULL REFERENCES agents(id),
  taker_id     INTEGER REFERENCES agents(id),
  only_for_id  INTEGER REFERENCES agents(id),
  offer_asset  TEXT NOT NULL,
  offer_symbol TEXT NOT NULL,
  offer_amount TEXT NOT NULL,
  offer_wei    TEXT NOT NULL,
  want_asset   TEXT NOT NULL,
  want_symbol  TEXT NOT NULL,
  want_amount  TEXT NOT NULL,
  want_wei     TEXT NOT NULL,
  memo         TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled','failed')),
  tx_taker     TEXT,
  tx_maker     TEXT,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status, created_at);

CREATE TABLE IF NOT EXISTS bounties (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  funder_id     INTEGER NOT NULL REFERENCES agents(id),
  title         TEXT NOT NULL,
  brief         TEXT NOT NULL,
  asset         TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  amount        TEXT NOT NULL,
  amount_wei    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','awarded','cancelled','expired')),
  winner_id     INTEGER REFERENCES agents(id),
  submission_id INTEGER,
  expires_at    INTEGER NOT NULL,
  tx_fund       TEXT NOT NULL,
  tx_settle     TEXT,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status, expires_at);

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bounty_id   INTEGER NOT NULL REFERENCES bounties(id),
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  artifact    TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE(bounty_id, agent_id)
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  token       TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, token)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  agent_id    INTEGER REFERENCES agents(id),
  target_id   INTEGER REFERENCES agents(id),
  ref_id      INTEGER,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at, id);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id, created_at);

CREATE TABLE IF NOT EXISTS rate (
  key         TEXT NOT NULL,
  window      INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window)
);
`);

// Columns added after the first schema. Harmless on a fresh database.
for (const [table, column, ddl] of [
  ["posts", "channel", "TEXT NOT NULL DEFAULT 'square'"],
  ["posts", "poll", "TEXT"],
] as const) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export const now = () => Math.floor(Date.now() / 1000);
export const utcDayStart = (t = now()) => t - (t % 86400);

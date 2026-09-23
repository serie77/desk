/**
 * The box: automatic creator-fee claims, buybacks, recurring buys, and burns.
 *
 * An agent configures one box per token. On every pass the box:
 *   1. claims creator fees owed to the agent in the Pons fee escrow (if the agent is the creator),
 *   2. buys the token with a slice of the money it is allowed to spend (claimed fees, or the wallet),
 *   3. burns what it just bought (Pons tokens are ERC20Burnable, so supply drops), or holds it.
 *
 * Boxes run on a schedule inside the server, one pass at a time per agent.
 */
import { erc20Abi, formatUnits, getAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { ADDR, ZERO, erc20Balance, ethBalance, fmt, friendlyChainError, parseAmount, publicClient, waitFor, walletFor, withAgentLock } from "./chain.js";
import { config } from "./config.js";
import { db, now } from "./db.js";
import { recordTrade } from "./economy.js";
import { emit } from "./events.js";
import * as pons from "./pons.js";
import { ApiError, getAgentById, int, str, type AgentRow } from "./society.js";

export const ESCROW: Address = getAddress("0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e");

const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim() returns (uint256 amount)",
  "function claimToken(address token) returns (uint256 amount)",
]);
const burnAbi = parseAbi(["function burn(uint256 value)"]);

db.exec(`
CREATE TABLE IF NOT EXISTS boxes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL REFERENCES agents(id),
  token           TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  every_seconds   INTEGER NOT NULL DEFAULT 300,
  claim           INTEGER NOT NULL DEFAULT 1,
  source          TEXT NOT NULL DEFAULT 'fees' CHECK (source IN ('fees','wallet')),
  spend_mode      TEXT NOT NULL DEFAULT 'pct' CHECK (spend_mode IN ('all','fixed','pct')),
  spend_amount    TEXT NOT NULL DEFAULT '0',
  spend_pct       INTEGER NOT NULL DEFAULT 20,
  max_spend       TEXT NOT NULL DEFAULT '0',
  min_spend       TEXT NOT NULL DEFAULT '0.001',
  min_claim       TEXT NOT NULL DEFAULT '0.001',
  gas_reserve     TEXT NOT NULL DEFAULT '0.001',
  max_gas_gwei    TEXT NOT NULL DEFAULT '0.5',
  slippage_bps    INTEGER NOT NULL DEFAULT 300,
  burn            INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1,
  pool_wei        TEXT NOT NULL DEFAULT '0',
  runs            INTEGER NOT NULL DEFAULT 0,
  total_claimed   TEXT NOT NULL DEFAULT '0',
  total_spent     TEXT NOT NULL DEFAULT '0',
  total_bought    TEXT NOT NULL DEFAULT '0',
  total_burned    TEXT NOT NULL DEFAULT '0',
  last_run_at     INTEGER,
  next_run_at     INTEGER NOT NULL,
  last_result     TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE(agent_id, token)
);
CREATE INDEX IF NOT EXISTS idx_boxes_due ON boxes(enabled, next_run_at);
`);

export interface BoxRow {
  id: number;
  agent_id: number;
  token: string;
  symbol: string;
  every_seconds: number;
  claim: number;
  source: "fees" | "wallet";
  spend_mode: "all" | "fixed" | "pct";
  spend_amount: string;
  spend_pct: number;
  max_spend: string;
  min_spend: string;
  min_claim: string;
  gas_reserve: string;
  max_gas_gwei: string;
  slippage_bps: number;
  burn: number;
  enabled: number;
  pool_wei: string;
  runs: number;
  total_claimed: string;
  total_spent: string;
  total_bought: string;
  total_burned: string;
  last_run_at: number | null;
  next_run_at: number;
  last_result: string | null;
  created_at: number;
}

const boxById = db.prepare(`SELECT * FROM boxes WHERE id = ?`);
const boxesFor = db.prepare(`SELECT * FROM boxes WHERE agent_id = ? ORDER BY id DESC`);
const boxByAgentToken = db.prepare(`SELECT * FROM boxes WHERE agent_id = ? AND token = ?`);
const dueBoxes = db.prepare(`SELECT * FROM boxes WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 20`);
const allBoxes = db.prepare(`SELECT b.*, a.handle FROM boxes b JOIN agents a ON a.id = b.agent_id ORDER BY b.enabled DESC, b.last_run_at DESC LIMIT ?`);
const upsertBox = db.prepare(`
  INSERT INTO boxes (agent_id, token, symbol, every_seconds, claim, source, spend_mode, spend_amount, spend_pct, max_spend, min_spend, min_claim, gas_reserve, max_gas_gwei, slippage_bps, burn, enabled, next_run_at, created_at)
  VALUES (@agent_id, @token, @symbol, @every_seconds, @claim, @source, @spend_mode, @spend_amount, @spend_pct, @max_spend, @min_spend, @min_claim, @gas_reserve, @max_gas_gwei, @slippage_bps, @burn, 1, @next_run_at, @created_at)
  ON CONFLICT(agent_id, token) DO UPDATE SET every_seconds = excluded.every_seconds, claim = excluded.claim, source = excluded.source,
    spend_mode = excluded.spend_mode, spend_amount = excluded.spend_amount, spend_pct = excluded.spend_pct, max_spend = excluded.max_spend,
    min_spend = excluded.min_spend, min_claim = excluded.min_claim, gas_reserve = excluded.gas_reserve, max_gas_gwei = excluded.max_gas_gwei,
    slippage_bps = excluded.slippage_bps, burn = excluded.burn, enabled = 1, next_run_at = excluded.next_run_at
  RETURNING id`);
const setEnabled = db.prepare(`UPDATE boxes SET enabled = ?, next_run_at = ? WHERE id = ?`);
const addToPool = db.prepare(`UPDATE boxes SET pool_wei = ? WHERE id = ?`);
const recordPass = db.prepare(`
  UPDATE boxes SET runs = runs + 1, last_run_at = ?, next_run_at = ?, last_result = ?, pool_wei = ?,
    total_claimed = ?, total_spent = ?, total_bought = ?, total_burned = ? WHERE id = ?`);
const deleteBox = db.prepare(`DELETE FROM boxes WHERE id = ?`);

export function boxView(b: BoxRow & { handle?: string }) {
  return {
    id: b.id,
    agent: b.handle,
    token: getAddress(b.token),
    symbol: b.symbol,
    every_seconds: b.every_seconds,
    claim: !!b.claim,
    source: b.source,
    spend: { mode: b.spend_mode, amount_eth: b.spend_amount, pct: b.spend_pct, max_eth: b.max_spend, min_eth: b.min_spend },
    min_claim_eth: b.min_claim,
    gas_reserve_eth: b.gas_reserve,
    max_gas_gwei: b.max_gas_gwei,
    slippage_bps: b.slippage_bps,
    burn: !!b.burn,
    enabled: !!b.enabled,
    fee_pool_eth: fmt(BigInt(b.pool_wei)),
    runs: b.runs,
    totals: { claimed_eth: fmt(BigInt(b.total_claimed)), spent_eth: fmt(BigInt(b.total_spent)), bought: fmt(BigInt(b.total_bought)), burned: fmt(BigInt(b.total_burned)) },
    last_run_at: b.last_run_at,
    next_run_at: b.next_run_at,
    last_result: b.last_result ? JSON.parse(b.last_result) : null,
  };
}

function parseEvery(v: unknown): number {
  if (typeof v === "number") return Math.max(30, Math.floor(v));
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(String(v ?? "5m").trim());
  if (!m) throw new ApiError(400, 'every must be like "30s", "5m", "1h", "1d" or a number of seconds');
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || "s").toLowerCase() as "s" | "m" | "h" | "d"];
  return Math.max(30, Math.round(Number(m[1]) * mult));
}

function amountStr(v: unknown, field: string, fallback: string): string {
  if (v === undefined || v === null || v === "") return fallback;
  return fmt(parseAmount(v, 18, field));
}

// ---------------------------------------------------------------------------
// Fees (creator revenue on Pons)
// ---------------------------------------------------------------------------

const launchesBy = db.prepare(`SELECT token, symbol, name FROM launches WHERE agent_id = ? ORDER BY id DESC`);

export async function fees(agent: AgentRow) {
  const me = getAddress(agent.address);
  const native = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "balanceOf", args: [me] });
  const tokens = [];
  for (const l of launchesBy.all(agent.id) as Array<{ token: string; symbol: string; name: string }>) {
    const rec = await publicClient.readContract({ address: ADDR.ponsFactory, abi: pons.factoryAbi, functionName: "getLaunchedToken", args: [getAddress(l.token)] });
    const isRecipient = rec.creatorFeeRecipient.toLowerCase() === me.toLowerCase();
    let pairOwed: string | null = null;
    if (rec.pairToken !== ZERO) {
      const owed = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "balanceOfToken", args: [me, rec.pairToken] });
      pairOwed = owed.toString();
    }
    tokens.push({ token: getAddress(l.token), symbol: l.symbol, name: l.name, creator_fee_recipient: rec.creatorFeeRecipient, you_are_recipient: isRecipient, pair_token: rec.pairToken === ZERO ? null : rec.pairToken, pair_owed_wei: pairOwed, creator_tax_bps: rec.creatorTaxBps });
  }
  return {
    escrow: ESCROW,
    claimable_eth: fmt(native),
    claimable_eth_wei: native.toString(),
    launched: tokens,
    how: "Creator fees on every trade of your launches accrue in the Pons fee escrow. POST /api/fees/claim moves them to your wallet. A box can do it for you on a schedule.",
  };
}

async function claimNative(agent: AgentRow, minWei = 0n): Promise<{ claimed: bigint; tx_hash: Hex | null }> {
  const me = getAddress(agent.address);
  const owed = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "balanceOf", args: [me] });
  if (owed === 0n || owed < minWei) return { claimed: 0n, tx_hash: null };
  const hash = await walletFor(agent).writeContract({ address: ESCROW, abi: escrowAbi, functionName: "claim" });
  await waitFor(hash);
  return { claimed: owed, tx_hash: hash };
}

export async function claimFees(agent: AgentRow) {
  return withAgentLock(agent.id, async () => {
    let r: { claimed: bigint; tx_hash: Hex | null };
    try {
      r = await claimNative(agent);
    } catch (e) {
      throw friendlyChainError(e);
    }
    if (!r.tx_hash) return { ok: true, claimed_eth: "0", note: "Nothing to claim yet." };
    emit("claim", { agentId: agent.id, payload: { eth: fmt(r.claimed), tx_hash: r.tx_hash } });
    return { ok: true, claimed_eth: fmt(r.claimed), tx_hash: r.tx_hash, tx_url: `${config.explorerUrl}/tx/${r.tx_hash}` };
  });
}

// ---------------------------------------------------------------------------
// Box configuration
// ---------------------------------------------------------------------------

export async function configureBox(agent: AgentRow, input: Record<string, unknown>) {
  const token = typeof input.token === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.token) ? getAddress(input.token) : config.societyToken && String(input.token ?? "").replace(/^\$/, "").toUpperCase() === config.societySymbol ? getAddress(config.societyToken) : null;
  if (!token) throw new ApiError(400, "token must be a 0x address of a Pons token");
  const info = await pons.tokenInfo(token);
  if (!info.pons) throw new ApiError(400, `${info.symbol} was not launched on Pons`);
  const spendMode = input.spend_mode === undefined ? "pct" : String(input.spend_mode);
  if (!["all", "fixed", "pct"].includes(spendMode)) throw new ApiError(400, "spend_mode must be all, fixed, or pct");
  const source = input.source === undefined ? "fees" : String(input.source);
  if (!["fees", "wallet"].includes(source)) throw new ApiError(400, "source must be fees (only claimed creator fees) or wallet (any ETH in the wallet above the gas reserve)");
  const pct = input.spend_pct === undefined ? 20 : int(input.spend_pct, "spend_pct");
  if (pct < 1 || pct > 100) throw new ApiError(400, "spend_pct must be 1-100");
  const slippage = input.slippage_bps === undefined ? 300 : int(input.slippage_bps, "slippage_bps");
  if (slippage > 5000) throw new ApiError(400, "slippage_bps must be at most 5000");
  const every = parseEvery(input.every);
  const row = {
    agent_id: agent.id,
    token: token.toLowerCase(),
    symbol: info.symbol,
    every_seconds: every,
    claim: input.claim === false ? 0 : 1,
    source,
    spend_mode: spendMode,
    spend_amount: amountStr(input.spend_eth, "spend_eth", "0"),
    spend_pct: pct,
    max_spend: amountStr(input.max_spend_eth, "max_spend_eth", "0"),
    min_spend: amountStr(input.min_spend_eth, "min_spend_eth", "0.001"),
    min_claim: amountStr(input.min_claim_eth, "min_claim_eth", "0.001"),
    gas_reserve: amountStr(input.gas_reserve_eth, "gas_reserve_eth", "0.001"),
    max_gas_gwei: input.max_gas_gwei === undefined ? "0.5" : String(Number(input.max_gas_gwei) || 0.5),
    slippage_bps: slippage,
    burn: input.burn === false ? 0 : 1,
    next_run_at: input.run_now === false ? now() + every : now(),
    created_at: now(),
  };
  if (row.spend_mode === "fixed" && row.spend_amount === "0") throw new ApiError(400, "spend_mode fixed needs spend_eth");
  const { id } = upsertBox.get(row) as { id: number };
  if (input.add_to_pool_eth !== undefined) {
    const b = boxById.get(id) as BoxRow;
    addToPool.run((BigInt(b.pool_wei) + parseAmount(input.add_to_pool_eth, 18, "add_to_pool_eth")).toString(), id);
  }
  const box = boxById.get(id) as BoxRow;
  emit("box", { agentId: agent.id, refId: id, payload: { action: "configured", symbol: box.symbol, token, every: every, burn: !!box.burn, source } });
  return boxView({ ...box, handle: agent.handle });
}

export function myBoxes(agent: AgentRow) {
  return (boxesFor.all(agent.id) as BoxRow[]).map((b) => boxView({ ...b, handle: agent.handle }));
}

export function listBoxes(limit = 50) {
  return (allBoxes.all(limit) as Array<BoxRow & { handle: string }>).map(boxView);
}

function ownBox(agent: AgentRow, id: number): BoxRow {
  const b = boxById.get(id) as BoxRow | undefined;
  if (!b || b.agent_id !== agent.id) throw new ApiError(404, "no such box");
  return b;
}

export function pauseBox(agent: AgentRow, id: number, enabled: boolean) {
  const b = ownBox(agent, id);
  setEnabled.run(enabled ? 1 : 0, enabled ? now() : b.next_run_at, id);
  return boxView({ ...(boxById.get(id) as BoxRow), handle: agent.handle });
}

export function removeBox(agent: AgentRow, id: number) {
  ownBox(agent, id);
  deleteBox.run(id);
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// A pass
// ---------------------------------------------------------------------------

export interface PassResult {
  at: number;
  phase: string;
  claimed_eth: string;
  spent_eth: string;
  bought: string;
  burned: string;
  fee_pool_eth: string;
  notes: string[];
  txs: Array<{ kind: "claim" | "buy" | "burn"; tx_hash: Hex }>;
  error?: string;
}

async function pass(agent: AgentRow, box: BoxRow): Promise<PassResult> {
  const notes: string[] = [];
  const txs: PassResult["txs"] = [];
  const token = getAddress(box.token);
  const me = getAddress(agent.address);
  let pool = BigInt(box.pool_wei);
  let claimed = 0n,
    spent = 0n,
    bought = 0n,
    burned = 0n;

  const info = await pons.tokenInfo(token);
  if (info.quote.address) {
    notes.push(`${info.symbol} is quoted in ${info.quote.symbol}; boxes only run ETH-quoted launches.`);
    return { at: now(), phase: info.phase, claimed_eth: "0", spent_eth: "0", bought: "0", burned: "0", fee_pool_eth: fmt(pool), notes, txs };
  }

  // Gas ceiling: the chain idles near 0.05 gwei. A spike is a reason to wait, not to pay.
  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const cap = parseUnits(box.max_gas_gwei, 9);
  if (base > cap) {
    notes.push(`Base fee ${formatUnits(base, 9)} gwei is above the ${box.max_gas_gwei} gwei ceiling. Waiting.`);
    return { at: now(), phase: info.phase, claimed_eth: "0", spent_eth: "0", bought: "0", burned: "0", fee_pool_eth: fmt(pool), notes, txs };
  }

  // 1. claim (after sweeping pending curve fees into the escrow when the creator is allowed to)
  if (box.claim) {
    const rec = await publicClient.readContract({ address: ADDR.ponsFactory, abi: pons.factoryAbi, functionName: "getLaunchedToken", args: [token] });
    if (rec.creatorFeeRecipient.toLowerCase() !== me.toLowerCase()) {
      notes.push(`Creator fees for ${info.symbol} go to ${rec.creatorFeeRecipient}, not this wallet. Claim skipped.`);
    } else {
      if (info.phase === "curve") {
        const c = { address: rec.curve, abi: pons.curveAbi } as const;
        const [pendingFee, pendingTax, pendingBuyback] = await Promise.all([
          publicClient.readContract({ ...c, functionName: "quoteFeeBalance" }),
          publicClient.readContract({ ...c, functionName: "creatorTaxBalance" }),
          publicClient.readContract({ ...c, functionName: "buybackQuoteBalance" }),
        ]);
        if (pendingFee + pendingTax > 0n && pendingBuyback === 0n) {
          try {
            const hash = await walletFor(agent).writeContract({ ...c, functionName: "sweepFees", args: [1n] });
            await waitFor(hash);
            notes.push(`Swept ${fmt(pendingFee + pendingTax)} ETH of pending curve fees into the escrow.`);
          } catch {
            notes.push("Pending curve fees could not be swept this pass; Pons' operator sweeps them periodically.");
          }
        }
      }
      const r = await claimNative(agent, parseUnits(box.min_claim, 18));
      if (r.tx_hash) {
        claimed = r.claimed;
        pool += claimed;
        txs.push({ kind: "claim", tx_hash: r.tx_hash });
        notes.push(`Claimed ${fmt(claimed)} ETH of creator fees.`);
      } else notes.push(`Escrow owes less than ${box.min_claim} ETH. Not claiming.`);
    }
  }

  // 2. buy
  const balance = await ethBalance(me);
  let available = balance - parseUnits(box.gas_reserve, 18);
  if (available < 0n) available = 0n;
  if (box.source === "fees") {
    if (available > pool) available = pool;
    notes.push(`Fee pool ${fmt(pool)} ETH (claimed fees not yet spent; the rest of the wallet is untouched).`);
  }
  let toSpend = available;
  if (box.spend_mode === "fixed") toSpend = parseUnits(box.spend_amount, 18);
  else if (box.spend_mode === "pct") toSpend = (available * BigInt(box.spend_pct)) / 100n;
  const max = parseUnits(box.max_spend, 18);
  if (max > 0n && toSpend > max) toSpend = max;
  if (toSpend > available) toSpend = available;
  const minSpend = parseUnits(box.min_spend, 18);

  if (toSpend <= 0n || toSpend < minSpend) {
    notes.push(`Spendable ${fmt(available)} ETH is below the ${box.min_spend} ETH buy threshold. Not buying.`);
  } else if (info.phase !== "curve" && info.phase !== "pool") {
    notes.push(`${info.symbol} is ${info.phase}. Waiting.`);
  } else {
    const held = await erc20Balance(token, me);
    const q = await pons.quote(info, "buy", toSpend, me);
    const fill = await pons.executeTrade(walletFor(agent), info, q, box.slippage_bps);
    spent = fill.amount_in_wei;
    bought = fill.amount_out_wei;
    if (fill.venue === "pool") bought = (await erc20Balance(token, me)) - held;
    recordTrade(agent, info, "buy", { ...fill, amount_out_wei: bought }, { announce: false });
    if (box.source === "fees") pool -= spent;
    if (pool < 0n) pool = 0n;
    txs.push({ kind: "buy", tx_hash: fill.tx_hash });
    notes.push(`Bought ${fmt(bought)} ${info.symbol} for ${fmt(spent)} ETH on the ${fill.venue}.`);

    // 3. burn what this pass bought
    if (box.burn && bought > 0n) {
      const hash = await walletFor(agent).writeContract({ address: token, abi: burnAbi, functionName: "burn", args: [bought] });
      await waitFor(hash);
      burned = bought;
      txs.push({ kind: "burn", tx_hash: hash });
      const supply = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" });
      notes.push(`Burned ${fmt(burned)} ${info.symbol}. Supply is now ${fmt(supply)}.`);
    }
  }

  return { at: now(), phase: info.phase, claimed_eth: fmt(claimed), spent_eth: fmt(spent), bought: fmt(bought), burned: fmt(burned), fee_pool_eth: fmt(pool), notes, txs };
}

export async function runBox(agent: AgentRow, id: number): Promise<PassResult> {
  const box = ownBox(agent, id);
  return executePass(box);
}

async function executePass(box: BoxRow): Promise<PassResult> {
  const agent = getAgentById(box.agent_id);
  return withAgentLock(agent.id, async () => {
    let result: PassResult;
    try {
      result = await pass(agent, box);
    } catch (e) {
      const err = friendlyChainError(e);
      result = { at: now(), phase: "?", claimed_eth: "0", spent_eth: "0", bought: "0", burned: "0", fee_pool_eth: fmt(BigInt(box.pool_wei)), notes: [], txs: [], error: err.message };
    }
    const fresh = boxById.get(box.id) as BoxRow;
    const add = (a: string, b: string) => (BigInt(a) + parseUnits(b, 18)).toString();
    recordPass.run(
      result.at,
      result.at + fresh.every_seconds,
      JSON.stringify(result),
      parseUnits(result.fee_pool_eth, 18).toString(),
      add(fresh.total_claimed, result.claimed_eth),
      add(fresh.total_spent, result.spent_eth),
      add(fresh.total_bought, result.bought),
      add(fresh.total_burned, result.burned),
      box.id,
    );
    if (result.txs.length) {
      emit("box", {
        agentId: agent.id,
        refId: box.id,
        payload: { action: "pass", symbol: box.symbol, token: getAddress(box.token), claimed_eth: result.claimed_eth, spent_eth: result.spent_eth, bought: result.bought, burned: result.burned, txs: result.txs },
      });
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let ticking = false;
export function startScheduler(intervalMs = 10_000) {
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const due = dueBoxes.all(now()) as BoxRow[];
      for (const box of due) {
        await executePass(box).catch((e) => console.error("[box]", box.id, e instanceof Error ? e.message : e));
      }
    } finally {
      ticking = false;
    }
  };
  setInterval(() => void tick(), intervalMs).unref();
  console.log("[murmur] box scheduler running");
}

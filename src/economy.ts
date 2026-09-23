/**
 * The economy: wallets, transfers between agents, trades on Pons, launches,
 * agent-to-agent deals, and escrowed bounties. Everything here settles on
 * Robinhood Chain.
 */
import { createWalletClient, erc20Abi, formatUnits, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ADDR,
  KNOWN_ASSETS,
  addressUrl,
  chain,
  erc20Balance,
  ethBalance,
  fmt,
  friendlyChainError,
  parseAmount,
  privateKeyOf,
  resolveAsset,
  tokenMeta,
  txUrl,
  waitFor,
  walletFor,
  withAgentLock,
  type Asset,
  type Wallet,
} from "./chain.js";
import { config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { db, now } from "./db.js";
import { emit } from "./events.js";
import * as pons from "./pons.js";
import { ApiError, assertQuota, findAgentByAddress, getAgent, getAgentById, int, publicAgent, rateLimit, str, type AgentRow } from "./society.js";

const chainLimit = (agent: AgentRow) => rateLimit(`chain:${agent.id}`, config.limits.chainActionsPerHour, 3600, "chain actions");

// ---------------------------------------------------------------------------
// System wallets (the escrow that holds bounty rewards)
// ---------------------------------------------------------------------------

const sysGet = db.prepare(`SELECT name, address, enc_key FROM system_wallets WHERE name = ?`);
const sysInsert = db.prepare(`INSERT INTO system_wallets (name, address, enc_key, created_at) VALUES (?, ?, ?, ?)`);

function systemWallet(name: string): { address: Address; wallet: Wallet } {
  let row = sysGet.get(name) as { address: string; enc_key: Buffer } | undefined;
  if (!row) {
    const pk = generatePrivateKey();
    sysInsert.run(name, privateKeyToAccount(pk).address.toLowerCase(), encrypt(Buffer.from(pk.slice(2), "hex")), now());
    row = sysGet.get(name) as { address: string; enc_key: Buffer };
  }
  const pk = ("0x" + decrypt(row.enc_key).toString("hex")) as Hex;
  return { address: getAddress(row.address), wallet: createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(config.rpcUrl, { timeout: 30_000 }) }) };
}

export const escrow = () => systemWallet("escrow");
const ESCROW_LOCK = -1;

// ---------------------------------------------------------------------------
// Wallet views
// ---------------------------------------------------------------------------

const agentTokensStmt = db.prepare(`SELECT token FROM agent_tokens WHERE agent_id = ? ORDER BY first_seen DESC LIMIT 100`);
const touchAgentToken = db.prepare(`INSERT OR IGNORE INTO agent_tokens (agent_id, token, first_seen) VALUES (?, ?, ?)`);
const tokenRow = db.prepare(`SELECT address, name, symbol, decimals, curve, graduated, launched_by FROM tokens WHERE address = ?`);

export async function holdings(agent: AgentRow) {
  const known = new Map<string, string>(Object.entries(KNOWN_ASSETS).map(([sym, a]) => [a.address.toLowerCase(), sym]));
  const set = new Set<string>([...known.keys(), ...(agentTokensStmt.all(agent.id) as Array<{ token: string }>).map((r) => r.token)]);
  if (config.societyToken) set.add(config.societyToken);
  const out = [];
  for (const addr of set) {
    const token = getAddress(addr);
    try {
      const sym = known.get(addr);
      const meta = sym ? { symbol: sym, name: KNOWN_ASSETS[sym]!.name, decimals: KNOWN_ASSETS[sym]!.decimals } : await tokenMeta(token);
      const bal = await erc20Balance(token, agent.address);
      const always = addr === config.societyToken || sym === "USDC" || sym === "USDG";
      if (bal === 0n && !always) continue;
      out.push({ token, symbol: meta.symbol, name: meta.name, balance: formatUnits(bal, meta.decimals), balance_wei: bal.toString(), decimals: meta.decimals, society_token: addr === config.societyToken, stable: sym === "USDC" || sym === "USDG" || sym === "USDT" });
    } catch {
      /* a token that stops answering is not the agent's problem */
    }
  }
  return out;
}

export async function wallet(agent: AgentRow) {
  const [eth, tokens] = await Promise.all([ethBalance(agent.address), holdings(agent)]);
  return {
    address: agent.address,
    chain: { id: config.chainId, name: config.chainId === 46630 ? "Robinhood Chain Testnet" : "Robinhood Chain", explorer: addressUrl(agent.address) },
    eth: fmt(eth),
    eth_wei: eth.toString(),
    tokens,
    assets_by_name: Object.fromEntries(Object.entries(KNOWN_ASSETS).map(([k, v]) => [k, v.address])),
    fund: "Send ETH (for gas and trading) or USDC/USDG on Robinhood Chain to this address. Bridge from Ethereum, Arbitrum or Base via the Arbitrum bridge, Across, or Uniswap. Gas is ETH; a few thousandths cover hundreds of transactions.",
  };
}

export function exportWallet(agent: AgentRow, confirm: unknown) {
  if (confirm !== true) throw new ApiError(400, 'Pass {"confirm": true}. The key is yours; whoever holds it holds the wallet.');
  return { address: agent.address, private_key: privateKeyOf(agent), warning: "Anyone with this key controls the wallet. Murmur keeps a copy so the API keeps working." };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

const insertTransfer = db.prepare(
  `INSERT INTO transfers (from_id, to_id, to_address, asset, symbol, amount, amount_wei, memo, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const transfersFor = db.prepare(
  `SELECT t.*, f.handle AS from_handle, r.handle AS to_handle FROM transfers t JOIN agents f ON f.id = t.from_id LEFT JOIN agents r ON r.id = t.to_id
    WHERE t.from_id = ? OR t.to_id = ? ORDER BY t.id DESC LIMIT ?`,
);
const transfersRecent = db.prepare(
  `SELECT t.*, f.handle AS from_handle, r.handle AS to_handle FROM transfers t JOIN agents f ON f.id = t.from_id LEFT JOIN agents r ON r.id = t.to_id ORDER BY t.id DESC LIMIT ?`,
);

function resolveRecipient(to: unknown): { address: Address; agent: AgentRow | null } {
  const s = str(to, "to", { min: 2, max: 64 });
  if (isAddress(s)) return { address: getAddress(s), agent: findAgentByAddress(s) ?? null };
  const agent = getAgent(s);
  return { address: getAddress(agent.address), agent };
}

async function sendAsset(w: Wallet, asset: Asset, to: Address, wei: bigint): Promise<Hex> {
  if (asset.kind === "eth") {
    const hash = await w.sendTransaction({ to, value: wei });
    await waitFor(hash);
    return hash;
  }
  const hash = await w.writeContract({ address: asset.address, abi: erc20Abi, functionName: "transfer", args: [to, wei] });
  await waitFor(hash);
  return hash;
}

async function assertBalance(owner: Address, asset: Asset, wei: bigint, label: string) {
  const bal = asset.kind === "eth" ? await ethBalance(owner) : await erc20Balance(asset.address, owner);
  if (bal < wei) throw new ApiError(402, `${label} only has ${formatUnits(bal, asset.decimals)} ${asset.symbol}; ${formatUnits(wei, asset.decimals)} needed.`);
}

function transferView(t: Record<string, unknown>, viewer?: AgentRow) {
  return {
    id: t.id,
    direction: viewer ? (t.from_id === viewer.id ? "out" : "in") : undefined,
    from: t.from_handle,
    to: t.to_handle ?? t.to_address,
    asset: t.symbol,
    amount: t.amount,
    memo: t.memo,
    tx_hash: t.tx_hash,
    created_at: t.created_at,
  };
}

export async function transfer(agent: AgentRow, input: { to: unknown; asset?: unknown; amount: unknown; memo?: unknown }) {
  chainLimit(agent);
  const { address: to, agent: recipient } = resolveRecipient(input.to);
  if (to.toLowerCase() === agent.address.toLowerCase()) throw new ApiError(400, "that is your own wallet");
  const asset = await resolveAsset(input.asset);
  const wei = parseAmount(input.amount, asset.decimals);
  const memo = str(input.memo, "memo", { max: 280, required: false }) || null;

  const tx_hash = await withAgentLock(agent.id, async () => {
    await assertBalance(agent.address, asset, wei, "Your wallet");
    if (asset.kind === "erc20" && (await ethBalance(agent.address)) === 0n) throw new ApiError(402, "Your wallet has no ETH for gas. Send a little ETH first.");
    try {
      return await sendAsset(walletFor(agent), asset, to, wei);
    } catch (e) {
      throw friendlyChainError(e);
    }
  });

  const amount = formatUnits(wei, asset.decimals);
  const assetKey = asset.kind === "eth" ? "ETH" : asset.address.toLowerCase();
  const info = insertTransfer.run(agent.id, recipient?.id ?? null, to.toLowerCase(), assetKey, asset.symbol, amount, wei.toString(), memo, tx_hash, now());
  if (recipient && asset.kind === "erc20") touchAgentToken.run(recipient.id, asset.address.toLowerCase(), now());
  emit("transfer", {
    agentId: agent.id,
    targetId: recipient?.id ?? null,
    refId: Number(info.lastInsertRowid),
    payload: { to: recipient?.handle ?? to, asset: asset.symbol, amount, memo, tx_hash },
  });
  return { ok: true, to: recipient?.handle ?? to, to_address: to, asset: asset.symbol, amount, memo, tx_hash, tx_url: txUrl(tx_hash) };
}

export function transferHistory(agent: AgentRow, limit = 50) {
  return (transfersFor.all(agent.id, agent.id, limit) as Array<Record<string, unknown>>).map((t) => transferView(t, agent));
}

export function recentTransfers(limit = 50) {
  return (transfersRecent.all(Math.min(limit, 200)) as Array<Record<string, unknown>>).map((t) => transferView(t));
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

const insertTrade = db.prepare(
  `INSERT INTO trades (agent_id, token, symbol, side, venue, eth_wei, tokens_wei, price_eth, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const tradesRecent = db.prepare(
  `SELECT t.*, a.handle FROM trades t JOIN agents a ON a.id = t.agent_id WHERE (? IS NULL OR t.token = ?) ORDER BY t.id DESC LIMIT ?`,
);
const tradesFor = db.prepare(`SELECT t.*, a.handle FROM trades t JOIN agents a ON a.id = t.agent_id WHERE t.agent_id = ? ORDER BY t.id DESC LIMIT ?`);
const upsertPonsToken = db.prepare(
  `INSERT INTO tokens (address, name, symbol, decimals, curve, pair_token, deployer, launched_by, logo, description, graduated, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(address) DO UPDATE SET curve = excluded.curve, pair_token = excluded.pair_token, deployer = excluded.deployer,
     launched_by = COALESCE(tokens.launched_by, excluded.launched_by), logo = excluded.logo, description = excluded.description,
     graduated = excluded.graduated, updated_at = excluded.updated_at`,
);

function rememberToken(info: pons.TokenInfo, launchedBy: number | null = null) {
  const t = now();
  upsertPonsToken.run(
    info.address.toLowerCase(),
    info.name,
    info.symbol,
    info.decimals,
    info.curve?.toLowerCase() ?? null,
    info.quote.address?.toLowerCase() ?? null,
    info.deployer?.toLowerCase() ?? null,
    launchedBy,
    info.logo,
    info.description,
    info.phase === "pool" ? 1 : 0,
    t,
    t,
  );
}

export function parseToken(v: unknown): Address {
  const s = typeof v === "string" ? v.trim() : "";
  if (isAddress(s)) return getAddress(s);
  if (s.replace(/^\$/, "").toUpperCase() === config.societySymbol && config.societyToken) return getAddress(config.societyToken);
  throw new ApiError(400, "token must be a 0x address of a Pons token on Robinhood Chain");
}

function tradeView(t: Record<string, unknown>) {
  return {
    id: t.id,
    agent: t.handle,
    token: t.token,
    symbol: t.symbol,
    side: t.side,
    venue: t.venue,
    eth: fmt(BigInt(t.eth_wei as string)),
    tokens: fmt(BigInt(t.tokens_wei as string)),
    price_eth: t.price_eth,
    tx_hash: t.tx_hash,
    created_at: t.created_at,
  };
}

export async function token(address: unknown) {
  const info = await pons.tokenInfo(parseToken(address));
  if (info.pons) rememberToken(info);
  const row = tokenRow.get(info.address.toLowerCase()) as { launched_by: number | null } | undefined;
  const launcher = row?.launched_by ? getAgentById(row.launched_by).handle : null;
  const trades = (tradesRecent.all(info.address.toLowerCase(), info.address.toLowerCase(), 30) as Array<Record<string, unknown>>).map(tradeView);
  return { ...info, launched_by: launcher, society_token: info.address.toLowerCase() === config.societyToken, recent_trades: trades };
}

export async function quoteTrade(input: { token: unknown; side: unknown; amount: unknown; buyer?: unknown }) {
  const side = input.side === "sell" ? "sell" : input.side === "buy" ? "buy" : null;
  if (!side) throw new ApiError(400, "side must be buy or sell");
  const info = await pons.tokenInfo(parseToken(input.token));
  const wei = parseAmount(input.amount, side === "buy" ? info.quote.decimals : info.decimals);
  const buyer = typeof input.buyer === "string" && isAddress(input.buyer) ? getAddress(input.buyer) : undefined;
  const q = await pons.quote(info, side, wei, buyer);
  return { token: info.address, symbol: info.symbol, phase: info.phase, ...q };
}

export async function trade(agent: AgentRow, side: "buy" | "sell", input: { token: unknown; amount: unknown; slippage_bps?: unknown }) {
  chainLimit(agent);
  const address = parseToken(input.token);
  const slippage = input.slippage_bps === undefined ? 300 : int(input.slippage_bps, "slippage_bps");
  if (slippage > 5000) throw new ApiError(400, "slippage_bps must be at most 5000");

  const result = await withAgentLock(agent.id, async () => {
    const info = await pons.tokenInfo(address);
    let wei: bigint;
    if (side === "sell" && (input.amount === "all" || input.amount === "max")) {
      wei = await erc20Balance(info.address, agent.address);
      if (wei === 0n) throw new ApiError(402, `You hold no ${info.symbol}.`);
    } else {
      wei = parseAmount(input.amount, side === "buy" ? info.quote.decimals : info.decimals);
    }
    const q = await pons.quote(info, side, wei, getAddress(agent.address));
    if (side === "buy") {
      const quoteAsset: Asset = info.quote.address ? { kind: "erc20", address: info.quote.address, symbol: info.quote.symbol, name: info.quote.symbol, decimals: info.quote.decimals } : { kind: "eth", symbol: "ETH", decimals: 18 };
      await assertBalance(agent.address, quoteAsset, BigInt(q.amount_in_wei), "Your wallet");
    } else {
      await assertBalance(agent.address, { kind: "erc20", address: info.address, symbol: info.symbol, name: info.name, decimals: info.decimals }, wei, "Your wallet");
    }
    let fill: pons.Fill;
    try {
      fill = await pons.executeTrade(walletFor(agent), info, q, slippage);
    } catch (e) {
      throw friendlyChainError(e);
    }
    return { info, q, fill };
  });

  const { info, q, fill } = result;
  const rec = recordTrade(agent, info, side, fill, { announce: true });
  return { ...rec, quoted_out: q.amount_out, snipe_tax_bps: q.snipe_tax_bps };
}

/** Write a fill to the tape. The box uses this too, so its buys count as trades. */
export function recordTrade(agent: AgentRow, info: pons.TokenInfo, side: "buy" | "sell", fill: pons.Fill, opts: { announce: boolean }) {
  const ethWei = side === "buy" ? fill.amount_in_wei : fill.amount_out_wei;
  const tokWei = side === "buy" ? fill.amount_out_wei : fill.amount_in_wei;
  const price = tokWei > 0n ? Number(formatUnits(ethWei, info.quote.decimals)) / Number(formatUnits(tokWei, info.decimals)) : 0;
  const priceStr = price > 0 ? price.toPrecision(6).replace(/\.?0+$/, "") : "0";
  const t = now();
  const row = insertTrade.run(agent.id, info.address.toLowerCase(), info.symbol, side, fill.venue, ethWei.toString(), tokWei.toString(), priceStr, fill.tx_hash, t);
  touchAgentToken.run(agent.id, info.address.toLowerCase(), t);
  rememberToken(info);
  if (opts.announce) {
    emit("trade", {
      agentId: agent.id,
      refId: Number(row.lastInsertRowid),
      payload: { side, symbol: info.symbol, token: info.address, venue: fill.venue, eth: formatUnits(ethWei, info.quote.decimals), tokens: formatUnits(tokWei, info.decimals), tx_hash: fill.tx_hash },
    });
  }
  return {
    ok: true,
    side,
    venue: fill.venue,
    token: info.address,
    symbol: info.symbol,
    quote_symbol: info.quote.symbol,
    spent: side === "buy" ? formatUnits(ethWei, info.quote.decimals) : formatUnits(tokWei, info.decimals),
    received: side === "buy" ? formatUnits(tokWei, info.decimals) : formatUnits(ethWei, info.quote.decimals),
    price_eth_per_token: priceStr,
    tx_hash: fill.tx_hash,
    tx_url: txUrl(fill.tx_hash),
  };
}

export function recentTrades(tokenAddr?: string, limit = 50) {
  const key = tokenAddr ? tokenAddr.toLowerCase() : null;
  return (tradesRecent.all(key, key, Math.min(limit, 200)) as Array<Record<string, unknown>>).map(tradeView);
}

export function tradeHistory(agent: AgentRow, limit = 50) {
  return (tradesFor.all(agent.id, limit) as Array<Record<string, unknown>>).map(tradeView);
}

// ---------------------------------------------------------------------------
// Launches
// ---------------------------------------------------------------------------

const insertLaunch = db.prepare(`INSERT INTO launches (agent_id, token, curve, name, symbol, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const societyTokens = db.prepare(
  `SELECT t.*, a.handle AS launched_by_handle FROM tokens t LEFT JOIN agents a ON a.id = t.launched_by WHERE t.curve IS NOT NULL ORDER BY t.updated_at DESC LIMIT ?`,
);

export async function launch(agent: AgentRow, input: Record<string, unknown>) {
  assertQuota(agent.id, "launches");
  chainLimit(agent);
  const p: pons.LaunchParams = {
    name: str(input.name, "name", { min: 1, max: 64 }),
    symbol: str(input.symbol, "symbol", { min: 1, max: 16 }).toUpperCase(),
    logo: str(input.logo, "logo", { max: 512, required: false }),
    description: str(input.description, "description", { max: 2048, required: false }),
    twitter: str(input.twitter, "twitter", { max: 256, required: false }),
    telegram: str(input.telegram, "telegram", { max: 256, required: false }),
    discord: str(input.discord, "discord", { max: 256, required: false }),
    website: str(input.website, "website", { max: 256, required: false }),
    farcaster: str(input.farcaster, "farcaster", { max: 256, required: false }),
    creatorTaxBps: input.creator_tax_bps === undefined ? 0 : int(input.creator_tax_bps, "creator_tax_bps"),
    buybackEnabled: input.buyback === undefined ? true : input.buyback === true,
  };
  const initialBuy = input.initial_buy_eth === undefined ? 0n : parseAmount(input.initial_buy_eth, 18, "initial_buy_eth");

  const result = await withAgentLock(agent.id, async () => {
    const fee = await pons.launchFee();
    const bal = await ethBalance(agent.address);
    const need = fee + initialBuy + 200_000_000_000_000n; // fee + first buy + generous gas headroom
    if (bal < need) throw new ApiError(402, `Launching needs about ${fmt(need)} ETH (fee ${fmt(fee)} + first buy + gas); your wallet has ${fmt(bal)}.`);
    try {
      return await pons.launchToken(walletFor(agent), p);
    } catch (e) {
      throw friendlyChainError(e);
    }
  });

  const t = now();
  const info = await pons.tokenInfo(result.token);
  rememberToken(info, agent.id);
  insertLaunch.run(agent.id, result.token.toLowerCase(), result.curve.toLowerCase(), p.name, p.symbol, result.tx_hash, t);
  touchAgentToken.run(agent.id, result.token.toLowerCase(), t);
  emit("launch", { agentId: agent.id, payload: { token: result.token, name: p.name, symbol: p.symbol, tx_hash: result.tx_hash } });

  let first_buy: unknown = null;
  if (initialBuy > 0n) {
    try {
      first_buy = await trade(agent, "buy", { token: result.token, amount: fmt(initialBuy), slippage_bps: 1000 });
    } catch (e) {
      first_buy = { ok: false, error: e instanceof ApiError ? e.message : "first buy failed" };
    }
  }
  return {
    ok: true,
    token: result.token,
    curve: result.curve,
    name: p.name,
    symbol: p.symbol,
    fee_eth: fmt(result.fee_wei),
    tx_hash: result.tx_hash,
    tx_url: txUrl(result.tx_hash),
    first_buy,
    trade_with: { buy: `POST ${config.publicUrl}/api/trade/buy {"token":"${result.token}","amount":"0.01"}` },
  };
}

export function listSocietyTokens(limit = 50) {
  return (societyTokens.all(limit) as Array<Record<string, unknown>>).map((t) => ({
    address: getAddress(t.address as string),
    name: t.name,
    symbol: t.symbol,
    curve: t.curve,
    graduated: !!t.graduated,
    launched_by: t.launched_by_handle,
    logo: t.logo,
    description: t.description,
    society_token: (t.address as string) === config.societyToken,
    updated_at: t.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Deals: agent-to-agent swaps at an agreed price, settled wallet to wallet.
// ---------------------------------------------------------------------------

const insertDeal = db.prepare(
  `INSERT INTO deals (maker_id, only_for_id, offer_asset, offer_symbol, offer_amount, offer_wei, want_asset, want_symbol, want_amount, want_wei, memo, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const dealById = db.prepare(
  `SELECT d.*, m.handle AS maker, t.handle AS taker, o.handle AS only_for FROM deals d JOIN agents m ON m.id = d.maker_id
     LEFT JOIN agents t ON t.id = d.taker_id LEFT JOIN agents o ON o.id = d.only_for_id WHERE d.id = ?`,
);
const dealsByStatus = db.prepare(
  `SELECT d.*, m.handle AS maker, t.handle AS taker, o.handle AS only_for FROM deals d JOIN agents m ON m.id = d.maker_id
     LEFT JOIN agents t ON t.id = d.taker_id LEFT JOIN agents o ON o.id = d.only_for_id WHERE d.status = ? ORDER BY d.id DESC LIMIT ?`,
);
const setDeal = db.prepare(`UPDATE deals SET status = ?, taker_id = ?, tx_taker = ?, tx_maker = ?, closed_at = ? WHERE id = ?`);

type DealRow = {
  id: number;
  maker_id: number;
  taker_id: number | null;
  only_for_id: number | null;
  maker: string;
  taker: string | null;
  only_for: string | null;
  offer_asset: string;
  offer_symbol: string;
  offer_amount: string;
  offer_wei: string;
  want_asset: string;
  want_symbol: string;
  want_amount: string;
  want_wei: string;
  memo: string | null;
  status: string;
  tx_taker: string | null;
  tx_maker: string | null;
  created_at: number;
  closed_at: number | null;
};

function dealView(d: DealRow) {
  return {
    id: d.id,
    maker: d.maker,
    taker: d.taker,
    only_for: d.only_for,
    offer: { asset: d.offer_asset, symbol: d.offer_symbol, amount: d.offer_amount },
    want: { asset: d.want_asset, symbol: d.want_symbol, amount: d.want_amount },
    memo: d.memo,
    status: d.status,
    tx_taker: d.tx_taker,
    tx_maker: d.tx_maker,
    created_at: d.created_at,
    closed_at: d.closed_at,
    accept: d.status === "open" ? `POST ${config.publicUrl}/api/deals/${d.id}/accept` : null,
  };
}

async function assetFromKey(key: string): Promise<Asset> {
  return resolveAsset(key === "ETH" ? "ETH" : key);
}

export async function openDeal(maker: AgentRow, input: { offer?: { asset?: unknown; amount?: unknown }; want?: { asset?: unknown; amount?: unknown }; to?: unknown; memo?: unknown }) {
  assertQuota(maker.id, "deals");
  if (!input.offer || !input.want) throw new ApiError(400, "a deal needs offer {asset, amount} and want {asset, amount}");
  const offer = await resolveAsset(input.offer.asset);
  const want = await resolveAsset(input.want.asset);
  const offerWei = parseAmount(input.offer.amount, offer.decimals, "offer.amount");
  const wantWei = parseAmount(input.want.amount, want.decimals, "want.amount");
  const offerKey = offer.kind === "eth" ? "ETH" : offer.address.toLowerCase();
  const wantKey = want.kind === "eth" ? "ETH" : want.address.toLowerCase();
  if (offerKey === wantKey) throw new ApiError(400, "offer and want must be different assets");
  const onlyFor = input.to ? getAgent(str(input.to, "to", { min: 2, max: 33 })) : null;
  if (onlyFor && onlyFor.id === maker.id) throw new ApiError(400, "a deal with yourself settles nothing");
  await assertBalance(maker.address, offer, offerWei, "Your wallet");
  const memo = str(input.memo, "memo", { max: 280, required: false }) || null;
  const info = insertDeal.run(
    maker.id,
    onlyFor?.id ?? null,
    offerKey,
    offer.symbol,
    formatUnits(offerWei, offer.decimals),
    offerWei.toString(),
    wantKey,
    want.symbol,
    formatUnits(wantWei, want.decimals),
    wantWei.toString(),
    memo,
    now(),
  );
  const deal = dealById.get(info.lastInsertRowid) as DealRow;
  emit("deal_open", {
    agentId: maker.id,
    targetId: onlyFor?.id ?? null,
    refId: deal.id,
    payload: { deal_id: deal.id, offer: `${deal.offer_amount} ${deal.offer_symbol}`, want: `${deal.want_amount} ${deal.want_symbol}`, memo },
  });
  return dealView(deal);
}

export async function acceptDeal(taker: AgentRow, id: number) {
  chainLimit(taker);
  const deal = dealById.get(id) as DealRow | undefined;
  if (!deal) throw new ApiError(404, "no such deal");
  if (deal.status !== "open") throw new ApiError(409, `that deal is ${deal.status}`);
  if (deal.maker_id === taker.id) throw new ApiError(400, "you made this deal; cancel it instead");
  if (deal.only_for_id && deal.only_for_id !== taker.id) throw new ApiError(403, "that deal was offered to someone else");
  const maker = getAgentById(deal.maker_id);
  const offer = await assetFromKey(deal.offer_asset);
  const want = await assetFromKey(deal.want_asset);
  const offerWei = BigInt(deal.offer_wei);
  const wantWei = BigInt(deal.want_wei);

  const [first, second] = taker.id < maker.id ? [taker, maker] : [maker, taker];
  return withAgentLock(first.id, () =>
    withAgentLock(second.id, async () => {
      const fresh = dealById.get(id) as DealRow;
      if (fresh.status !== "open") throw new ApiError(409, `that deal is ${fresh.status}`);
      await assertBalance(taker.address, want, wantWei, "Your wallet");
      await assertBalance(maker.address, offer, offerWei, `${maker.handle}'s wallet`);
      let txTaker: Hex;
      try {
        txTaker = await sendAsset(walletFor(taker), want, getAddress(maker.address), wantWei);
      } catch (e) {
        throw friendlyChainError(e);
      }
      let txMaker: Hex | null = null;
      try {
        txMaker = await sendAsset(walletFor(maker), offer, getAddress(taker.address), offerWei);
      } catch {
        // Maker's leg failed after the taker paid: return the taker's leg and mark it failed.
        try {
          await sendAsset(walletFor(maker), want, getAddress(taker.address), wantWei);
        } catch {
          /* recorded below; the tx hashes tell the story */
        }
        setDeal.run("failed", taker.id, txTaker, null, now(), id);
        throw new ApiError(502, "The maker's side of the deal could not settle. Your payment was returned.");
      }
      const t = now();
      setDeal.run("filled", taker.id, txTaker, txMaker, t, id);
      if (want.kind === "erc20") touchAgentToken.run(maker.id, want.address.toLowerCase(), t);
      if (offer.kind === "erc20") touchAgentToken.run(taker.id, offer.address.toLowerCase(), t);
      const filled = dealById.get(id) as DealRow;
      emit("deal_filled", {
        agentId: taker.id,
        targetId: maker.id,
        refId: id,
        payload: { deal_id: id, maker: maker.handle, taker: taker.handle, offer: `${deal.offer_amount} ${deal.offer_symbol}`, want: `${deal.want_amount} ${deal.want_symbol}`, tx_taker: txTaker, tx_maker: txMaker },
      });
      return { ...dealView(filled), tx_urls: { taker: txUrl(txTaker), maker: txUrl(txMaker) } };
    }),
  );
}

export function cancelDeal(maker: AgentRow, id: number) {
  const deal = dealById.get(id) as DealRow | undefined;
  if (!deal) throw new ApiError(404, "no such deal");
  if (deal.maker_id !== maker.id) throw new ApiError(403, "only the maker can cancel");
  if (deal.status !== "open") throw new ApiError(409, `that deal is ${deal.status}`);
  setDeal.run("cancelled", null, null, null, now(), id);
  emit("deal_cancelled", { agentId: maker.id, targetId: deal.only_for_id, refId: id, payload: { deal_id: id } });
  return dealView(dealById.get(id) as DealRow);
}

export function getDeal(id: number) {
  const deal = dealById.get(id) as DealRow | undefined;
  if (!deal) throw new ApiError(404, "no such deal");
  return dealView(deal);
}

export function listDeals(status = "open", limit = 50) {
  const s = ["open", "filled", "cancelled", "failed"].includes(status) ? status : "open";
  return (dealsByStatus.all(s, Math.min(limit, 200)) as DealRow[]).map(dealView);
}

// ---------------------------------------------------------------------------
// Bounties: post work with a reward held in escrow; award it to a submission.
// ---------------------------------------------------------------------------

const SETTLEMENT_GAS = 100_000_000_000_000n; // 0.0001 ETH sent with each bounty so the escrow can pay out

const insertBounty = db.prepare(
  `INSERT INTO bounties (funder_id, title, brief, asset, symbol, amount, amount_wei, expires_at, tx_fund, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const bountyById = db.prepare(`SELECT b.*, f.handle AS funder, w.handle AS winner FROM bounties b JOIN agents f ON f.id = b.funder_id LEFT JOIN agents w ON w.id = b.winner_id WHERE b.id = ?`);
const bountiesByStatus = db.prepare(
  `SELECT b.*, f.handle AS funder, w.handle AS winner FROM bounties b JOIN agents f ON f.id = b.funder_id LEFT JOIN agents w ON w.id = b.winner_id WHERE b.status = ? ORDER BY b.id DESC LIMIT ?`,
);
const expiredBounties = db.prepare(`SELECT id FROM bounties WHERE status = 'open' AND expires_at < ?`);
const submissionsFor = db.prepare(`SELECT s.*, a.handle FROM submissions s JOIN agents a ON a.id = s.agent_id WHERE s.bounty_id = ? ORDER BY s.id ASC`);
const submissionById = db.prepare(`SELECT s.*, a.handle FROM submissions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ?`);
const insertSubmission = db.prepare(`INSERT INTO submissions (bounty_id, agent_id, artifact, note, created_at) VALUES (?, ?, ?, ?, ?)`);
const closeBounty = db.prepare(`UPDATE bounties SET status = ?, winner_id = ?, submission_id = ?, tx_settle = ?, closed_at = ? WHERE id = ?`);

type BountyRow = {
  id: number;
  funder_id: number;
  funder: string;
  title: string;
  brief: string;
  asset: string;
  symbol: string;
  amount: string;
  amount_wei: string;
  status: string;
  winner_id: number | null;
  winner: string | null;
  submission_id: number | null;
  expires_at: number;
  tx_fund: string;
  tx_settle: string | null;
  created_at: number;
  closed_at: number | null;
};

function bountyView(b: BountyRow, withSubmissions = false) {
  const subs = withSubmissions ? (submissionsFor.all(b.id) as Array<Record<string, unknown>>).map((s) => ({ id: s.id, agent: s.handle, artifact: s.artifact, note: s.note, created_at: s.created_at })) : undefined;
  return {
    id: b.id,
    funder: b.funder,
    title: b.title,
    brief: b.brief,
    reward: { asset: b.asset, symbol: b.symbol, amount: b.amount },
    status: b.status,
    winner: b.winner,
    winning_submission: b.submission_id,
    expires_at: b.expires_at,
    tx_fund: b.tx_fund,
    tx_settle: b.tx_settle,
    created_at: b.created_at,
    closed_at: b.closed_at,
    submissions: subs,
    submit: b.status === "open" ? `POST ${config.publicUrl}/api/bounties/${b.id}/submit {"artifact":"url or hash","note":"..."}` : null,
  };
}

export async function openBounty(funder: AgentRow, input: { title: unknown; brief: unknown; reward?: { asset?: unknown; amount?: unknown }; hours?: unknown }) {
  assertQuota(funder.id, "bounties");
  chainLimit(funder);
  const title = str(input.title, "title", { min: 3, max: 120 });
  const brief = str(input.brief, "brief", { min: 1, max: 8000 });
  if (!input.reward) throw new ApiError(400, "a bounty needs reward {asset, amount}");
  const asset = await resolveAsset(input.reward.asset);
  const wei = parseAmount(input.reward.amount, asset.decimals, "reward.amount");
  const hours = input.hours === undefined ? 72 : Number(input.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new ApiError(400, "hours must be 1-720");
  const { address: vault } = escrow();

  const tx_fund = await withAgentLock(funder.id, async () => {
    await assertBalance(funder.address, asset, wei, "Your wallet");
    const eth = await ethBalance(funder.address);
    const needEth = (asset.kind === "eth" ? wei : 0n) + SETTLEMENT_GAS + 50_000_000_000_000n;
    if (eth < needEth) throw new ApiError(402, `Funding this bounty needs ${fmt(needEth)} ETH in your wallet (reward, 0.0001 ETH settlement gas, and your own gas); you have ${fmt(eth)}.`);
    try {
      const w = walletFor(funder);
      if (asset.kind === "eth") {
        const hash = await w.sendTransaction({ to: vault, value: wei + SETTLEMENT_GAS });
        await waitFor(hash);
        return hash;
      }
      const gasHash = await w.sendTransaction({ to: vault, value: SETTLEMENT_GAS });
      await waitFor(gasHash);
      return await sendAsset(w, asset, vault, wei);
    } catch (e) {
      throw friendlyChainError(e);
    }
  });

  const info = insertBounty.run(funder.id, title, brief, asset.kind === "eth" ? "ETH" : asset.address.toLowerCase(), asset.symbol, formatUnits(wei, asset.decimals), wei.toString(), now() + Math.round(hours * 3600), tx_fund, now());
  const b = bountyById.get(info.lastInsertRowid) as BountyRow;
  emit("bounty_open", { agentId: funder.id, refId: b.id, payload: { bounty_id: b.id, title, reward: `${b.amount} ${b.symbol}`, expires_at: b.expires_at } });
  return bountyView(b, true);
}

export function submitToBounty(agent: AgentRow, id: number, input: { artifact: unknown; note?: unknown }) {
  const b = bountyById.get(id) as BountyRow | undefined;
  if (!b) throw new ApiError(404, "no such bounty");
  if (b.status !== "open") throw new ApiError(409, `that bounty is ${b.status}`);
  if (b.funder_id === agent.id) throw new ApiError(400, "you funded this bounty");
  const artifact = str(input.artifact, "artifact", { min: 1, max: 2048 });
  const note = str(input.note, "note", { max: 4000, required: false });
  try {
    const info = insertSubmission.run(id, agent.id, artifact, note, now());
    emit("bounty_submit", { agentId: agent.id, targetId: b.funder_id, refId: id, payload: { bounty_id: id, submission_id: Number(info.lastInsertRowid), title: b.title, artifact } });
    return { ok: true, bounty_id: id, submission_id: Number(info.lastInsertRowid) };
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError(409, "you already submitted to this bounty");
    throw e;
  }
}

async function settleBounty(b: BountyRow, to: Address): Promise<Hex> {
  const asset = await assetFromKey(b.asset);
  const { wallet } = escrow();
  return withAgentLock(ESCROW_LOCK, async () => {
    try {
      return await sendAsset(wallet, asset, to, BigInt(b.amount_wei));
    } catch (e) {
      throw friendlyChainError(e);
    }
  });
}

export async function awardBounty(funder: AgentRow, id: number, input: { submission_id: unknown }) {
  const b = bountyById.get(id) as BountyRow | undefined;
  if (!b) throw new ApiError(404, "no such bounty");
  if (b.funder_id !== funder.id) throw new ApiError(403, "only the funder can award");
  if (b.status !== "open") throw new ApiError(409, `that bounty is ${b.status}`);
  const sub = submissionById.get(int(input.submission_id, "submission_id")) as { id: number; bounty_id: number; agent_id: number; handle: string } | undefined;
  if (!sub || sub.bounty_id !== id) throw new ApiError(404, "no such submission on this bounty");
  const winner = getAgentById(sub.agent_id);
  const tx = await settleBounty(b, getAddress(winner.address));
  closeBounty.run("awarded", winner.id, sub.id, tx, now(), id);
  if (b.asset !== "ETH") touchAgentToken.run(winner.id, b.asset, now());
  emit("bounty_awarded", { agentId: funder.id, targetId: winner.id, refId: id, payload: { bounty_id: id, title: b.title, winner: winner.handle, reward: `${b.amount} ${b.symbol}`, tx_hash: tx } });
  return { ...bountyView(bountyById.get(id) as BountyRow, true), tx_url: txUrl(tx) };
}

export async function cancelBounty(funder: AgentRow, id: number) {
  const b = bountyById.get(id) as BountyRow | undefined;
  if (!b) throw new ApiError(404, "no such bounty");
  if (b.funder_id !== funder.id) throw new ApiError(403, "only the funder can cancel");
  if (b.status !== "open") throw new ApiError(409, `that bounty is ${b.status}`);
  const tx = await settleBounty(b, getAddress(funder.address));
  closeBounty.run("cancelled", null, null, tx, now(), id);
  emit("bounty_closed", { agentId: funder.id, refId: id, payload: { bounty_id: id, title: b.title, status: "cancelled", tx_hash: tx } });
  return { ...bountyView(bountyById.get(id) as BountyRow), tx_url: txUrl(tx) };
}

export function getBounty(id: number) {
  const b = bountyById.get(id) as BountyRow | undefined;
  if (!b) throw new ApiError(404, "no such bounty");
  return bountyView(b, true);
}

export function listBounties(status = "open", limit = 50) {
  const s = ["open", "awarded", "cancelled", "expired"].includes(status) ? status : "open";
  return (bountiesByStatus.all(s, Math.min(limit, 200)) as BountyRow[]).map((b) => bountyView(b));
}

/** Refund open bounties past their expiry. Called by the scheduler. */
export async function expireBounties() {
  for (const { id } of expiredBounties.all(now()) as Array<{ id: number }>) {
    const b = bountyById.get(id) as BountyRow;
    try {
      const tx = await settleBounty(b, getAddress(getAgentById(b.funder_id).address));
      closeBounty.run("expired", null, null, tx, now(), id);
      emit("bounty_closed", { agentId: b.funder_id, targetId: b.funder_id, refId: id, payload: { bounty_id: id, title: b.title, status: "expired", tx_hash: tx } });
    } catch (e) {
      console.error("[bounty] refund failed", id, e instanceof Error ? e.message : e);
    }
  }
}

// ---------------------------------------------------------------------------
// Public agent economy view
// ---------------------------------------------------------------------------

export async function agentEconomy(agent: AgentRow) {
  const [eth, tokens] = await Promise.all([ethBalance(agent.address), holdings(agent)]);
  return { ...publicAgent(agent), eth: fmt(eth), tokens, trades: tradeHistory(agent, 20) };
}

export { ADDR };

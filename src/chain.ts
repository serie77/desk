import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { db, now } from "./db.js";
import { ApiError, type AgentRow } from "./society.js";

export const chain = defineChain({
  id: config.chainId,
  name: config.chainId === 46630 ? "Robinhood Chain Testnet" : "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: config.explorerUrl } },
});

export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { batch: true, timeout: 30_000 }) });

/** Robinhood Chain mainnet addresses. Pons V2 + Uniswap V4 (Robinhood's modified Universal Router). */
export const ADDR = {
  ponsFactory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  ponsForwarder: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  ponsHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  usdc: "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8",
  usdt: "0xE246BC49b0598d7Cd9f0eAD48B885034f1254380",
  wbtc: "0x6bac06600D220Ac5Ac281AD1f504D2Cf0F90F6e6",
} as const satisfies Record<string, Address>;

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * Assets every agent can name by symbol. USDC, USDT and WBTC are the canonical
 * Arbitrum-bridge tokens (derived from the L2 gateway router); USDG is Paxos'
 * Global Dollar, Robinhood's house stablecoin and Pons' approved quote asset.
 */
export const KNOWN_ASSETS: Record<string, { address: Address; decimals: number; name: string }> = {
  USDC: { address: ADDR.usdc, decimals: 6, name: "USD Coin (bridged)" },
  USDT: { address: ADDR.usdt, decimals: 6, name: "Tether USD (bridged)" },
  USDG: { address: ADDR.usdg, decimals: 6, name: "Global Dollar" },
  WETH: { address: ADDR.weth, decimals: 18, name: "Wrapped Ether" },
  WBTC: { address: ADDR.wbtc, decimals: 8, name: "Wrapped BTC (bridged)" },
};

// ---------------------------------------------------------------------------
// Wallets: one EVM key per agent, encrypted at rest, only ever decrypted to sign.
// ---------------------------------------------------------------------------

export function newWallet(): { address: Address; encKey: Buffer } {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { address: account.address, encKey: encrypt(Buffer.from(pk.slice(2), "hex")) };
}

export function privateKeyOf(agent: AgentRow): Hex {
  return ("0x" + decrypt(agent.enc_key).toString("hex")) as Hex;
}

export function walletFor(agent: AgentRow) {
  return createWalletClient({ account: privateKeyToAccount(privateKeyOf(agent)), chain, transport: http(config.rpcUrl, { timeout: 30_000 }) });
}
export type Wallet = ReturnType<typeof walletFor>;

/** One chain action at a time per agent: nonces stay ordered, balances stay honest. */
const locks = new Map<number, Promise<void>>();
export async function withAgentLock<T>(agentId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mine = prev.then(() => gate);
  locks.set(agentId, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(agentId) === mine) locks.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenMeta {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
}

const metaCache = new Map<string, TokenMeta>();
const metaFromDb = db.prepare(`SELECT address, name, symbol, decimals FROM tokens WHERE address = ?`);
const metaUpsert = db.prepare(
  `INSERT INTO tokens (address, name, symbol, decimals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(address) DO UPDATE SET name = excluded.name, symbol = excluded.symbol, decimals = excluded.decimals, updated_at = excluded.updated_at`,
);

export async function tokenMeta(address: Address): Promise<TokenMeta> {
  const key = address.toLowerCase();
  const cached = metaCache.get(key);
  if (cached) return cached;
  const row = metaFromDb.get(key) as TokenMeta | undefined;
  if (row) {
    const meta = { ...row, address: getAddress(row.address) };
    metaCache.set(key, meta);
    return meta;
  }
  let name: string, symbol: string, decimals: number;
  try {
    [name, symbol, decimals] = await Promise.all([
      publicClient.readContract({ address, abi: erc20Abi, functionName: "name" }),
      publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
  } catch {
    throw new ApiError(404, "that address is not an ERC-20 token on Robinhood Chain");
  }
  const meta: TokenMeta = { address: getAddress(address), name, symbol, decimals };
  const t = now();
  metaUpsert.run(key, name, symbol, decimals, t, t);
  metaCache.set(key, meta);
  return meta;
}

export async function ethBalance(owner: Address): Promise<bigint> {
  return publicClient.getBalance({ address: owner });
}

export async function erc20Balance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function ensureAllowance(wallet: Wallet, token: Address, spender: Address, amount: bigint): Promise<void> {
  const owner = wallet.account.address;
  const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amount) return;
  const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, 2n ** 256n - 1n] });
  await waitFor(hash);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function waitFor(hash: Hex): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 500 });
  if (receipt.status !== "success") throw new ApiError(502, `Transaction reverted on chain (${txUrl(hash)})`);
  return receipt;
}

export function txUrl(hash: string): string {
  return `${config.explorerUrl}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${config.explorerUrl}/address/${address}`;
}

// ---------------------------------------------------------------------------
// Amounts and assets
// ---------------------------------------------------------------------------

export function parseAmount(v: unknown, decimals: number, field = "amount"): bigint {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string" || !/^\d*\.?\d+$/.test(v.trim())) throw new ApiError(400, `${field} must be a positive decimal string like "0.05"`);
  let wei: bigint;
  try {
    wei = parseUnits(v.trim(), decimals);
  } catch {
    throw new ApiError(400, `${field} has too many decimal places`);
  }
  if (wei <= 0n) throw new ApiError(400, `${field} must be greater than zero`);
  return wei;
}

export function fmt(wei: bigint, decimals = 18): string {
  return formatUnits(wei, decimals);
}

export type Asset = { kind: "eth"; symbol: "ETH"; decimals: 18 } | { kind: "erc20"; symbol: string; name: string; decimals: number; address: Address };

const tokenBySymbol = db.prepare(`SELECT address FROM tokens WHERE symbol = ? COLLATE NOCASE`);

export async function resolveAsset(v: unknown): Promise<Asset> {
  const s = typeof v === "string" ? v.trim().replace(/^\$/, "") : "";
  if (!s || s.toUpperCase() === "ETH") return { kind: "eth", symbol: "ETH", decimals: 18 };
  if (isAddress(s)) {
    const m = await tokenMeta(getAddress(s));
    return { kind: "erc20", ...m };
  }
  const known = KNOWN_ASSETS[s.toUpperCase()];
  if (known) return { kind: "erc20", address: known.address, symbol: s.toUpperCase(), name: known.name, decimals: known.decimals };
  if (s.toUpperCase() === config.societySymbol) {
    if (!config.societyToken) throw new ApiError(400, `${config.societySymbol} has not launched yet`);
    const m = await tokenMeta(getAddress(config.societyToken));
    return { kind: "erc20", ...m };
  }
  const rows = tokenBySymbol.all(s) as Array<{ address: string }>;
  if (rows.length === 1) {
    const m = await tokenMeta(getAddress(rows[0]!.address));
    return { kind: "erc20", ...m };
  }
  throw new ApiError(400, rows.length > 1 ? `several tokens use the symbol ${s}; pass the token address` : `unknown asset "${s}"; pass ETH or a token address`);
}

// ---------------------------------------------------------------------------
// Errors: never leak the stack, always say something an agent can act on.
// ---------------------------------------------------------------------------

const revertMessages: Record<string, [number, string]> = {
  SlippageExceeded: [409, "Price moved past your slippage limit. Retry with a higher slippage_bps."],
  CurveGraduated: [409, "This curve has closed. The token now trades on its Uniswap V4 pool; retry and Murmur will route there."],
  InsufficientLiquidity: [409, "Not enough liquidity on the curve for that size."],
  InsufficientOutputAmount: [400, "That amount is too small to produce any output."],
  LaunchFeeNotPaid: [402, "The launch fee changed; retry."],
  NotWhitelisted: [403, "Pons is not accepting public launches right now."],
  CreatorTaxTooHigh: [400, "creator_tax_bps is above the protocol maximum."],
  V4TooLittleReceived: [409, "Price moved past your slippage limit. Retry with a higher slippage_bps."],
  V4TooMuchRequested: [409, "Price moved past your slippage limit. Retry with a higher slippage_bps."],
  TransactionDeadlinePassed: [504, "The network was slow and the swap deadline passed. Retry."],
};

export function friendlyChainError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName ?? revert?.reason;
    if (name && revertMessages[name]) {
      const [status, msg] = revertMessages[name]!;
      return new ApiError(status, msg);
    }
    if (e.walk((err) => err instanceof InsufficientFundsError)) {
      return new ApiError(402, "Not enough ETH in your wallet to cover this transaction and its gas.");
    }
    const short = (e.shortMessage || e.message || "").toLowerCase();
    if (short.includes("insufficient funds") || short.includes("insufficient balance")) {
      return new ApiError(402, "Not enough ETH in your wallet to cover this transaction and its gas.");
    }
    if (short.includes("timed out") || short.includes("timeout")) {
      return new ApiError(504, "The network is slow right now. Check your wallet before retrying.");
    }
    if (name) return new ApiError(409, `The contract refused this transaction (${name}).`);
    if (revert) return new ApiError(409, "The contract refused this transaction.");
    return new ApiError(502, "Chain request failed. Try again in a moment.");
  }
  const msg = e instanceof Error ? e.message.toLowerCase() : "";
  if (msg.includes("insufficient funds")) return new ApiError(402, "Not enough ETH in your wallet to cover this transaction and its gas.");
  return new ApiError(502, "Chain request failed. Try again in a moment.");
}

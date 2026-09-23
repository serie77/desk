/**
 * Pons Launchpad V2 on Robinhood Chain.
 *
 * Every launch mints 1,000,000,000 tokens into its own constant-product bonding
 * curve that trades against ETH (or an approved ERC-20 quote). When the curve
 * has taken in its graduation threshold it is swept into a permanently locked,
 * full-range Uniswap V4 pool governed by the Pons meme hook. This module prices
 * and executes both phases, and launches new tokens.
 */
import {
  encodeAbiParameters,
  encodePacked,
  erc20Abi,
  formatUnits,
  getAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { randomBytes } from "node:crypto";
import { ADDR, ZERO, ensureAllowance, ethBalance, erc20Balance, publicClient, tokenMeta, waitFor, type Wallet } from "./chain.js";
import { config } from "./config.js";
import { ApiError } from "./society.js";

// ---------------------------------------------------------------------------
// ABIs (only what Murmur calls)
// ---------------------------------------------------------------------------

export const factoryAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function graduate(address token)",
  "function createGraduatedPool(address token) returns (uint256 positionId)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "error LaunchFeeNotPaid()",
  "error NotWhitelisted()",
  "error CreatorTaxTooHigh()",
  "error InvalidTokenParams()",
  "error LaunchConfigDisabled()",
  "error PairTokenNotApproved()",
  "error TokenNotFound()",
  "error WrongGraduationPhase()",
]);

export const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function deployer() view returns (address)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  "function currentSnipeTaxBps(address buyer) view returns (uint256)",
  "error CurveGraduated()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
  "error TransferFailed()",
  "error AlreadyGraduated()",
  "error NotInitialized()",
  "error NotReadyToGraduate()",
  "error NotFeeSweepOperator()",
  "error InternalSwapRequiresOperator()",
  "error MinimumOutputRequired()",
  "error NativeValueMismatch(uint256 supplied, uint256 expected)",
  "error UnexpectedNativeValue()",
  "error InsufficientInputAmount()",
  "error InsufficientOutputAmount()",
  "error InsufficientLiquidity()",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
]);

export const launcherTokenAbi = parseAbi([
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function deployer() view returns (address)",
  "function curve() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);

export const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) view returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error TransactionDeadlinePassed()",
  "error InsufficientETH()",
  "error InsufficientToken()",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error DeltaNotPositive(address currency)",
  "error DeltaNotNegative(address currency)",
]);

export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

// ---------------------------------------------------------------------------
// Token info
// ---------------------------------------------------------------------------

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export type Phase = "curve" | "graduating" | "pool" | "rescued" | "erc20";

export interface TokenInfo {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  pons: boolean;
  phase: Phase;
  quote: { symbol: string; decimals: number; address: Address | null };
  price: { eth_per_token: string; tokens_per_eth: string; market_cap_eth: string } | null;
  deployer: Address | null;
  curve: Address | null;
  curve_state: {
    quote_reserve_wei: string;
    token_reserve_wei: string;
    real_quote_wei: string;
    graduation_threshold_wei: string;
    progress: number;
    sellable_wei: string;
    fee_bps: number;
    creator_tax_bps: number;
  } | null;
  pool: { key: PoolKey; sqrt_price_x96: string; tick: number; liquidity: string } | null;
  logo: string | null;
  description: string | null;
  links: { explorer: string; pons: string };
}

type Launched = {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  exists: boolean;
};

async function launched(token: Address): Promise<Launched | null> {
  const r = await publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  return r.exists ? (r as Launched) : null;
}

export function poolKeyFor(token: Address, pairToken: Address, poolFee: number, tickSpacing: number): PoolKey {
  const a = BigInt(token) < BigInt(pairToken) ? [token, pairToken] : [pairToken, token];
  return { currency0: a[0]!, currency1: a[1]!, fee: poolFee, tickSpacing, hooks: ADDR.ponsHook };
}

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [key],
    ),
  );
}

function num(x: bigint, decimals: number): number {
  return Number(formatUnits(x, decimals));
}
function pretty(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  return (n >= 1 ? n.toFixed(6) : n.toPrecision(6)).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

export async function tokenInfo(address: Address): Promise<TokenInfo> {
  const token = getAddress(address);
  const [meta, rec] = await Promise.all([tokenMeta(token), launched(token)]);
  const links = { explorer: `${config.explorerUrl}/token/${token}`, pons: "https://ponsfamily.com" };
  const totalSupply = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" });
  const base = { address: token, name: meta.name, symbol: meta.symbol, decimals: meta.decimals, total_supply: totalSupply.toString(), links };

  if (!rec) {
    return { ...base, pons: false, phase: "erc20", quote: { symbol: "ETH", decimals: 18, address: null }, price: null, deployer: null, curve: null, curve_state: null, pool: null, logo: null, description: null };
  }

  const quote = rec.pairToken === ZERO ? { symbol: "ETH", decimals: 18, address: null } : await tokenMeta(rec.pairToken).then((m) => ({ symbol: m.symbol, decimals: m.decimals, address: m.address }));
  const [logo, description] = await Promise.all([
    publicClient.readContract({ address: token, abi: launcherTokenAbi, functionName: "logo" }).catch(() => ""),
    publicClient.readContract({ address: token, abi: launcherTokenAbi, functionName: "description" }).catch(() => ""),
  ]);
  const common = { ...base, pons: true, quote, deployer: rec.deployer, curve: rec.curve, logo: logo || null, description: description || null };
  const supply = num(totalSupply, meta.decimals);

  if (rec.phase === 2) {
    const key = poolKeyFor(token, rec.pairToken, rec.poolFee, rec.tickSpacing);
    const id = poolId(key);
    const [slot0, liquidity] = await Promise.all([
      publicClient.readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
      publicClient.readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
    ]);
    const sqrt = Number(slot0[0]) / 2 ** 96;
    const p1per0 = sqrt * sqrt; // currency1 per currency0, raw units
    const tokenIs0 = key.currency0.toLowerCase() === token.toLowerCase();
    const quotePerTokenRaw = tokenIs0 ? p1per0 : 1 / p1per0;
    const quotePerToken = quotePerTokenRaw * 10 ** (meta.decimals - quote.decimals);
    return {
      ...common,
      phase: "pool",
      price: { eth_per_token: pretty(quotePerToken), tokens_per_eth: pretty(quotePerToken > 0 ? 1 / quotePerToken : 0), market_cap_eth: pretty(quotePerToken * supply) },
      curve_state: null,
      pool: { key, sqrt_price_x96: slot0[0].toString(), tick: slot0[1], liquidity: liquidity.toString() },
    };
  }

  if (rec.phase === 3) {
    return { ...common, phase: "rescued", price: null, curve_state: null, pool: null };
  }

  const c = { address: rec.curve, abi: curveAbi } as const;
  const [reserves, sellable, real, threshold, feeBps, taxBps, ready, graduated] = await Promise.all([
    publicClient.readContract({ ...c, functionName: "getReserves" }),
    publicClient.readContract({ ...c, functionName: "sellableTokens" }),
    publicClient.readContract({ ...c, functionName: "realQuoteReserve" }),
    publicClient.readContract({ ...c, functionName: "graduationThreshold" }),
    publicClient.readContract({ ...c, functionName: "feeBps" }),
    publicClient.readContract({ ...c, functionName: "creatorTaxBps" }),
    publicClient.readContract({ ...c, functionName: "readyToGraduate" }),
    publicClient.readContract({ ...c, functionName: "graduated" }),
  ]);
  const quoteReserve = num(reserves[0], quote.decimals);
  const tokenReserve = num(reserves[1], meta.decimals);
  const price = tokenReserve > 0 ? quoteReserve / tokenReserve : 0;
  return {
    ...common,
    phase: rec.phase === 1 || ready || graduated ? "graduating" : "curve",
    price: { eth_per_token: pretty(price), tokens_per_eth: pretty(price > 0 ? 1 / price : 0), market_cap_eth: pretty(price * supply) },
    curve_state: {
      quote_reserve_wei: reserves[0].toString(),
      token_reserve_wei: reserves[1].toString(),
      real_quote_wei: real.toString(),
      graduation_threshold_wei: threshold.toString(),
      progress: threshold > 0n ? Math.min(1, Number((real * 10_000n) / threshold) / 10_000) : 0,
      sellable_wei: sellable.toString(),
      fee_bps: Number(feeBps),
      creator_tax_bps: Number(taxBps),
    },
    pool: null,
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

const BPS = 10_000n;

function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (amountIn * reserveOut) / (reserveIn + amountIn);
}
function amountIn(amountOut_: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveOut <= amountOut_) return 0n;
  return (amountOut_ * reserveIn) / (reserveOut - amountOut_) + 1n;
}

export interface Quote {
  side: "buy" | "sell";
  venue: "curve" | "pool";
  amount_in_wei: string;
  amount_out_wei: string;
  amount_in: string;
  amount_out: string;
  in_symbol: string;
  out_symbol: string;
  price_impact_bps: number | null;
  partial_fill: boolean;
  snipe_tax_bps?: number;
  note?: string;
}

/** The launch-window snipe tax the curve would charge this buyer right now, in bps. */
export async function snipeTaxBps(curve: Address, buyer: Address): Promise<number> {
  try {
    return Number(await publicClient.readContract({ address: curve, abi: curveAbi, functionName: "currentSnipeTaxBps", args: [buyer] }));
  } catch {
    return 0;
  }
}

export async function quote(info: TokenInfo, side: "buy" | "sell", amountWei: bigint, buyer: Address = ZERO): Promise<Quote> {
  if (!info.pons) throw new ApiError(400, `${info.symbol} was not launched on Pons; Murmur only routes Pons tokens`);
  if (info.phase === "graduating") throw new ApiError(409, "This token is graduating from its curve to a Uniswap V4 pool. Try again in a moment.");
  if (info.phase === "rescued") throw new ApiError(409, "This launch was rescued and no longer trades.");
  const inSym = side === "buy" ? info.quote.symbol : info.symbol;
  const outSym = side === "buy" ? info.symbol : info.quote.symbol;
  const inDec = side === "buy" ? info.quote.decimals : info.decimals;
  const outDec = side === "buy" ? info.decimals : info.quote.decimals;

  if (info.phase === "curve") {
    const cs = info.curve_state!;
    const qR = BigInt(cs.quote_reserve_wei);
    const tR = BigInt(cs.token_reserve_wei);
    const snipe = side === "buy" ? await snipeTaxBps(info.curve!, buyer) : 0;
    const feeTotal = BigInt(cs.fee_bps + cs.creator_tax_bps + snipe);
    let out: bigint;
    let spent = amountWei;
    let partial = false;
    if (side === "buy") {
      const net = amountWei - (amountWei * BigInt(cs.fee_bps)) / BPS - (amountWei * BigInt(cs.creator_tax_bps)) / BPS - (amountWei * BigInt(snipe)) / BPS;
      out = amountOut(net, qR, tR);
      const sellable = BigInt(cs.sellable_wei);
      if (out > sellable) {
        out = sellable;
        const needNet = amountIn(sellable, qR, tR);
        spent = (needNet * BPS + (BPS - feeTotal) - 1n) / (BPS - feeTotal);
        if (spent > amountWei) spent = amountWei;
        partial = true;
      }
    } else {
      const gross = amountOut(amountWei, tR, qR);
      out = gross - (gross * feeTotal) / BPS;
    }
    if (out <= 0n && snipe > 0) {
      throw new ApiError(409, `This token launched seconds ago and a snipe tax of ${(snipe / 100).toFixed(2)}% applies to buys right now. Wait a few seconds and quote again.`);
    }
    if (out <= 0n) throw new ApiError(400, "That amount is too small to produce any output.");
    const spot = side === "buy" ? Number(tR) / Number(qR) : Number(qR) / Number(tR);
    const eff = Number(out) / Number(spent);
    const impact = spot > 0 ? Math.max(0, Math.round((1 - eff / spot) * 10_000)) : null;
    return {
      side,
      venue: "curve",
      amount_in_wei: spent.toString(),
      amount_out_wei: out.toString(),
      amount_in: formatUnits(spent, inDec),
      amount_out: formatUnits(out, outDec),
      in_symbol: inSym,
      out_symbol: outSym,
      price_impact_bps: impact,
      partial_fill: partial,
      snipe_tax_bps: side === "buy" ? snipe : undefined,
      note: partial
        ? "This buy finishes the curve; only the remaining allocation fills and the rest of your ETH is refunded."
        : snipe > 0
          ? `This token just launched: a snipe tax of ${(snipe / 100).toFixed(2)}% applies to this buy right now and decays to zero. Wait, or accept it.`
          : undefined,
    };
  }

  const key = info.pool!.key;
  const zeroForOne = side === "buy" ? key.currency1.toLowerCase() === info.address.toLowerCase() : key.currency0.toLowerCase() === info.address.toLowerCase();
  if (amountWei > 2n ** 128n - 1n) throw new ApiError(400, "amount too large");
  let out: bigint;
  try {
    [out] = await publicClient.readContract({
      address: ADDR.quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountWei, hookData: "0x" }],
    });
  } catch {
    throw new ApiError(409, "The pool could not quote that trade. Try a smaller size.");
  }
  if (out <= 0n) throw new ApiError(400, "That amount is too small to produce any output.");
  const sqrt = Number(BigInt(info.pool!.sqrt_price_x96)) / 2 ** 96;
  const p1per0 = sqrt * sqrt;
  const spot = zeroForOne ? p1per0 : 1 / p1per0;
  const eff = Number(out) / Number(amountWei);
  return {
    side,
    venue: "pool",
    amount_in_wei: amountWei.toString(),
    amount_out_wei: out.toString(),
    amount_in: formatUnits(amountWei, inDec),
    amount_out: formatUnits(out, outDec),
    in_symbol: inSym,
    out_symbol: outSym,
    price_impact_bps: spot > 0 ? Math.max(0, Math.round((1 - eff / spot) * 10_000)) : null,
    partial_fill: false,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface Fill {
  tx_hash: Hex;
  venue: "curve" | "pool";
  amount_in_wei: bigint;
  amount_out_wei: bigint;
  gas_used: bigint;
}

function minOut(q: Quote, slippageBps: number): bigint {
  const out = BigInt(q.amount_out_wei);
  return out - (out * BigInt(slippageBps)) / BPS;
}

async function curveBuy(wallet: Wallet, info: TokenInfo, q: Quote, slippageBps: number): Promise<Fill> {
  const amount = BigInt(q.amount_in_wei);
  const min = minOut(q, slippageBps);
  const me = wallet.account.address;
  const native = info.quote.address === null;
  if (!native) await ensureAllowance(wallet, info.quote.address!, info.curve!, amount);
  const hash = await wallet.writeContract({
    address: info.curve!,
    abi: curveAbi,
    functionName: "buy",
    args: [amount, min, me],
    value: native ? amount : 0n,
  });
  const receipt = await waitFor(hash);
  const [log] = parseEventLogs({ abi: curveAbi, eventName: "CurveBuy", logs: receipt.logs });
  return { tx_hash: hash, venue: "curve", amount_in_wei: log?.args.quoteIn ?? amount, amount_out_wei: log?.args.tokensOut ?? min, gas_used: receipt.gasUsed };
}

async function curveSell(wallet: Wallet, info: TokenInfo, q: Quote, slippageBps: number): Promise<Fill> {
  const amount = BigInt(q.amount_in_wei);
  const min = minOut(q, slippageBps);
  const me = wallet.account.address;
  await ensureAllowance(wallet, info.address, info.curve!, amount);
  const hash = await wallet.writeContract({ address: info.curve!, abi: curveAbi, functionName: "sell", args: [amount, min, me] });
  const receipt = await waitFor(hash);
  const [log] = parseEventLogs({ abi: curveAbi, eventName: "CurveSell", logs: receipt.logs });
  return { tx_hash: hash, venue: "curve", amount_in_wei: amount, amount_out_wei: log?.args.quoteOut ?? min, gas_used: receipt.gasUsed };
}

/** Uniswap V4 through Robinhood's modified Universal Router (extra minHopPriceX36 field). */
const V4_SWAP = "0x10" as const;
const ACTIONS = encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
const MAX_UINT160 = 2n ** 160n - 1n;

async function poolSwap(wallet: Wallet, key: PoolKey, tokenIn: Address, tokenOut: Address, amountIn_: bigint, min: bigint): Promise<Fill> {
  const me = wallet.account.address;
  const zeroForOne = key.currency0.toLowerCase() === tokenIn.toLowerCase();
  const nativeIn = tokenIn === ZERO;
  if (!nativeIn) {
    await ensureAllowance(wallet, tokenIn, ADDR.permit2, amountIn_);
    const [allowed, expiration] = await publicClient.readContract({ address: ADDR.permit2, abi: permit2Abi, functionName: "allowance", args: [me, tokenIn, ADDR.universalRouter] });
    if (allowed < amountIn_ || expiration <= Math.floor(Date.now() / 1000) + 60) {
      const h = await wallet.writeContract({ address: ADDR.permit2, abi: permit2Abi, functionName: "approve", args: [tokenIn, ADDR.universalRouter, MAX_UINT160, 2 ** 48 - 1] });
      await waitFor(h);
    }
  }
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "minHopPriceX36", type: "uint256" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: key, zeroForOne, amountIn: amountIn_, amountOutMinimum: min, minHopPriceX36: 0n, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenIn, amountIn_]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenOut, min]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [ACTIONS, [swap, settle, take]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const before = tokenOut === ZERO ? await ethBalance(me) : await erc20Balance(tokenOut, me);
  const hash = await wallet.writeContract({
    address: ADDR.universalRouter,
    abi: routerAbi,
    functionName: "execute",
    args: [V4_SWAP, [input], deadline],
    value: nativeIn ? amountIn_ : 0n,
  });
  const receipt = await waitFor(hash);
  const after = tokenOut === ZERO ? await ethBalance(me) : await erc20Balance(tokenOut, me);
  let out = after - before;
  if (tokenOut === ZERO) out += receipt.gasUsed * receipt.effectiveGasPrice;
  return { tx_hash: hash, venue: "pool", amount_in_wei: amountIn_, amount_out_wei: out < 0n ? 0n : out, gas_used: receipt.gasUsed };
}

export async function executeTrade(wallet: Wallet, info: TokenInfo, q: Quote, slippageBps: number): Promise<Fill> {
  if (q.venue === "curve") return q.side === "buy" ? curveBuy(wallet, info, q, slippageBps) : curveSell(wallet, info, q, slippageBps);
  const key = info.pool!.key;
  const quoteAddr = info.quote.address ?? ZERO;
  const [tokenIn, tokenOut] = q.side === "buy" ? [quoteAddr, info.address] : [info.address, quoteAddr];
  return poolSwap(wallet, key, tokenIn, tokenOut, BigInt(q.amount_in_wei), minOut(q, slippageBps));
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

export interface LaunchParams {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
}

export async function launchFee(): Promise<bigint> {
  return publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "launchFee" });
}

export async function launchToken(wallet: Wallet, p: LaunchParams): Promise<{ token: Address; curve: Address; tx_hash: Hex; fee_wei: bigint }> {
  const [fee, enabled, maxTax] = await Promise.all([
    launchFee(),
    publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "launchEnabled" }),
    publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
  ]);
  if (!enabled) throw new ApiError(503, "Pons is not accepting public launches right now.");
  if (BigInt(p.creatorTaxBps) > maxTax) throw new ApiError(400, `creator_tax_bps must be at most ${maxTax}`);
  const hash = await wallet.writeContract({
    address: ADDR.ponsFactory,
    abi: factoryAbi,
    functionName: "launchToken",
    args: [
      {
        name: p.name,
        symbol: p.symbol,
        logo: p.logo,
        description: p.description,
        socials: { twitter: p.twitter, telegram: p.telegram, discord: p.discord, website: p.website, farcaster: p.farcaster },
        creatorFeeRecipient: wallet.account.address,
        creatorTaxBps: p.creatorTaxBps,
        buybackEnabled: p.buybackEnabled,
        expectedEconomics: "0x0000000000000000000000000000000000000000000000000000000000000000",
        salt: ("0x" + randomBytes(32).toString("hex")) as Hex,
      },
      0n,
      ZERO,
    ],
    value: fee,
  });
  const receipt = await waitFor(hash);
  const [log] = parseEventLogs({ abi: factoryAbi, eventName: "TokenLaunched", logs: receipt.logs });
  if (!log) throw new ApiError(502, "Launch transaction succeeded but no launch event was found.");
  return { token: getAddress(log.args.token), curve: getAddress(log.args.curve), tx_hash: hash, fee_wei: fee };
}

/** Recent Pons launches straight from the chain (what the wider Robinhood market is doing). */
export async function recentLaunches(blocks = 4000, limit = 25) {
  const latest = await publicClient.getBlockNumber();
  const logs = await publicClient.getLogs({
    address: ADDR.ponsFactory,
    event: factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!,
    fromBlock: latest - BigInt(blocks),
    toBlock: latest,
  });
  const picked = logs.slice(-limit).reverse();
  const out = [];
  for (const l of picked) {
    const token = getAddress(l.args.token!);
    const meta = await tokenMeta(token).catch(() => null);
    if (!meta) continue;
    out.push({ address: token, name: meta.name, symbol: meta.symbol, curve: l.args.curve, deployer: l.args.deployer, block: Number(l.blockNumber), tx_hash: l.transactionHash });
  }
  return out;
}

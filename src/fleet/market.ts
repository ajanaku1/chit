/**
 * Read-only market facts for the trading panel, served by the API so the
 * browser never asks a public RPC about fleet wallets.
 *
 * The pool price is read straight from the PoolManager's storage: v4 exposes
 * `extsload`, and v4-periphery's StateLibrary fixes the pools mapping at slot 6
 * with slot0 as the first word of each pool's state.
 */
import { concatHex, encodeAbiParameters, keccak256, parseAbi, toHex, type Address, type Hex, type PublicClient } from "viem";

import type { Uint } from "./types.js";
import { VENUE_POOL, venuePoolKey } from "./v4-swap.js";

export type TokenQuote = {
  token: Address;
  symbol: string;
  decimals: number;
  hasPool: boolean;
  sqrtPriceX96: Uint;
  /** The fill this trade would get right now, fee and price impact included; still an estimate, never a promise. */
  estimatedOut: Uint;
};
export type Holding = { wallet: Address; eth: Uint; tokens: Record<string, Uint> };

export type MarketPort = {
  tokenQuote(token: Address, amountInWei: Uint): Promise<TokenQuote>;
  holdings(wallets: readonly Address[], tokens: readonly Address[]): Promise<Holding[]>;
  /** Campaign keys this owner registered on the escrow, oldest first. */
  campaignsOf(owner: Address): Promise<Hex[]>;
};

const POOLS_SLOT = 6n;
const POOL_KEY_ABI = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] as const;

export const poolIdFor = (token: Address): Hex => {
  const key = venuePoolKey(token);
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
};

export const slot0Slot = (poolId: Hex): Hex => keccak256(concatHex([poolId, toHex(POOLS_SLOT, { size: 32 })]));

export const decodeSlot0 = (word: Hex): { sqrtPriceX96: bigint; tick: number } => {
  const value = BigInt(word);
  const sqrtPriceX96 = value & ((1n << 160n) - 1n);
  const rawTick = (value >> 160n) & ((1n << 24n) - 1n);
  const tick = rawTick >= 1n << 23n ? Number(rawTick - (1n << 24n)) : Number(rawTick);
  return { sqrtPriceX96, tick };
};

/** ETH is currency0, so amountOut ≈ amountIn · (sqrtP / 2^96)²: the spot price, before any impact. */
export const estimateOut = (amountIn: bigint, sqrtPriceX96: bigint): bigint => (amountIn * sqrtPriceX96 * sqrtPriceX96) >> 192n;

/** The pool's active liquidity lives three words after slot0 in v4's Pool.State. */
export const liquiditySlot = (poolId: Hex): Hex => toHex(BigInt(slot0Slot(poolId)) + 3n, { size: 32 });

const Q96 = 1n << 96n;
const FEE_DENOMINATOR = 1_000_000n;

/**
 * An exact-input fill through one full-range position, fee and price impact
 * included: v3/v4's swap step for a single range. The spot estimate above
 * says what a tiny trade would get; this says what this trade gets, which is
 * what a slippage guard has to be set against on a thin pool.
 *
 * One position is the assumption: the venue's pools are seeded full-range
 * (FleetPoolSeeder). On a pool with concentrated positions the fill can
 * cross a tick and differ from this; the trade's own minimum output is the
 * guard then, and the quote is what the card shows.
 */
export const quoteExactIn = (
  amountIn: bigint,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  zeroForOne: boolean,
  feePips: number,
): bigint => {
  if (amountIn === 0n || sqrtPriceX96 === 0n || liquidity === 0n) return 0n;
  const inLessFee = (amountIn * (FEE_DENOMINATOR - BigInt(feePips))) / FEE_DENOMINATOR;
  if (zeroForOne) {
    // token0 (ETH) in: the price falls. sqrtP' = L·Q96·sqrtP / (L·Q96 + in·sqrtP); out1 = L·(sqrtP − sqrtP') / Q96
    const numerator = liquidity * Q96 * sqrtPriceX96;
    const denominator = liquidity * Q96 + inLessFee * sqrtPriceX96;
    const next = numerator / denominator;
    return (liquidity * (sqrtPriceX96 - next)) / Q96;
  }
  // token1 in: the price rises. sqrtP' = sqrtP + in·Q96 / L; out0 = L·Q96·(sqrtP' − sqrtP) / (sqrtP'·sqrtP)
  const next = sqrtPriceX96 + (inLessFee * Q96) / liquidity;
  return (liquidity * Q96 * (next - sqrtPriceX96)) / (next * sqrtPriceX96);
};

const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const ESCROW_EVENTS = parseAbi(["event CampaignRegistered(bytes32 indexed campaign, address indexed owner)"]);

export const createMarket = (
  client: PublicClient,
  addresses: { poolManager: Address; escrow: Address; escrowFromBlock: bigint },
): MarketPort => ({
  async tokenQuote(token, amountInWei) {
    const id = poolIdFor(token);
    const [symbol, decimals, word, liq] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
      client.readContract({ address: addresses.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot0Slot(id)] }),
      client.readContract({ address: addresses.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [liquiditySlot(id)] }).catch(() => "0x0" as Hex),
    ]);
    const { sqrtPriceX96 } = decodeSlot0(word);
    const liquidity = BigInt(liq) & ((1n << 128n) - 1n);
    // The fill this trade would get, fee and price impact included, so the
    // slippage guard set against it holds on a thin pool; the spot estimate
    // alone tripped the guard on the testnet venue, where one buy is a tenth
    // of the liquidity.
    const estimatedOut = liquidity > 0n
      ? quoteExactIn(BigInt(amountInWei), sqrtPriceX96, liquidity, true, VENUE_POOL.fee)
      : estimateOut(BigInt(amountInWei), sqrtPriceX96);
    return {
      token,
      symbol,
      decimals: Number(decimals),
      hasPool: sqrtPriceX96 > 0n,
      sqrtPriceX96: sqrtPriceX96.toString(),
      estimatedOut: estimatedOut.toString(),
    };
  },
  async holdings(wallets, tokens) {
    return Promise.all(
      wallets.map(async (wallet) => {
        const [eth, ...balances] = await Promise.all([
          client.getBalance({ address: wallet }),
          ...tokens.map((token) =>
            client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }).catch(() => 0n),
          ),
        ]);
        const held: Record<string, Uint> = {};
        tokens.forEach((token, i) => {
          held[token.toLowerCase()] = (balances[i] ?? 0n).toString();
        });
        return { wallet, eth: eth.toString(), tokens: held };
      }),
    );
  },
  async campaignsOf(owner) {
    const logs = await client.getLogs({
      address: addresses.escrow,
      event: ESCROW_EVENTS[0],
      args: { owner },
      fromBlock: addresses.escrowFromBlock,
      toBlock: "latest",
    });
    return logs.map((log) => log.args.campaign as Hex);
  },
});

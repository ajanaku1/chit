/**
 * Which pool a token trades in. The venue's own key (uniswap v4, 0.3%, no
 * hook) is one answer; a launchpad token's pool has a hook and a fee of its
 * own, and there are hundreds of those for every plain one. This finds the
 * key from the chain instead of assuming it: the common keys are read
 * straight from the pool manager's storage (cheap, no logs), and when none
 * of them holds liquidity the Initialize events for the token are scanned
 * and the deepest pool wins.
 *
 * A hooked pool is traded with empty hookData, which is what the hooks on
 * this chain expect from a plain swap (the CHIT pool's hook on mainnet
 * takes its 2% that way). A hook that refuses the swap makes the
 * transaction revert, which costs gas and nothing else; the caller's
 * minimum output stands either way.
 */

import { encodeAbiParameters, keccak256, parseAbi, parseAbiItem, type PublicClient } from "viem";

import { decodeSlot0, liquiditySlot, slot0Slot } from "./market.js";
import type { Address, Hex } from "./types.js";
import { NATIVE_ETH, VENUE_POOL, type PoolKey } from "./v4-swap.js";

const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const POOL_KEY_ABI = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] as const;

/** The keys worth a direct read before any log is fetched: the venue's, then uniswap's usual tiers, all hookless. */
const COMMON_KEYS: ReadonlyArray<Pick<PoolKey, "fee" | "tickSpacing" | "hooks">> = [
  { fee: VENUE_POOL.fee, tickSpacing: VENUE_POOL.tickSpacing, hooks: VENUE_POOL.hooks },
  { fee: 500, tickSpacing: 10, hooks: VENUE_POOL.hooks },
  { fee: 10_000, tickSpacing: 200, hooks: VENUE_POOL.hooks },
  { fee: 100, tickSpacing: 1, hooks: VENUE_POOL.hooks },
];

/** How far back the event scan looks when no common key holds liquidity: a few days of either chain. */
const SCAN_BLOCKS = 2_000_000n;
const LOG_SPAN = 100_000n;
const CACHE_MS = 10 * 60_000;

export type DiscoveredPool = { key: PoolKey; id: Hex; sqrtPriceX96: bigint; liquidity: bigint; hooked: boolean };

export const poolIdOf = (key: PoolKey): Hex =>
  keccak256(encodeAbiParameters(POOL_KEY_ABI, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

export type PoolRegistry = {
  /** The token's deepest ETH pool, or null when it has none; remembered for ten minutes. */
  find(token: Address): Promise<DiscoveredPool | null>;
  /** The pool's price and liquidity, read now, for a key already known. */
  state(key: PoolKey): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }>;
};

export const createPoolRegistry = (publicClient: PublicClient, poolManager: Address, scanBlocks = SCAN_BLOCKS): PoolRegistry => {
  const cache = new Map<string, { at: number; pool: DiscoveredPool | null }>();

  const state = async (key: PoolKey): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> => {
    const id = poolIdOf(key);
    const [slot0, liq] = await Promise.all([
      publicClient.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot0Slot(id)] }),
      publicClient.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [liquiditySlot(id)] }),
    ]);
    return { sqrtPriceX96: decodeSlot0(slot0).sqrtPriceX96, liquidity: BigInt(liq) & ((1n << 128n) - 1n) };
  };

  const candidatesFromLogs = async (token: Address): Promise<PoolKey[]> => {
    const head = await publicClient.getBlockNumber();
    const floor = head > scanBlocks ? head - scanBlocks : 0n;
    const keys = new Map<string, PoolKey>();
    for (let to = head; to > floor; to -= LOG_SPAN) {
      const from = to - LOG_SPAN + 1n > floor ? to - LOG_SPAN + 1n : floor;
      const logs = await publicClient.getLogs({ address: poolManager, event: INITIALIZE, args: { currency0: NATIVE_ETH, currency1: token }, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const key: PoolKey = { currency0: NATIVE_ETH, currency1: token, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: l.args.hooks as Address };
        keys.set(poolIdOf(key), key);
      }
    }
    return [...keys.values()];
  };

  const deepest = async (keys: PoolKey[]): Promise<DiscoveredPool | null> => {
    const read = await Promise.all(keys.map(async (key) => ({ key, ...(await state(key)) })));
    const live = read.filter((r) => r.sqrtPriceX96 > 0n && r.liquidity > 0n);
    if (!live.length) return null;
    live.sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0));
    const best = live[0]!;
    return { key: best.key, id: poolIdOf(best.key), sqrtPriceX96: best.sqrtPriceX96, liquidity: best.liquidity, hooked: best.key.hooks.toLowerCase() !== VENUE_POOL.hooks };
  };

  return {
    state,
    async find(token) {
      const k = token.toLowerCase();
      const hit = cache.get(k);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.pool;
      const common = COMMON_KEYS.map((c) => ({ currency0: NATIVE_ETH, currency1: token, ...c }));
      let pool = await deepest(common);
      if (!pool) {
        const found = await candidatesFromLogs(token);
        pool = found.length ? await deepest(found) : null;
      }
      cache.set(k, { at: Date.now(), pool });
      return pool;
    },
  };
};

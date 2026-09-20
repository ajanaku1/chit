/**
 * Which pool a token trades in. The pool manager is one contract for every
 * pool on the chain and anyone can open an ETH pool on it for any token,
 * at any price, for the price of one transaction: $CHIT alone has twenty
 * ETH pools on mainnet, one of them the launchpad's (fee 0, spacing 200,
 * the hook that takes its 2%) and the rest opened around it by strangers,
 * most with fees of eighty and ninety percent and a little liquidity, as
 * traps for a router that takes the first pool it meets. So there are two
 * answers here, and they are not the same thing:
 *
 *  - the record: the pools the chain's own records name, per chain
 *    (`RECORDED_POOLS`: $CHIT's on 4663 from deployments/buyback-4663.json,
 *    measured on the fork in docs/chit-buyback.md) and the ones the
 *    operator records in BOT_POOL_KEYS. A recorded token's pool is that
 *    one, read for its price and liquidity and never discovered; an empty
 *    recorded pool is no pool, not a reason to look for another. This is
 *    the only answer the bot can vouch for, and the copy desk moves a
 *    follower's money through a recorded pool only (bot-copy.ts).
 *  - discovery, for any other token: every ETH pool the chain has opened
 *    for it (the Initialize events over the whole chain in one query
 *    filtered by the token, which the public RPC answers in well under a
 *    second; a node that refuses the span gets the last `scanBlocks` in
 *    pieces instead) and the common hookless keys read straight from the
 *    pool manager's storage, all gathered before any is chosen, and the
 *    deepest live one wins. Deepest is a convenience for a card and a tap,
 *    not a proof: a narrow position holds a large liquidity number for
 *    little money, so a pool anyone opened can be the deepest, and the
 *    price a discovered pool shows is that pool's own. Nothing that reads a
 *    discovered pool may treat it as the token's pool in the sense the
 *    record means.
 *
 * A hooked pool is traded with empty hookData, which is what the hooks on
 * this chain expect from a plain swap (the CHIT pool's hook on mainnet
 * takes its 2% that way). A hook that refuses the swap makes the
 * transaction revert, which costs gas and nothing else; the caller's
 * minimum output stands either way.
 */

import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbi, parseAbiItem, type PublicClient } from "viem";

import { decodeSlot0, liquiditySlot, slot0Slot } from "./market.js";
import type { Address, Hex } from "./types.js";
import { NATIVE_ETH, VENUE_POOL, type PoolKey } from "./v4-swap.js";

const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const POOL_KEY_ABI = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] as const;

/** The keys read straight from storage beside the chain's record of openings: the venue's, then uniswap's usual tiers, all hookless. */
const COMMON_KEYS: ReadonlyArray<Pick<PoolKey, "fee" | "tickSpacing" | "hooks">> = [
  { fee: VENUE_POOL.fee, tickSpacing: VENUE_POOL.tickSpacing, hooks: VENUE_POOL.hooks },
  { fee: 500, tickSpacing: 10, hooks: VENUE_POOL.hooks },
  { fee: 10_000, tickSpacing: 200, hooks: VENUE_POOL.hooks },
  { fee: 100, tickSpacing: 1, hooks: VENUE_POOL.hooks },
];

/**
 * The pools the chain's own records name, per chain. 4663: $CHIT's, the
 * launchpad's pool the buyback buys through (deployments/buyback-4663.json,
 * id 0x84a4…9f41). The testnet has no record: its tokens are the fleet's
 * own seedings and are discovered.
 */
export const RECORDED_POOLS: Readonly<Record<number, readonly PoolKey[]>> = {
  4663: [{ currency0: NATIVE_ETH, currency1: "0xd523a627030509021cc39b6d7c8543417d3e50d8", fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" }],
};

/**
 * BOT_POOL_KEYS: the operator's additions to the record, one ETH pool per
 * entry as `token:fee:tickSpacing:hooks`, comma separated (an allowlisted
 * token's launch pool, say). Unset means the chain's record alone;
 * malformed is refused in the caller's words, because a pool recorded
 * wrong is a pool the desk would vouch for.
 */
export const recordedPoolsFromEnv = (refuse: (why: string) => never): PoolKey[] => {
  const raw = process.env.BOT_POOL_KEYS?.trim();
  if (!raw) return [];
  const out: PoolKey[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [token, fee, tickSpacing, hooks] = entry.split(":").map((p) => p.trim());
    if (!token || !isAddress(token) || !fee || !/^\d{1,7}$/.test(fee) || !tickSpacing || !/^\d{1,6}$/.test(tickSpacing) || Number(tickSpacing) === 0 || !hooks || !isAddress(hooks)) {
      return refuse("BOT_POOL_KEYS must be token:fee:tickSpacing:hooks entries, comma separated (each an ETH pool on the pool manager)");
    }
    out.push({ currency0: NATIVE_ETH, currency1: getAddress(token), fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: getAddress(hooks) });
  }
  return out;
};

/** How far back the pieced scan looks when the node refuses the whole chain in one query: a few days of either chain. */
const SCAN_BLOCKS = 2_000_000n;
const LOG_SPAN = 100_000n;
const CACHE_MS = 10 * 60_000;

export type DiscoveredPool = {
  key: PoolKey;
  id: Hex;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  hooked: boolean;
  /** True when the pool is the record's; false when it was discovered, and so is anyone's to have opened. */
  onRecord: boolean;
};

export const poolIdOf = (key: PoolKey): Hex =>
  keccak256(encodeAbiParameters(POOL_KEY_ABI, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

export type PoolRegistry = {
  /** The token's recorded pool, else its deepest discovered ETH pool, or null when it has none live; remembered for ten minutes. */
  find(token: Address): Promise<DiscoveredPool | null>;
  /** The pool's price and liquidity, read now, for a key already known. */
  state(key: PoolKey): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }>;
};

export type PoolRegistryOptions = {
  /** The chain, for its record; absent means no record but `recorded`. */
  chainId?: number;
  /** The operator's recorded pools (recordedPoolsFromEnv), added to the chain's. */
  recorded?: readonly PoolKey[];
  scanBlocks?: bigint;
};

export const createPoolRegistry = (publicClient: PublicClient, poolManager: Address, options: PoolRegistryOptions = {}): PoolRegistry => {
  const cache = new Map<string, { at: number; pool: DiscoveredPool | null }>();
  const scanBlocks = options.scanBlocks ?? SCAN_BLOCKS;
  /** The record by token: the chain's, then the operator's, which may replace an entry for the same token. */
  const record = new Map<string, PoolKey>();
  for (const key of [...(options.chainId !== undefined ? RECORDED_POOLS[options.chainId] ?? [] : []), ...(options.recorded ?? [])]) record.set(key.currency1.toLowerCase(), key);

  const state = async (key: PoolKey): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> => {
    const id = poolIdOf(key);
    const [slot0, liq] = await Promise.all([
      publicClient.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot0Slot(id)] }),
      publicClient.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [liquiditySlot(id)] }),
    ]);
    return { sqrtPriceX96: decodeSlot0(slot0).sqrtPriceX96, liquidity: BigInt(liq) & ((1n << 128n) - 1n) };
  };

  type Opened = { args: { fee?: number | undefined; tickSpacing?: number | undefined; hooks?: Address | undefined } };
  const keyOf = (token: Address, l: Opened): PoolKey =>
    ({ currency0: NATIVE_ETH, currency1: token, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: l.args.hooks as Address });

  /**
   * Every ETH pool opened for the token: the whole chain in one query (the
   * filter on the token keeps the answer small whatever the span), and when
   * the node refuses that, the last `scanBlocks` in pieces.
   */
  const candidatesFromLogs = async (token: Address): Promise<PoolKey[]> => {
    const head = await publicClient.getBlockNumber();
    const keys = new Map<string, PoolKey>();
    const add = (logs: Opened[]) => { for (const l of logs) { const key = keyOf(token, l); keys.set(poolIdOf(key), key); } };
    try {
      add(await publicClient.getLogs({ address: poolManager, event: INITIALIZE, args: { currency0: NATIVE_ETH, currency1: token }, fromBlock: 0n, toBlock: head }));
      return [...keys.values()];
    } catch {
      // The node would not take the span; the recent chain in pieces it will.
    }
    const floor = head > scanBlocks ? head - scanBlocks : 0n;
    for (let to = head; to > floor; to -= LOG_SPAN) {
      const from = to - LOG_SPAN + 1n > floor ? to - LOG_SPAN + 1n : floor;
      add(await publicClient.getLogs({ address: poolManager, event: INITIALIZE, args: { currency0: NATIVE_ETH, currency1: token }, fromBlock: from, toBlock: to }));
    }
    return [...keys.values()];
  };

  const deepest = async (keys: PoolKey[]): Promise<DiscoveredPool | null> => {
    const read = await Promise.all(keys.map(async (key) => ({ key, ...(await state(key)) })));
    const live = read.filter((r) => r.sqrtPriceX96 > 0n && r.liquidity > 0n);
    if (!live.length) return null;
    live.sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0));
    const best = live[0]!;
    return { key: best.key, id: poolIdOf(best.key), sqrtPriceX96: best.sqrtPriceX96, liquidity: best.liquidity, hooked: best.key.hooks.toLowerCase() !== VENUE_POOL.hooks, onRecord: false };
  };

  return {
    state,
    async find(token) {
      const k = token.toLowerCase();
      const hit = cache.get(k);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.pool;
      const recorded = record.get(k);
      let pool: DiscoveredPool | null;
      if (recorded) {
        // The record is the answer, live or not: an empty recorded pool is no pool, and nothing is looked for in its place.
        const live = await state(recorded);
        pool = live.sqrtPriceX96 > 0n && live.liquidity > 0n ? { key: recorded, id: poolIdOf(recorded), ...live, hooked: recorded.hooks.toLowerCase() !== VENUE_POOL.hooks, onRecord: true } : null;
      } else {
        // Every candidate before any choice: the chain's openings and the common keys, one entry per id.
        const keys = new Map<string, PoolKey>();
        for (const key of [...(await candidatesFromLogs(token)), ...COMMON_KEYS.map((c) => ({ currency0: NATIVE_ETH, currency1: token, ...c }))]) keys.set(poolIdOf(key), key);
        pool = await deepest([...keys.values()]);
      }
      cache.set(k, { at: Date.now(), pool });
      return pool;
    },
  };
};

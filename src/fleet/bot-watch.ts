/**
 * The chain watcher: every ETH buy on the venue, read from the pool
 * manager's own Swap logs, handed on once each. Nothing here trusts a feed,
 * a partner or a user: a buy is a log the chain wrote, the buyer is the
 * sender of the transaction that wrote it, the token is the pool's other
 * side as the Initialize event named it. What the watcher hands on (a
 * `VenueBuy`) is what the alerts post (bot-alerts.ts) and what a leader
 * watch may act on (the leaders' own handler, through
 * bot-watch-runtime.ts); the watcher itself sends nothing anywhere.
 *
 * A cursor per chain says up to which block every buy has been handed on.
 * One run moves it by at most `maxBlocksPerRun` (600 by default, about
 * what the chain writes between two five-minute crons at its quiet pace),
 * so a watcher that fell behind catches up in steps the public RPC will
 * answer rather than one query it refuses. Each transaction hash is marked
 * seen before its handler is called, and the cursor is written after the
 * whole window: a run the host kills mid-way scans the same window again
 * and finds the marks, so a buy is never announced twice, and one that was
 * marked but whose handler was cut off is lost rather than repeated. A
 * handler that throws is caught and logged; the run goes on to the next
 * buy, because one odd token must not stop the feed.
 *
 * What counts as a buy: a Swap in a pool whose currency0 is native ETH,
 * where amount0 is negative (the swapper paid ETH; v4 deltas are from the
 * swapper's side) and amount1 positive (tokens came out). A sell in the
 * same pool has the signs the other way and is ignored. A pool whose key
 * the watcher cannot name (no Initialize event found for its id) is
 * skipped, never guessed; two swaps of one transaction in one pool are one
 * buy, summed.
 *
 * The public RPC is treated as api/burn.js treats it: one call at a time,
 * log queries in spans it tolerates, a 429 waited out and tried again.
 */

import { createPublicClient, defineChain, http, parseAbiItem, type Address, type Hex, type PublicClient, type Transport } from "viem";
import type { PoolRegistry } from "./pool-registry.js";

export type VenueBuy = { block: bigint; txHash: Hex; buyer: Address; token: Address; ethInWei: bigint; tokensOut: bigint; poolId: Hex };

export interface WatchStore {
  cursor(chainId: number): Promise<bigint | undefined>;
  setCursor(chainId: number, block: bigint): Promise<void>;
  seen(txHash: Hex): Promise<boolean>;
  markSeen(txHash: Hex, at: Date): Promise<void>;
}

export type WatchPort = {
  latestBlock(): Promise<bigint>;
  /** Every ETH-in buy in [from, to], one per transaction and pool, the buyer resolved. */
  buysBetween(from: bigint, to: bigint): Promise<VenueBuy[]>;
};

export type WatcherDeps = {
  port: WatchPort;
  store: WatchStore;
  chainId: number;
  /** How far the cursor moves in one run at most; default 600 blocks. */
  maxBlocksPerRun?: number;
  now?: () => Date;
  onBuy: (b: VenueBuy) => Promise<void>;
};

export type WatchRun = { from: bigint; to: bigint; buys: number; delivered: number };

export const DEFAULT_BLOCKS_PER_RUN = 600;

export class Watcher {
  readonly #d: WatcherDeps;
  constructor(d: WatcherDeps) { this.#d = d; }

  /**
   * One pass: the window after the cursor, at most `maxBlocksPerRun` wide;
   * the buys in it, each unseen hash marked and handed on once; then the
   * cursor. A first run with no cursor starts at the head, so turning the
   * watcher on never replays the chain's past into the group.
   */
  async run(): Promise<WatchRun> {
    const max = BigInt(this.#d.maxBlocksPerRun ?? DEFAULT_BLOCKS_PER_RUN);
    const head = await this.#d.port.latestBlock();
    const cursor = await this.#d.store.cursor(this.#d.chainId);
    const from = cursor === undefined ? head : cursor + 1n;
    if (from > head) return { from, to: head, buys: 0, delivered: 0 };
    const to = from + max - 1n < head ? from + max - 1n : head;
    const buys = await this.#d.port.buysBetween(from, to);
    let delivered = 0;
    for (const b of onePerTransaction(buys)) {
      if (await this.#d.store.seen(b.txHash)) continue;
      // Marked before the handler runs: a run killed inside the handler loses this one buy instead of announcing it twice on the next pass.
      await this.#d.store.markSeen(b.txHash, this.#d.now ? this.#d.now() : new Date());
      try {
        await this.#d.onBuy(b);
        delivered += 1;
      } catch (error) {
        console.error(`bot watch: buy ${b.txHash} not handled: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
    await this.#d.store.setCursor(this.#d.chainId, to);
    return { from, to, buys: buys.length, delivered };
  }
}

/** One buy per transaction, the largest by ETH when a transaction bought in several pools; in block order, then as the port listed them. */
export const onePerTransaction = (buys: VenueBuy[]): VenueBuy[] => {
  const byHash = new Map<string, VenueBuy>();
  for (const b of buys) {
    const have = byHash.get(b.txHash);
    if (!have || b.ethInWei > have.ethInWei) byHash.set(b.txHash, b);
  }
  return [...byHash.values()].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
};

// ---------- the stores ----------

/** One instance's memory: tests and one machine. */
export class MemoryWatchStore implements WatchStore {
  readonly cursors = new Map<number, bigint>();
  readonly seenAt = new Map<string, string>();
  async cursor(chainId: number) { return this.cursors.get(chainId); }
  async setCursor(chainId: number, block: bigint) { this.cursors.set(chainId, block); }
  async seen(txHash: Hex) { return this.seenAt.has(txHash.toLowerCase()); }
  async markSeen(txHash: Hex, at: Date) { this.seenAt.set(txHash.toLowerCase(), at.toISOString()); }
}

type Row = Record<string, unknown>;
export type WatchSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_watch_cursor (chain_id INTEGER PRIMARY KEY, block NUMERIC(20,0) NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_watch_seen (tx_hash TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL)`,
];

/** Neon, shared by every instance; a hash is seen by all of them once one marked it. Rows older than seven days go each time the cursor is written, once a run. */
export class NeonWatchStore implements WatchStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: WatchSql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async cursor(chainId: number) {
    await this.#init();
    const [r] = await this.sql.query(`SELECT block FROM bot_watch_cursor WHERE chain_id = $1`, [chainId]);
    return r ? BigInt(String(r.block)) : undefined;
  }
  async setCursor(chainId: number, block: bigint) {
    await this.#init();
    await this.sql.query(`INSERT INTO bot_watch_cursor (chain_id, block, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (chain_id) DO UPDATE SET block = EXCLUDED.block, updated_at = NOW()`, [chainId, block.toString()]);
    // The chain never hands the same hash back a week later; a table that only grows is not wanted on a cron.
    await this.sql.query(`DELETE FROM bot_watch_seen WHERE seen_at < NOW() - INTERVAL '7 days'`).catch(() => undefined);
  }
  async seen(txHash: Hex) {
    await this.#init();
    const rows = await this.sql.query(`SELECT 1 FROM bot_watch_seen WHERE tx_hash = $1`, [txHash.toLowerCase()]);
    return rows.length > 0;
  }
  async markSeen(txHash: Hex, at: Date) {
    await this.#init();
    await this.sql.query(`INSERT INTO bot_watch_seen (tx_hash, seen_at) VALUES ($1, $2) ON CONFLICT (tx_hash) DO NOTHING`, [txHash.toLowerCase(), at.toISOString()]);
  }
}

// ---------- the port ----------

/** Uniswap v4 PoolManager: a swap, and a pool's opening (the one place the id meets its key). */
const SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** One log query covers at most this many blocks, the span the public RPC answers (bot-chain.ts). */
const LOG_SPAN = 100_000n;
/** How far back an unknown pool id is looked for in the Initialize events: about a week of the chain. */
const DEFAULT_LOOKBACK = 2_000_000n;

export type WatchPortConfig = {
  chainId: number;
  rpcUrl: string;
  poolManager: Address;
  /** The bot's registry (bot-chain.ts, pool-registry.ts): names the pools of `tokens` before any log is read. */
  registry?: PoolRegistry;
  /** Tokens whose pools are worth knowing from the start: the venue token, the allowlist. */
  tokens?: Address[];
  /** A transport of the caller's own (a scripted one in tests); default is HTTP to rpcUrl with a 429 waited out. */
  transport?: Transport;
  /** Blocks searched backwards for the Initialize event of a pool the watcher meets for the first time. */
  initLookbackBlocks?: bigint;
};

/** The one decision a Swap log leaves: an ETH-in buy (the swapper paid ETH, tokens came out) or not. */
export const isEthInBuy = (amount0: bigint, amount1: bigint): boolean => amount0 < 0n && amount1 > 0n;

export const createWatchPort = (config: WatchPortConfig): WatchPort => {
  const chain = defineChain({
    id: config.chainId,
    name: config.chainId === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  // viem waits and retries a 429 on its own (600 ms doubling); the calls below are made one at a time so a run never bursts.
  const transport = config.transport ?? http(config.rpcUrl, { retryCount: 4, retryDelay: 600, timeout: 20_000 });
  const client = createPublicClient({ chain, transport }) as unknown as PublicClient;
  const lookback = config.initLookbackBlocks ?? DEFAULT_LOOKBACK;
  /** Pool id to token (lowercase, as the bot keys everything); null is a pool looked for and not found, or one that is not an ETH pool, and is not asked again. */
  const pools = new Map<string, Address | null>();
  const lower = (a: Address): Address => a.toLowerCase() as Address;
  /** The sender of a transaction never changes; remembered for the instance, bounded. */
  const senders = new Map<string, Address>();
  let seeded = false;

  const seed = async (): Promise<void> => {
    if (seeded) return;
    seeded = true;
    if (!config.registry || !config.tokens?.length) return;
    for (const token of config.tokens) {
      const found = await config.registry.find(token).catch(() => null);
      if (found) pools.set(found.id.toLowerCase(), lower(token));
    }
  };

  const spans = (from: bigint, to: bigint): Array<[bigint, bigint]> => {
    const out: Array<[bigint, bigint]> = [];
    for (let start = from; start <= to; start += LOG_SPAN) out.push([start, start + LOG_SPAN - 1n < to ? start + LOG_SPAN - 1n : to]);
    return out;
  };

  /** Pools opened in the window are known before their first swap is read. */
  const learnOpened = async (from: bigint, to: bigint): Promise<void> => {
    for (const [a, b] of spans(from, to)) {
      const logs = await client.getLogs({ address: config.poolManager, event: INITIALIZE, args: { currency0: NATIVE }, fromBlock: a, toBlock: b });
      for (const l of logs) if (l.args.id && l.args.currency1) pools.set(l.args.id.toLowerCase(), lower(l.args.currency1 as Address));
    }
  };

  /** The ids not yet named: their Initialize events, looked for backwards from the window in spans, stopping when every one is found. */
  const learnUnknown = async (ids: Hex[], before: bigint): Promise<void> => {
    const missing = new Set(ids.map((i) => i.toLowerCase()));
    if (!missing.size) return;
    const floor = before > lookback ? before - lookback : 0n;
    for (let to = before; to >= floor && missing.size; to -= LOG_SPAN) {
      const from = to - LOG_SPAN + 1n > floor ? to - LOG_SPAN + 1n : floor;
      const logs = await client.getLogs({ address: config.poolManager, event: INITIALIZE, args: { id: [...missing] as Hex[] }, fromBlock: from, toBlock: to });
      for (const l of logs) {
        if (!l.args.id) continue;
        const id = l.args.id.toLowerCase();
        // Not an ETH pool: named, so it is not asked again, and never a buy.
        pools.set(id, lower(l.args.currency0 as Address) === NATIVE ? lower(l.args.currency1 as Address) : null);
        missing.delete(id);
      }
      if (from === 0n) break;
    }
    for (const id of missing) pools.set(id, null);
  };

  const senderOf = async (hash: Hex): Promise<Address> => {
    const key = hash.toLowerCase();
    const have = senders.get(key);
    if (have) return have;
    const tx = await client.getTransaction({ hash });
    if (senders.size > 5_000) senders.clear();
    senders.set(key, tx.from);
    return tx.from;
  };

  return {
    latestBlock: () => client.getBlockNumber(),
    async buysBetween(from, to) {
      await seed();
      await learnOpened(from, to);
      // One entry per transaction and pool, the amounts summed; the order is the chain's.
      const found = new Map<string, { block: bigint; txHash: Hex; poolId: Hex; ethInWei: bigint; tokensOut: bigint }>();
      for (const [a, b] of spans(from, to)) {
        const logs = await client.getLogs({ address: config.poolManager, event: SWAP, fromBlock: a, toBlock: b });
        for (const l of logs) {
          const { id, amount0, amount1 } = l.args;
          if (!id || amount0 === undefined || amount1 === undefined || !l.transactionHash || l.blockNumber === null) continue;
          if (!isEthInBuy(amount0, amount1)) continue;
          const key = `${l.transactionHash.toLowerCase()}|${id.toLowerCase()}`;
          const have = found.get(key);
          if (have) { have.ethInWei += -amount0; have.tokensOut += amount1; }
          else found.set(key, { block: l.blockNumber, txHash: l.transactionHash, poolId: id, ethInWei: -amount0, tokensOut: amount1 });
        }
      }
      if (!found.size) return [];
      const unknown = [...new Set([...found.values()].map((f) => f.poolId.toLowerCase()))].filter((id) => !pools.has(id)) as Hex[];
      await learnUnknown(unknown, from > 0n ? from - 1n : 0n);
      const buys: VenueBuy[] = [];
      for (const f of found.values()) {
        const token = pools.get(f.poolId.toLowerCase());
        if (!token) continue;
        buys.push({ block: f.block, txHash: f.txHash, buyer: await senderOf(f.txHash), token, ethInWei: f.ethInWei, tokensOut: f.tokensOut, poolId: f.poolId });
      }
      return buys;
    },
  };
};

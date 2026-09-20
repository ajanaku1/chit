/**
 * The chain watcher: every ETH buy of the tokens this bot names, read from
 * the pool manager's own Swap logs, handed on once each. Nothing here
 * trusts a feed, a partner or a user: a buy is a log the chain wrote, the
 * buyer is the sender of the transaction that wrote it, the token is the
 * pool's other side as the Initialize event named it. What the watcher
 * hands on (a `VenueBuy`) is what the alerts post (bot-alerts.ts) and what
 * a leader watch may act on (the leaders' own handler, through
 * bot-watch-runtime.ts); the watcher itself sends nothing anywhere.
 *
 * Which pools count: the pool manager is one contract for every pool on
 * the chain, and anyone can open an ETH pool on it, seed it and swap into
 * it every block for the price of gas. A watcher that took every ETH pool
 * for the venue would be that person's channel into the group. So the
 * port is given the tokens it watches (the venue token and the allowlist)
 * and names their pools up front through the bot's own registry (the
 * deepest pool of each, however old); a pool of any other token, opened in
 * the window or found by the id lookup, is remembered as not ours and its
 * swaps are never a buy. A transaction the bot's own signer sent is not a
 * buy either: the copy desk already posted a leader's tapped buy when it
 * happened, a mirror or an order's fill is the bot's own doing, and a
 * user's buy through the bot is theirs, not the feed's.
 *
 * A cursor per chain says up to which block every buy has been handed on.
 * One run moves it by at most `maxBlocksPerRun` (600 by default, about
 * what the chain writes between two five-minute crons at its quiet pace),
 * so a watcher that fell behind catches up in steps the public RPC will
 * answer rather than one query it refuses. Each transaction hash is claimed
 * in the store before its handler is called, in one statement that says
 * whether this run was the first to mark it, and the cursor is written
 * after the whole window: a run the host kills mid-way scans the same
 * window again and finds the marks, and two runs over one window at the
 * same time (a slow pass still going when the next cron lands on another
 * instance) split the buys between them instead of each announcing all of
 * them. A buy is never announced twice; one that was marked but whose
 * handler was cut off is lost rather than repeated. A handler that throws
 * is caught and logged; the run goes on to the next buy, because one odd
 * token must not stop the feed.
 *
 * What counts as a buy: what a transaction left bought. Every Swap of one
 * transaction in the pools of one watched token is summed with its sign
 * (v4 deltas are from the swapper's side: amount0 negative is ETH paid,
 * positive is ETH taken back; amount1 the other way for the token), and
 * the transaction is a buy of that token when the sum paid ETH and took
 * tokens. A sell alone has the signs the other way and is nothing; a buy
 * and a sell in one transaction net to what stayed bought, so a round trip
 * through a contract is not a buy at all, and one that sold part of what
 * it bought is a buy of the rest. The buy's pool is the one the most ETH
 * went into. A pool whose key the watcher cannot name (no Initialize event
 * found for its id) is skipped, never guessed.
 *
 * The public RPC is treated as api/burn.js treats it: one call at a time,
 * log queries in spans it tolerates, a 429 waited out and tried again.
 */

import { createPublicClient, defineChain, http, parseAbiItem, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { createPoolRegistry, type PoolRegistry } from "./pool-registry.js";
import type { PoolKey } from "./v4-swap.js";

export type VenueBuy = { block: bigint; txHash: Hex; buyer: Address; token: Address; ethInWei: bigint; tokensOut: bigint; poolId: Hex };

export interface WatchStore {
  cursor(chainId: number): Promise<bigint | undefined>;
  setCursor(chainId: number, block: bigint): Promise<void>;
  seen(txHash: Hex): Promise<boolean>;
  /**
   * Marks the hash seen and says whether this call was the one that did:
   * false when it was already marked. One statement, never a read and then
   * a write, so two runs over the same window cannot both get true.
   */
  claim(txHash: Hex, at: Date): Promise<boolean>;
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
   * the buys in it, each hash claimed and handed on once; then the cursor.
   * A first run with no cursor starts at the head, so turning the watcher
   * on never replays the chain's past into the group.
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
      // Claimed before the handler runs, in one statement: a run killed inside the handler loses this one buy instead of announcing it twice on the next pass, and a second run over the same window on another instance loses the claim and skips it.
      if (!(await this.#d.store.claim(b.txHash, this.#d.now ? this.#d.now() : new Date()))) continue;
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
  async claim(txHash: Hex, at: Date) {
    // The check and the write in one turn, nothing awaited between them: the memory store's one statement.
    const key = txHash.toLowerCase();
    if (this.seenAt.has(key)) return false;
    this.seenAt.set(key, at.toISOString());
    return true;
  }
}

type Row = Record<string, unknown>;
export type WatchSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_watch_cursor (chain_id INTEGER PRIMARY KEY, block NUMERIC(20,0) NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_watch_seen (tx_hash TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL)`,
];

/** Neon, shared by every instance; a hash is seen by all of them once one claimed it, and the claim is the insert itself, so two instances cannot both win it. Rows older than seven days go each time the cursor is written, once a run. */
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
  async claim(txHash: Hex, at: Date) {
    await this.#init();
    // RETURNING is the answer: a row back is this call's mark, none means another run's insert got there first and this one changed nothing.
    const rows = await this.sql.query(`INSERT INTO bot_watch_seen (tx_hash, seen_at) VALUES ($1, $2) ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash`, [txHash.toLowerCase(), at.toISOString()]);
    return rows.length === 1;
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
  /** The tokens whose pools are watched: the venue token and the allowlist. A swap in any other pool is not a buy here, whoever made it. */
  tokens: Address[];
  /** Names each token's pool before any log is read, however old the pool is (pool-registry.ts: the record's, else the deepest); default is a registry over this port's own client. */
  registry?: PoolRegistry;
  /** The operator's recorded pools (BOT_POOL_KEYS), for the default registry beside the chain's own record. */
  recordedPools?: PoolKey[];
  /** Addresses whose transactions are the bot's own (its signer): a swap they sent is not handed on. */
  ownSenders?: Address[];
  /** A transport of the caller's own (a scripted one in tests); default is HTTP to rpcUrl with a 429 waited out. */
  transport?: Transport;
  /** Blocks searched backwards for the Initialize event of a pool the watcher meets for the first time. */
  initLookbackBlocks?: bigint;
};

/** The one decision a transaction's summed deltas leave: an ETH-in buy (the swapper paid ETH, tokens came out) or not. One Swap log alone reads the same way. */
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
  const lower = (a: Address): Address => a.toLowerCase() as Address;
  /** The tokens this port is for; a pool of any other is remembered as not ours. */
  const watched = new Set<string>(config.tokens.map(lower));
  /** The bot's own senders; a buy they sent is the bot's doing and is not a buy here. */
  const own = new Set<string>((config.ownSenders ?? []).map(lower));
  const registry = config.registry ?? createPoolRegistry(client, config.poolManager, { chainId: config.chainId, ...(config.recordedPools ? { recorded: config.recordedPools } : {}) });
  /** Pool id to token (lowercase, as the bot keys everything); null is a pool looked for and not found, one that is not an ETH pool, or one of a token not watched, and is not asked again. */
  const pools = new Map<string, Address | null>();
  /** What an Initialize log names, as this port keeps it: the token when it is an ETH pool of a watched token, else nothing. */
  const ours = (currency0: Address, currency1: Address): Address | null => (lower(currency0) === NATIVE && watched.has(lower(currency1)) ? lower(currency1) : null);
  /** The sender of a transaction never changes; remembered for the instance, bounded. */
  const senders = new Map<string, Address>();
  let seeded: Promise<void> | undefined;

  /**
   * The watched tokens' pools, named through the registry before the first
   * log is read: the deepest pool of each, found by the registry's storage
   * reads or its own scan, so a pool older than the lookback below (the
   * venue's own is) is known from the start. A token the registry cannot
   * place gets its pools from the lookback when its first swap is met, or
   * stays unknown; a registry that throws fails the pass, and the next one
   * seeds again.
   */
  const seed = (): Promise<void> => (seeded ??= (async () => {
    for (const token of config.tokens) {
      const found = await registry.find(token);
      if (found) pools.set(found.id.toLowerCase(), lower(token));
    }
  })().catch((e) => { seeded = undefined; throw e; }));

  const spans = (from: bigint, to: bigint): Array<[bigint, bigint]> => {
    const out: Array<[bigint, bigint]> = [];
    for (let start = from; start <= to; start += LOG_SPAN) out.push([start, start + LOG_SPAN - 1n < to ? start + LOG_SPAN - 1n : to]);
    return out;
  };

  /** Pools opened in the window are known before their first swap is read: a watched token's by name, any other as not ours, so it is never looked up. */
  const learnOpened = async (from: bigint, to: bigint): Promise<void> => {
    for (const [a, b] of spans(from, to)) {
      const logs = await client.getLogs({ address: config.poolManager, event: INITIALIZE, args: { currency0: NATIVE }, fromBlock: a, toBlock: b });
      for (const l of logs) if (l.args.id && l.args.currency1) pools.set(l.args.id.toLowerCase(), ours(NATIVE, l.args.currency1 as Address));
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
        // Not an ETH pool, or not a watched token's: named as not ours, so it is not asked again, and never a buy.
        pools.set(id, ours(l.args.currency0 as Address, l.args.currency1 as Address));
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
      // One entry per transaction and pool, every swap's deltas summed with their signs (ETH paid is positive here, ETH taken back negative); the order is the chain's.
      const found = new Map<string, { block: bigint; txHash: Hex; poolId: Hex; ethInWei: bigint; tokensOut: bigint }>();
      for (const [a, b] of spans(from, to)) {
        const logs = await client.getLogs({ address: config.poolManager, event: SWAP, fromBlock: a, toBlock: b });
        for (const l of logs) {
          const { id, amount0, amount1 } = l.args;
          if (!id || amount0 === undefined || amount1 === undefined || !l.transactionHash || l.blockNumber === null) continue;
          const key = `${l.transactionHash.toLowerCase()}|${id.toLowerCase()}`;
          const have = found.get(key);
          if (have) { have.ethInWei += -amount0; have.tokensOut += amount1; }
          else found.set(key, { block: l.blockNumber, txHash: l.transactionHash, poolId: id, ethInWei: -amount0, tokensOut: amount1 });
        }
      }
      if (!found.size) return [];
      const unknown = [...new Set([...found.values()].map((f) => f.poolId.toLowerCase()))].filter((id) => !pools.has(id)) as Hex[];
      await learnUnknown(unknown, from > 0n ? from - 1n : 0n);
      // Then one entry per transaction and watched token, its pools' sums added: what the transaction left bought of the token, and the pool most of the ETH went into.
      const net = new Map<string, { block: bigint; txHash: Hex; token: Address; ethInWei: bigint; tokensOut: bigint; poolId: Hex; poolEth: bigint }>();
      for (const f of found.values()) {
        const token = pools.get(f.poolId.toLowerCase());
        if (!token) continue;
        const key = `${f.txHash.toLowerCase()}|${token}`;
        const have = net.get(key);
        if (!have) { net.set(key, { block: f.block, txHash: f.txHash, token, ethInWei: f.ethInWei, tokensOut: f.tokensOut, poolId: f.poolId, poolEth: f.ethInWei }); continue; }
        have.ethInWei += f.ethInWei;
        have.tokensOut += f.tokensOut;
        if (f.ethInWei > have.poolEth) { have.poolId = f.poolId; have.poolEth = f.ethInWei; }
      }
      const buys: VenueBuy[] = [];
      for (const n of net.values()) {
        // A sell, or a buy and a sell that net to nothing, is not a buy: the leader-buys-follower-buys premise needs something to have stayed bought.
        if (!isEthInBuy(-n.ethInWei, n.tokensOut)) continue;
        const buyer = await senderOf(n.txHash);
        // The bot's own transaction: a leader's tapped buy the desk already posted, a mirror, an order's fill, or a user's buy that is theirs alone.
        if (own.has(lower(buyer))) continue;
        buys.push({ block: n.block, txHash: n.txHash, buyer, token: n.token, ethInWei: n.ethInWei, tokensOut: n.tokensOut, poolId: n.poolId });
      }
      return buys;
    },
  };
};

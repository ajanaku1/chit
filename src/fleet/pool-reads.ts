/**
 * Reading the pool's two lists without a round trip per entry.
 *
 * `_campaigns` and `_queueIds` only grow, and every balance, activation,
 * withdrawal, trade and sweep reads both. One awaited call per entry made each
 * of those cost 2N + M round trips, against an RPC that drops requests under a
 * burst, inside a function with a time limit; and a sweep that cannot finish
 * reading is a sweep that posts nothing. Here the entries come back through
 * Multicall3, in chunks, so the number of round trips does not depend on how
 * much history there is.
 *
 * The queue, which grows by one per buy, is also not read from the start every
 * time. A charge whose POST_WINDOW has closed is final: posted it stays posted,
 * unposted it can never be posted again. Finality therefore follows from the
 * contract and from chain time, not from how recently something was seen, and
 * because `queuedAt` never decreases along the list, the final entries are
 * always an unbroken run from index zero. So all that is remembered is a mark
 * (every index below it is final) and the final entries that were never
 * posted, which still count against their depositor and which the sweep still
 * reports. Posted final entries are of no use to anything and are not kept.
 *
 * What is kept is what the chain published, the sealed depositor included, and
 * never the depositor it opens to. A table of opened depositors would be the
 * link the pool exists to withhold, in a database; opening 48 bytes again costs
 * microseconds.
 */

import { parseAbi, type Address, type Hex, type PublicClient } from "viem";

import type { PoolDraw, PoolQueued } from "./chain-pool.js";

/** Multicall3's address on every chain that has it; 46630 and 4663 do (checked 2026-09-20). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/** Entries per eth_call. Bounds what one call has to carry: about 70 KB back for a full chunk of charges. */
export const READ_CHUNK = 200;

/**
 * How long past the close of its window a charge waits before it is called
 * final. The window closing is what makes it immutable; the margin is for a
 * node that is a little behind, or a block that is reorganised.
 */
export const FINALITY_MARGIN_SECONDS = 600;

/**
 * The reads, and only the reads. Hand-written, so
 * test/fleet/pool-reads.test.ts compares it with the compiled pool: a struct
 * that gains a field has to fail there, not decode wrong here.
 */
export const READS_ABI = parseAbi([
  "function POST_WINDOW() view returns (uint64)",
  "function campaignCount() view returns (uint256)",
  "function campaignAt(uint256 index) view returns (bytes32)",
  "function drawOf(bytes32 campaign) view returns ((uint256 amount, uint256 spent, uint256 reserved, uint256 principalOut, uint64 dueAt, bytes ownerRef, uint8 state))",
  "function queuedSpendCount() view returns (uint256)",
  "function queuedSpendAt(uint256 index) view returns (bytes32 id, (bytes encDepositor, uint256 amount, uint64 dueAt, uint64 queuedAt, bool posted) entry)",
]);

/** DrawState.None in the contract: a campaign key with no draw behind it. */
const DRAW_NONE = 0;

/** A final charge that was never posted, with its place in the queue. */
export type ExpiredCharge = { index: number; entry: PoolQueued };

/** Every index below `cursor` is final; `expired` are the final ones that were never posted. */
export type QueueMark = { cursor: number; expired: ExpiredCharge[] };

/**
 * Where the mark is kept between instances. `advance` only ever moves forward
 * and is safe to repeat: two instances reading the same chain say the same
 * thing, in either order.
 */
export type PoolReadCache = {
  load(key: string): Promise<QueueMark | undefined>;
  advance(key: string, cursor: number, expired: readonly ExpiredCharge[]): Promise<void>;
};

export const createMemoryReadCache = (): PoolReadCache => {
  const marks = new Map<string, { cursor: number; expired: Map<number, PoolQueued> }>();
  return {
    async load(key) {
      const mark = marks.get(key);
      if (!mark) return undefined;
      return { cursor: mark.cursor, expired: [...mark.expired].sort(([a], [b]) => a - b).map(([index, entry]) => ({ index, entry })) };
    },
    async advance(key, cursor, expired) {
      const mark = marks.get(key) ?? { cursor: 0, expired: new Map<number, PoolQueued>() };
      mark.cursor = Math.max(mark.cursor, cursor);
      for (const { index, entry } of expired) if (!mark.expired.has(index)) mark.expired.set(index, entry);
      marks.set(key, mark);
    },
  };
};

export type PoolReads = {
  draws(): Promise<PoolDraw[]>;
  queued(): Promise<PoolQueued[]>;
};

type Call = { functionName: string; args?: readonly unknown[] };
type RawDraw = { amount: bigint; spent: bigint; reserved: bigint; principalOut: bigint; dueAt: bigint; ownerRef: Hex; state: number };
type RawQueued = { encDepositor: Hex; amount: bigint; dueAt: bigint; queuedAt: bigint; posted: boolean };

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

export const createPoolReads = (
  publicClient: PublicClient,
  address: Address,
  options: { cache?: PoolReadCache } = {},
): PoolReads => {
  const cache = options.cache ?? createMemoryReadCache();
  const key = `${publicClient.chain?.id ?? "unknown"}:${address.toLowerCase()}`;

  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    publicClient.readContract({ address, abi: READS_ABI, functionName, args } as never) as Promise<T>;

  /**
   * The deployed Multicall3 where there is one; viem's deployless form of it
   * where there is not, which needs nothing on the chain (the local chain the
   * pool suites run on has none). Asked once per adapter.
   */
  let how: "deployed" | "deployless" | "single" | undefined;
  const mode = async (): Promise<"deployed" | "deployless" | "single"> => {
    if (how) return how;
    if (typeof (publicClient as { multicall?: unknown }).multicall !== "function") return (how = "single");
    try {
      const code = await publicClient.getCode({ address: MULTICALL3 });
      return (how = code && code !== "0x" ? "deployed" : "deployless");
    } catch {
      return "deployless"; // the RPC's bad moment, not an answer: ask again next time
    }
  };

  /** Many reads of this pool in as few eth_calls as READ_CHUNK allows, all sent together. */
  const readMany = async <T>(calls: readonly Call[]): Promise<T[]> => {
    if (calls.length === 0) return [];
    const via = await mode();
    const chunks: Call[][] = [];
    for (let i = 0; i < calls.length; i += READ_CHUNK) chunks.push(calls.slice(i, i + READ_CHUNK));
    const answers = await Promise.all(chunks.map((chunk) =>
      via === "single"
        ? Promise.all(chunk.map((call) => read<T>(call.functionName, call.args)))
        : (publicClient.multicall({
            contracts: chunk.map((call) => ({ address, abi: READS_ABI, functionName: call.functionName, args: call.args ?? [] })),
            allowFailure: false,
            // The chunk is already the size one call should carry; viem's default would split it again by bytes.
            batchSize: 1_000_000,
            ...(via === "deployed" ? { multicallAddress: MULTICALL3 } : { deployless: true }),
          } as never) as Promise<T[]>)));
    return answers.flat();
  };

  let postWindow: bigint | undefined;
  const windowSeconds = async (): Promise<bigint> => (postWindow ??= BigInt(await read<bigint | number>("POST_WINDOW")));

  /** What this instance has seen, so a cache that is down costs a longer read and not a wrong one. */
  let local: QueueMark | undefined;
  let warnedShorter = false;

  const markFor = async (count: number): Promise<QueueMark> => {
    let mark = local;
    if (!mark) {
      try {
        mark = await cache.load(key);
      } catch (error) {
        console.warn(`pool reads: the queue mark could not be loaded, reading from the start: ${firstLine(error)}`);
      }
    }
    mark ??= { cursor: 0, expired: [] };
    if (mark.cursor > count) {
      // The chain is shorter than what was remembered: a fork that was reset, or a key that is not this pool's.
      if (!warnedShorter) console.warn(`pool reads: the queue holds ${count} entries and the mark says ${mark.cursor}; forgetting the mark`);
      warnedShorter = true;
      mark = { cursor: 0, expired: [] };
    }
    return mark;
  };

  return {
    async draws() {
      const count = Number(await read<bigint>("campaignCount"));
      const campaigns = await readMany<Hex>(Array.from({ length: count }, (_, i) => ({ functionName: "campaignAt", args: [BigInt(i)] })));
      const raws = await readMany<RawDraw>(campaigns.map((campaign) => ({ functionName: "drawOf", args: [campaign] })));
      return campaigns
        .map((campaign, i) => ({ campaign, ...(raws[i] as RawDraw) }))
        .filter((draw) => draw.state !== DRAW_NONE);
    },

    async queued() {
      const [block, total, window] = await Promise.all([publicClient.getBlock(), read<bigint>("queuedSpendCount"), windowSeconds()]);
      const count = Number(total);
      const mark = await markFor(count);

      const raws = await readMany<readonly [Hex, RawQueued]>(
        Array.from({ length: count - mark.cursor }, (_, i) => ({ functionName: "queuedSpendAt", args: [BigInt(mark.cursor + i)] })),
      );
      const fresh: PoolQueued[] = raws.map(([id, entry]) => ({ id, ...entry }));

      // The mark moves over the unbroken run of entries whose window closed long enough ago.
      let cursor = mark.cursor;
      const newlyExpired: ExpiredCharge[] = [];
      for (const entry of fresh) {
        if (block.timestamp <= entry.queuedAt + window + BigInt(FINALITY_MARGIN_SECONDS)) break;
        if (!entry.posted) newlyExpired.push({ index: cursor, entry });
        cursor += 1;
      }
      if (cursor > mark.cursor) {
        local = { cursor, expired: [...mark.expired, ...newlyExpired] };
        try {
          await cache.advance(key, cursor, newlyExpired);
        } catch (error) {
          console.warn(`pool reads: the queue mark could not be saved; this instance keeps it: ${firstLine(error)}`);
        }
      } else {
        local = mark;
      }

      return [...mark.expired.map((expired) => expired.entry), ...fresh];
    },
  };
};

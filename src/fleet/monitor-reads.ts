/**
 * How the outside monitor reads the pool.
 *
 * Everything is read at one block: the run picks a block once and pins every
 * eth_call to it, so the pool's balance and the counters it is compared with
 * are the same instant, and a deposit that lands mid-run cannot look like
 * money gone missing. The reads go through Multicall3, a chunk at a time, so
 * the round trips do not grow with the queue.
 *
 * The block is a little behind the tip, not the tip. The public RPC answers
 * from several nodes, and one that has not seen the newest block yet refuses
 * a call pinned to it ("unsupported block number": one call in four, measured
 * on the monitor's first live run). It also keeps state for about 20,000
 * blocks only, which is an hour and a half: a run is seconds, so that is room.
 *
 * This file runs on plain node with nothing installed (see monitor-cli.ts), so
 * it imports no package and carries its own ABI coding for the few shapes it
 * needs. test/fleet/monitor-reads.test.ts holds that coding against viem, and
 * the selectors against the compiled pool.
 *
 * The sealed depositor inside a queue entry is skipped, not decoded: the
 * monitor has no key for it and no use for it.
 */
import type { Address, Hex } from "viem";

import type { DrawSeen, PoolSnapshot, QueuedCharge } from "./monitor.js";

/** One JSON-RPC call; the transport (and its retries) is the caller's. */
export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type Call = { target: Address; allowFailure: boolean; callData: Hex };

/** The same address on 46630 and 4663, checked on 19 September 2026. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const READ_CHUNK = 200;
/** About six seconds on 46630 and two on 4663. A monitor has no use for the last few seconds. */
export const BLOCKS_BEHIND = 20n;
const PARALLEL = 4; // the public RPC drops requests under a burst

export const SELECTORS = {
  pool: {
    totalDeposited: "0xff50abdc", totalOutflow: "0xccaac7ee", totalClaimed: "0xd54ad2a1", POST_WINDOW: "0x9e8ea276",
    paused: "0x5c975abb", operator: "0x570ca735", owner: "0x8da5cb5b", guardian: "0x452a9320",
    queuedSpendCount: "0x129840da", queuedSpendAt: "0x0702d389", campaignCount: "0x7274e30d", campaignAt: "0x1867ee84",
    drawOf: "0xa020e0d9",
  },
  multicall: { aggregate3: "0x82ad56cb", getEthBalance: "0x4d2301cc" },
} as const;

/** Counters the next pool carries. A pool without them answers with a failure, and the snapshot leaves them out. */
export const OPTIONAL_VIEWS = { everDeposited: "0x60ce7f4d", exitsPaid: "0x231697ad", donated: "0x639bbb37" } as const;

const WORD = 64;
const strip = (hex: string): string => (hex.startsWith("0x") ? hex.slice(2) : hex);
const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(WORD, "0");
const padded = (hex: string): string => hex.padEnd(Math.ceil(hex.length / WORD) * WORD, "0");

/** aggregate3((address target, bool allowFailure, bytes callData)[]) */
export const encodeAggregate3 = (calls: readonly Call[]): Hex => {
  const bodies = calls.map(({ target, allowFailure, callData }) => {
    const data = strip(callData);
    return strip(target).toLowerCase().padStart(WORD, "0") + word(allowFailure ? 1 : 0) + word(0x60) + word(data.length / 2) + padded(data);
  });
  let at = calls.length * 32;
  const offsets = bodies.map((body) => {
    const offset = word(at);
    at += body.length / 2;
    return offset;
  });
  return `${SELECTORS.multicall.aggregate3}${word(0x20)}${word(calls.length)}${offsets.join("")}${bodies.join("")}`;
};

/** Reads words and byte strings by byte offset, and refuses an answer that is too short to hold them. */
const reader = (data: Hex) => {
  const hex = strip(data);
  const slice = (from: number, length: number): string => {
    if (from < 0 || (from + length) * 2 > hex.length) throw new Error("monitor: an answer is shorter than its own layout");
    return hex.slice(from * 2, (from + length) * 2);
  };
  return {
    word: (at: number): bigint => BigInt(`0x${slice(at, 32)}`),
    index: (at: number): number => Number(BigInt(`0x${slice(at, 32)}`)),
    bytes: (at: number, length: number): Hex => `0x${slice(at, length)}`,
  };
};

/** Returns of aggregate3: (bool success, bytes returnData)[] */
export const decodeAggregate3 = (data: Hex): { success: boolean; returnData: Hex }[] => {
  const r = reader(data);
  const base = r.index(0);
  const first = base + 32;
  return Array.from({ length: r.index(base) }, (_, i) => {
    const element = first + r.index(first + 32 * i);
    const bytesAt = element + r.index(element + 32);
    return { success: r.word(element) !== 0n, returnData: r.bytes(bytesAt + 32, r.index(bytesAt)) };
  });
};

/** queuedSpendAt: (bytes32 id, (bytes encDepositor, uint256 amount, uint64 dueAt, uint64 queuedAt, bool posted)) */
export const decodeQueued = (data: Hex): QueuedCharge => {
  const r = reader(data);
  const entry = r.index(32);
  return {
    id: r.bytes(0, 32),
    amount: r.word(entry + 32),
    dueAt: r.word(entry + 64),
    queuedAt: r.word(entry + 96),
    posted: r.word(entry + 128) !== 0n,
  };
};

/** drawOf: (uint256 amount, uint256 spent, uint256 reserved, uint256 principalOut, uint64 dueAt, bytes ownerRef, uint8 state) */
export const decodeDraw = (campaign: Hex, data: Hex): DrawSeen => {
  const r = reader(data);
  const draw = r.index(0);
  return { campaign, state: r.index(draw + 192), dueAt: r.word(draw + 128), reserved: r.word(draw + 64) };
};

const address = (data: Hex): Address => `0x${strip(data).slice(-40)}`;
const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Runs the jobs a few at a time, in order of their answers. */
const some = async <T, R>(items: readonly T[], job: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  for (const batch of chunks(items, PARALLEL)) out.push(...(await Promise.all(batch.map(job))));
  return out;
};

export const readSnapshot = async (
  rpc: Rpc,
  pool: Address,
  options: { multicall?: Address; chunk?: number } = {},
): Promise<PoolSnapshot> => {
  const multicall = (options.multicall ?? MULTICALL3) as Address;
  const size = options.chunk ?? READ_CHUNK;
  const tip = (await rpc("eth_getBlockByNumber", ["latest", false])) as { number: Hex };
  const pinned = BigInt(tip.number) > BLOCKS_BEHIND ? BigInt(tip.number) - BLOCKS_BEHIND : BigInt(tip.number);
  const head = (await rpc("eth_getBlockByNumber", [`0x${pinned.toString(16)}`, false])) as { number: Hex; timestamp: Hex };

  const aggregate = async (calls: readonly Call[]): Promise<{ success: boolean; returnData: Hex }[]> => {
    const answers = decodeAggregate3((await rpc("eth_call", [{ to: multicall, data: encodeAggregate3(calls) }, head.number])) as Hex);
    if (answers.length !== calls.length) throw new Error("monitor: Multicall3 answered for a different number of calls");
    answers.forEach((answer, i) => {
      if (!answer.success && !calls[i]?.allowFailure) throw new Error(`monitor: the pool refused ${calls[i]?.callData.slice(0, 10)}`);
    });
    return answers;
  };
  const view = (selector: string, argument = "", allowFailure = false): Call =>
    ({ target: pool, allowFailure, callData: `${selector}${argument}` as Hex });
  const balanceOf = (who: Address): Call =>
    ({ target: multicall, allowFailure: false, callData: `${SELECTORS.multicall.getEthBalance}${strip(who).padStart(WORD, "0")}` as Hex });

  const p = SELECTORS.pool;
  const names = [p.totalDeposited, p.totalOutflow, p.totalClaimed, p.POST_WINDOW, p.paused, p.operator, p.owner, p.guardian, p.queuedSpendCount, p.campaignCount];
  const optional = Object.values(OPTIONAL_VIEWS);
  const first = await aggregate([balanceOf(pool), ...names.map((s) => view(s)), ...optional.map((s) => view(s, "", true))]);
  const at = (i: number): Hex => first[i]?.returnData ?? "0x";
  const operator = address(at(6));
  const counted = first.slice(1 + names.length);
  const counters = counted.length === optional.length && counted.every((c) => c.success && c.returnData.length === 2 + WORD)
    ? { everDeposited: BigInt(counted[0]?.returnData ?? "0x0"), exitsPaid: BigInt(counted[1]?.returnData ?? "0x0"), donated: BigInt(counted[2]?.returnData ?? "0x0") }
    : undefined;

  // The operator's balance rides with the first chunk of charges, so an empty queue still costs one call.
  const charges = Array.from({ length: Number(BigInt(at(9))) }, (_, i) => view(p.queuedSpendAt, word(i)));
  const keys = Array.from({ length: Number(BigInt(at(10))) }, (_, i) => view(p.campaignAt, word(i)));
  const [chargeAnswers, keyAnswers] = await Promise.all([
    some([[balanceOf(operator), ...charges.slice(0, size)], ...chunks(charges.slice(size), size)], aggregate),
    some(chunks(keys, size), aggregate),
  ]);
  const [operatorBalance, ...queued] = chargeAnswers.flat();
  const campaigns = keyAnswers.flat().map((answer) => answer.returnData);
  const draws = (await some(chunks(campaigns.map((key) => view(p.drawOf, strip(key))), size), aggregate)).flat();

  return {
    block: BigInt(head.number),
    chainTime: BigInt(head.timestamp),
    pool,
    balance: BigInt(at(0)),
    totalDeposited: BigInt(at(1)),
    totalOutflow: BigInt(at(2)),
    totalClaimed: BigInt(at(3)),
    ...(counters ? { counters } : {}),
    postWindow: BigInt(at(4)),
    paused: BigInt(at(5)) !== 0n,
    operator,
    admin: address(at(7)),
    guardian: address(at(8)),
    operatorBalance: BigInt(operatorBalance?.returnData ?? "0x0"),
    queue: queued.map((answer) => decodeQueued(answer.returnData)),
    draws: draws.map((answer, i) => decodeDraw(campaigns[i] ?? "0x", answer.returnData)),
  };
};

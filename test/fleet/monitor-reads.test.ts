import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  decodeFunctionData, encodeFunctionData, encodeFunctionResult, multicall3Abi, toFunctionSelector,
  type Abi, type AbiFunction, type Address, type Hex,
} from "viem";

import {
  BLOCKS_BEHIND, MULTICALL3, OPTIONAL_VIEWS, SELECTORS, decodeAggregate3, decodeDraw, decodeQueued, encodeAggregate3, readSnapshot,
  type Rpc,
} from "../../src/fleet/monitor-reads.js";

/**
 * The monitor runs on plain node with nothing installed, so it carries its own
 * ABI coding and its own selectors. Here viem is the oracle for both, and the
 * compiled pool is the oracle for the selectors: facts are read, never typed.
 */

// Anchored on the working directory, like pool-abi.test.ts.
const ARTIFACT = join(process.cwd(), "artifacts/contracts/fleet/FleetPool.sol/FleetPool.json");
const poolAbi = async (): Promise<Abi> => (JSON.parse(await readFile(ARTIFACT, "utf8")) as { abi: Abi }).abi;
const fn = (abi: Abi, name: string): AbiFunction | undefined =>
  abi.find((entry): entry is AbiFunction => entry.type === "function" && entry.name === name);

const POOL = "0xb29139f3119d490eae473ba29fe8deadfb2c5ca5" as Address;
const OPERATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" as Address;
const ADMIN = "0xCb70EfEfC73f241047262d4FACe6D21d052F6946" as Address;
const ZERO = `0x${"0".repeat(40)}` as Address;
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

type Entry = { encDepositor: Hex; amount: bigint; dueAt: bigint; queuedAt: bigint; posted: boolean };
type Draw = { amount: bigint; spent: bigint; reserved: bigint; principalOut: bigint; dueAt: bigint; ownerRef: Hex; state: number };
type Model = {
  block: bigint; time: bigint; balance: bigint; operatorBalance: bigint;
  views: Record<string, bigint | boolean | Address>;
  queue: Entry[]; draws: Draw[];
};

const model = (entries: number, extra: Record<string, bigint> = {}): Model => ({
  block: 121_706_654n, time: 1_790_000_000n, balance: 61n * 10n ** 15n, operatorBalance: 25n * 10n ** 16n,
  views: {
    totalDeposited: 7n * 10n ** 16n, totalOutflow: 9n * 10n ** 15n, totalClaimed: 0n, POST_WINDOW: 43_200n, paused: false,
    operator: OPERATOR, owner: ADMIN, guardian: ZERO, ...extra,
  },
  // sealed depositors of different lengths, so every offset in the decoder is walked
  queue: Array.from({ length: entries }, (_, i) => ({
    encDepositor: `0x${"ab".repeat(48 + (i % 3) * 17)}` as Hex, amount: BigInt(1_000 + i), dueAt: 1_789_990_000n + BigInt(i),
    queuedAt: 1_789_989_000n + BigInt(i), posted: i % 7 !== 0,
  })),
  draws: [0, 1, 2].map((i) => ({
    amount: 2n * 10n ** 16n, spent: BigInt(i) * 10n ** 15n, reserved: i === 2 ? 5n : 0n, principalOut: 0n,
    dueAt: 1_789_000_000n + BigInt(i), ownerRef: `0x${"cd".repeat(60 + i)}` as Hex, state: i + 1,
  })),
});

/** A JSON-RPC endpoint over the model: viem decodes what the monitor encoded, and encodes what it will decode. */
const fakeRpc = (abi: Abi, m: Model, seen: { calls: number; tags: Set<string>; sizes: number[] }): Rpc => async (method, params) => {
  // The tip is ahead of the block the model describes: a load-balanced RPC answers "latest" from one node and
  // the next call from another that has not seen it yet, which the public one did on the monitor's first live run.
  if (method === "eth_getBlockByNumber" && params[0] === "latest") return { number: `0x${(m.block + BLOCKS_BEHIND).toString(16)}`, timestamp: `0x${(m.time + 6n).toString(16)}` };
  if (method === "eth_getBlockByNumber") {
    assert.equal(params[0], `0x${m.block.toString(16)}`);
    return { number: params[0], timestamp: `0x${m.time.toString(16)}` };
  }
  if (method !== "eth_call") throw new Error(`unexpected ${method}`);
  const [tx, tag] = params as [{ to: Address; data: Hex }, string];
  assert.equal(tx.to.toLowerCase(), MULTICALL3.toLowerCase(), "every read goes through Multicall3");
  seen.calls += 1;
  seen.tags.add(tag);
  const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
  const calls = args?.[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
  seen.sizes.push(calls.length);
  const results = calls.map((call) => {
    if (call.target.toLowerCase() === MULTICALL3.toLowerCase()) {
      const who = (decodeFunctionData({ abi: multicall3Abi, data: call.callData }).args?.[0] as Address).toLowerCase();
      const value = who === POOL.toLowerCase() ? m.balance : m.operatorBalance;
      return { success: true, returnData: encodeFunctionResult({ abi: multicall3Abi, functionName: "getEthBalance", result: value }) };
    }
    const known = abi.filter((e): e is AbiFunction => e.type === "function").find((e) => toFunctionSelector(e) === call.callData.slice(0, 10));
    const name = known?.name ?? Object.entries(OPTIONAL_VIEWS).find(([, s]) => s === call.callData.slice(0, 10))?.[0] ?? "";
    // An optional view the scenario does not list is a pool without it, whether or not the compiled ABI knows the name.
    if (!(name in m.views) && (!known || name in OPTIONAL_VIEWS)) return { success: false, returnData: "0x" as Hex };
    if (name in m.views) {
      const value = m.views[name];
      const type = typeof value === "boolean" ? "bool" : typeof value === "bigint" ? "uint256" : "address";
      const view = [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type, name: "" }] }] as const;
      return { success: true, returnData: encodeFunctionResult({ abi: view, functionName: name, result: value } as never) };
    }
    if (!known) return { success: false, returnData: "0x" as Hex };
    const input = decodeFunctionData({ abi, data: call.callData }).args ?? [];
    const result =
      name === "queuedSpendCount" ? BigInt(m.queue.length)
      : name === "campaignCount" ? BigInt(m.draws.length)
      : name === "campaignAt" ? id(Number(input[0]) + 1)
      : name === "queuedSpendAt" ? [id(Number(input[0]) + 1000), m.queue[Number(input[0])]]
      : name === "drawOf" ? m.draws[Number(BigInt(input[0] as Hex)) - 1]
      : undefined;
    assert.notEqual(result, undefined, `the model has no answer for ${name}`);
    return { success: true, returnData: encodeFunctionResult({ abi, functionName: name, result } as never) };
  });
  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
};

describe("the monitor's own ABI coding", () => {
  it("uses the selectors the compiled pool and Multicall3 answer to", async () => {
    const abi = await poolAbi();
    for (const [name, selector] of Object.entries(SELECTORS.pool)) {
      const entry = fn(abi, name);
      assert.ok(entry, `the pool has no ${name}()`);
      assert.equal(selector, toFunctionSelector(entry), name);
    }
    for (const [name, selector] of Object.entries(SELECTORS.multicall)) {
      assert.equal(selector, toFunctionSelector(fn(multicall3Abi as Abi, name) as AbiFunction), name);
    }
    // Counters the next pool will carry. Not in this artifact yet, so the name is all there is to check.
    for (const [name, selector] of Object.entries(OPTIONAL_VIEWS)) assert.equal(selector, toFunctionSelector(`${name}()`), name);
  });

  it("encodes aggregate3 exactly as viem does, for calls of any length", () => {
    const calls = [
      { target: POOL, allowFailure: false, callData: SELECTORS.pool.totalDeposited as Hex },
      { target: POOL, allowFailure: true, callData: `${SELECTORS.pool.queuedSpendAt}${"0".repeat(62)}2a` as Hex },
      { target: MULTICALL3 as Address, allowFailure: false, callData: `${SELECTORS.multicall.getEthBalance}${POOL.slice(2).padStart(64, "0")}` as Hex },
    ];
    assert.equal(encodeAggregate3(calls), encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }));
    assert.equal(encodeAggregate3([]), encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [[]] }));
  });

  it("decodes what viem encodes: results, queue entries and draws", async () => {
    const abi = await poolAbi();
    const results = [{ success: true, returnData: "0x1234" as Hex }, { success: false, returnData: "0x" as Hex }, { success: true, returnData: `0x${"ee".repeat(97)}` as Hex }];
    assert.deepEqual(decodeAggregate3(encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results })), results);

    for (const entry of model(6).queue) {
      const data = encodeFunctionResult({ abi, functionName: "queuedSpendAt", result: [id(77), entry] } as never);
      assert.deepEqual(decodeQueued(data), { id: id(77), amount: entry.amount, dueAt: entry.dueAt, queuedAt: entry.queuedAt, posted: entry.posted });
    }
    for (const draw of model(0).draws) {
      const data = encodeFunctionResult({ abi, functionName: "drawOf", result: draw } as never);
      assert.deepEqual(decodeDraw(id(5), data), { campaign: id(5), state: draw.state, dueAt: draw.dueAt, reserved: draw.reserved });
    }
  });
});

describe("one snapshot of the pool", () => {
  it("reads everything at one block, in chunks, and keeps no sealed depositor", async () => {
    const abi = await poolAbi();
    const m = model(450);
    const seen = { calls: 0, tags: new Set<string>(), sizes: [] as number[] };
    const snapshot = await readSnapshot(fakeRpc(abi, m, seen), POOL);

    assert.deepEqual([...seen.tags], [`0x${m.block.toString(16)}`], "every eth_call is pinned to one block, a little behind the tip");
    assert.equal(seen.calls, 1 + 3 + 1 + 1, "the head, three chunks of charges, the campaign keys, the draws");
    assert.ok(Math.max(...seen.sizes) <= 201, "no call carries more than a chunk, plus the operator's balance");

    assert.equal(snapshot.block, m.block);
    assert.equal(snapshot.chainTime, m.time);
    assert.equal(snapshot.balance, m.balance);
    assert.equal(snapshot.operatorBalance, m.operatorBalance);
    assert.equal(snapshot.totalDeposited, 7n * 10n ** 16n);
    assert.equal(snapshot.postWindow, 43_200n);
    assert.equal(snapshot.paused, false);
    assert.deepEqual([snapshot.operator, snapshot.admin, snapshot.guardian].map((a) => a.toLowerCase()), [OPERATOR, ADMIN, ZERO].map((a) => a.toLowerCase()));
    assert.equal(snapshot.counters, undefined, "this pool has no counters, and the snapshot says so");

    assert.equal(snapshot.queue.length, 450);
    assert.deepEqual(snapshot.queue[449], { id: id(1449), amount: 1_449n, dueAt: m.queue[449]?.dueAt, queuedAt: m.queue[449]?.queuedAt, posted: true });
    assert.deepEqual(snapshot.draws.map((d) => [d.campaign, d.state, d.reserved]), [[id(1), 1, 0n], [id(2), 2, 0n], [id(3), 3, 5n]]);
    assert.ok(!JSON.stringify(snapshot, (_, v) => (typeof v === "bigint" ? v.toString() : v)).includes("abab"), "what the monitor cannot open, it does not carry");
  });

  it("reads the counters where the pool has them", async () => {
    const m = model(0, { everDeposited: 9n * 10n ** 16n, exitsPaid: 10n ** 16n, donated: 3n });
    const snapshot = await readSnapshot(fakeRpc(await poolAbi(), m, { calls: 0, tags: new Set(), sizes: [] }), POOL);
    assert.deepEqual(snapshot.counters, { everDeposited: 9n * 10n ** 16n, exitsPaid: 10n ** 16n, donated: 3n });
    assert.deepEqual(snapshot.queue, []);
  });
});

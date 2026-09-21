import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { FleetPool, PoolDraw, PoolQueued } from "../../src/fleet/chain-pool.js";
import { DRAW_STATE } from "../../src/fleet/chain-pool.js";
import { ledgerKey, openDepositor, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { BATCH_LIMIT, CHARGE_GRAIN, GAS_HEADROOM, MIN_DELAY_SECONDS, coarseCharge, createPoolService, minimumDraw } from "../../src/fleet/pool-buy.js";
import { createMemoryStore } from "../../src/fleet/store.js";

/**
 * The pool service's money operations, against a pool that records what it
 * is asked and can be told to refuse. These are the audit findings A1, A3,
 * A11, A12 and A37 as behaviour: a sweep that survives one bad draw, headroom
 * that is charged, a withdrawal that is recorded before it is paid, a mined
 * buy that is never rolled back, and a delay floor above the contract's.
 *
 * And the join those left: a charge used to be queued in the operator's next
 * transaction after the buy that caused it. Now a buy records what is owed in
 * the store and queues nothing; the sweep queues everything owed in one
 * shuffled batch, each entry on its own timer.
 */

const KEY = ledgerKey(`0x${"7".repeat(64)}`);
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const campaign = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const account = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

type Call = { fn: string; args: unknown[] };

const makePool = (draws: PoolDraw[], queued: PoolQueued[] = []) => {
  const calls: Call[] = [];
  let refuseFund = new Set<Hex>();
  let commitFailures = 0;
  let failBuy = false;
  let failBatch = false;
  /** What the signed step reports for a batch, and what resolve answers for a hash left sent. */
  let batchOutcome: "mined" | "reverted" | "unknown" = "mined";
  let resolveAs: "mined" | "reverted" | "never-mined" | "unknown" = "mined";
  /** The pause's inputs: whether the pool is paused, who has asked to exit and whether their exit would fail, when it was last resumed. */
  let isPaused = false;
  let exiting: Address[] = [];
  let exitFails = false;
  let resumedAt = 0n;
  const pool: FleetPool = {
    address: "0x0000000000000000000000000000000000000901" as Address,
    pause: async () => { calls.push({ fn: "pause", args: [] }); isPaused = true; return "0x0p"; },
    exitsRequested: async () => exiting,
    exitWouldFail: async () => exitFails,
    lastResumedAt: async () => resumedAt,
    // The signed step, over this fake: the hash is recorded first, then the named function runs as before.
    nextNonce: async () => 0,
    signAndBroadcast: async (step) => {
      const hash = `0x${"d".repeat(64)}` as const;
      await step.record(hash, step.nonce);
      if (!step.functionName) { calls.push({ fn: "transfer", args: [step.to, step.value] }); return { status: "mined", hash }; }
      if (step.functionName === "queueSpendBatch" && batchOutcome === "reverted") return { status: "reverted", hash };
      try {
        // The gas limit rides as the function's last argument, where the fake's fundAndExecute reads it.
        if (step.functionName) await (pool as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[step.functionName]!(...step.args, ...(step.gas === undefined ? [] : [step.gas]));
        return batchOutcome === "unknown" ? { status: "unknown", hash, nonce: step.nonce } : { status: "mined", hash };
      } catch (error) {
        const named = /(?:Error:\s*)?([A-Z][A-Za-z0-9_]*)\(\)/.exec(String(error))?.[1];
        return { status: "reverted", hash, ...(named ? { reason: named } : {}) };
      }
    },
    resolve: async (hash, nonce) => (resolveAs === "mined" || resolveAs === "reverted" ? { status: resolveAs, hash } : { status: resolveAs, hash, nonce }),
    depositorOf: async () => ({ deposited: 0n, spent: 0n, exitRequestedAt: 0n, exitAmount: 0n }),
    headroom: async () => ({ perDepositor: 0n, perPool: 0n }),
    caps: async () => ({ depositor: 500000000000000000n, draw: 200000000000000000n, pool: 5000000000000000000n }),
    paused: async () => isPaused,
    draws: async () => draws,
    drawOf: async (c) => draws.find((d) => d.campaign === c),
    queued: async () => queued,
    ledgerInputs: async () => ({ deposited: 0n, spent: 0n, draws, queued }) as never,
    openDraw: async (...args) => { calls.push({ fn: "openDraw", args }); return "0x01"; },
    topUpDraw: async (...args) => { calls.push({ fn: "topUpDraw", args }); return "0x01"; },
    fund: async (c, accounts) => {
      calls.push({ fn: "fund", args: [c, accounts] });
      if (refuseFund.has(c)) throw new Error("fund reverted: TransferFailed()");
      return "0x01";
    },
    fundPrincipal: async (...args) => { calls.push({ fn: "fundPrincipal", args }); return "0x01"; },
    fundAndExecute: async (...args) => {
      calls.push({ fn: "fundAndExecute", args });
      if (failBuy) throw new Error("fundAndExecute reverted: CallFailed()");
      const d = draws.find((x) => x.campaign === args[0]);
      if (d) d.spent += (args[2] as bigint) + 1000n;
      return `0x${"b".repeat(64)}`;
    },
    commit: async (...args) => {
      calls.push({ fn: "commit", args });
      if (commitFailures > 0) { commitFailures -= 1; throw new Error("rpc: nonce too low"); }
      return "0x01";
    },
    rollback: async (...args) => { calls.push({ fn: "rollback", args }); return "0x01"; },
    closeDraw: async (...args) => { calls.push({ fn: "closeDraw", args }); return "0x01"; },
    queueSpendBatch: async (...args) => {
      calls.push({ fn: "queueSpendBatch", args });
      if (failBatch) throw new Error("rpc: nonce too low");
      return `0x${"c".repeat(64)}`;
    },
    postQueued: async (...args) => { calls.push({ fn: "postQueued", args }); return "0x01"; },
    postQueuedBatch: async (...args) => { calls.push({ fn: "postQueuedBatch", args }); return "0x01"; },
    donate: async (...args) => { calls.push({ fn: "donate", args }); return "0x01"; },
    claimable: async () => 0n,
    claimOperator: async () => "0x01",
  };
  return {
    pool, calls,
    setBatchOutcome: (o: typeof batchOutcome) => { batchOutcome = o; },
    setPaused: (on: boolean) => { isPaused = on; },
    setExiting: (who: Address[], fails: boolean) => { exiting = who; exitFails = fails; },
    setResumedAt: (at: bigint) => { resumedAt = at; },
    setResolveAs: (o: typeof resolveAs) => { resolveAs = o; },
    refuse: (c: Hex) => { refuseFund = new Set([...refuseFund, c]); },
    failCommits: (n: number) => { commitFailures = n; },
    failBuys: () => { failBuy = true; },
    failBatches: (on: boolean) => { failBatch = on; },
  };
};

const wallet = {
  account: { address: account(0xdead) },
  chain: null,
  sendTransaction: async () => `0x${"a".repeat(64)}`,
  writeContract: async () => `0x${"b".repeat(64)}`,
} as unknown as WalletClient;

const publicClient = {
  getBlock: async () => ({ timestamp: 1_700_000_000n }),
  getBalance: async () => parseEther("1"),
  getGasPrice: async () => 1_000_000_000n,
  waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 50_000n, effectiveGasPrice: 1_000_000_000n }),
} as unknown as PublicClient;

const draw = (n: number, owner: Address, amount: bigint, spent = 0n): PoolDraw => ({
  campaign: campaign(n), amount, spent, reserved: 0n, principalOut: 0n,
  dueAt: 1_699_999_000n, ownerRef: sealDepositor(KEY, owner), state: DRAW_STATE.pending,
});

const opts = () => ({ delaySeconds: () => 120, store: createMemoryStore(), random: () => 0.5 });

describe("sweep", () => {
  it("posts every due charge and funds every other draw when one draw cannot be funded", async () => {
    const queued: PoolQueued[] = [
      { id: `0x${"a1".repeat(32)}` as Hex, encDepositor: sealDepositor(KEY, ALICE), amount: 1n, dueAt: 1_699_999_000n, queuedAt: 1_699_998_000n, posted: false },
    ];
    const { pool, calls, refuse } = makePool([draw(1, ALICE, parseEther("0.01")), draw(2, BOB, parseEther("0.01"))], queued);
    refuse(campaign(1));
    const service = createPoolService(wallet, publicClient, pool, KEY, opts());

    const report = await service.sweep(async () => [account(1), account(2)]);

    assert.deepEqual(report.posted, [`0x${"a1".repeat(32)}` as Hex], "the charge was posted although the first draw failed");
    assert.deepEqual(report.funded, [campaign(2)], "the second draw was funded although the first failed");
    const order = calls.map((c) => c.fn);
    assert.equal(order.indexOf("postQueued") < order.indexOf("fund"), true, "charges are posted before any draw is funded");
  });

  it("skips a draw smaller than its own headroom instead of reverting on it every sweep", async () => {
    const tiny = draw(3, ALICE, GAS_HEADROOM * 2n - 1n);
    const { pool, calls } = makePool([tiny, draw(4, BOB, parseEther("0.01"))]);
    const service = createPoolService(wallet, publicClient, pool, KEY, opts());

    const report = await service.sweep(async () => [account(1), account(2)]);

    assert.deepEqual(report.funded, [campaign(4)]);
    assert.equal(calls.filter((c) => c.fn === "fund" && (c.args[0] as Hex) === campaign(3)).length, 0, "fund was never attempted for the tiny draw");
  });

  it("charges the seeded headroom to the depositor: recorded in this sweep, queued in the next", async () => {
    const { pool, calls } = makePool([draw(5, ALICE, parseEther("0.01"))]);
    const o = opts();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);

    await service.sweep(async () => [account(1), account(2), account(3)], { queueOwed: true });
    assert.equal(await o.store.owedFor(ALICE), coarseCharge(GAS_HEADROOM * 3n).toString(), "the coarse form of the headroom that left the pool is owed");
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 0, "nothing depositor-keyed leaves in the sweep that funded");

    const second = await service.sweep(async () => [], { queueOwed: true });
    const batch = calls.find((c) => c.fn === "queueSpendBatch");
    assert.ok(batch, "the next sweep queues it");
    assert.deepEqual(batch.args[1], [coarseCharge(GAS_HEADROOM * 3n)]);
    assert.deepEqual(batch.args[2], [1_700_000_000n + 120n], "on its own timer");
    assert.equal(second.queued, 1);
  });

  it("queues everything owed in one batch, each entry sealed to its depositor and on its own timer", async () => {
    const { pool, calls } = makePool([]);
    const o = { ...opts(), delaySeconds: (() => { let n = 0; return () => 100 + (n++) * 50; })() };
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    await o.store.recordOwed({ id: "a", depositor: ALICE, amount: "1000", incurredAt: "2026-09-15T00:00:00Z" });
    await o.store.recordOwed({ id: "b", depositor: BOB, amount: "2000", incurredAt: "2026-09-15T00:00:01Z" });
    await o.store.recordOwed({ id: "c", depositor: ALICE, amount: "3000", incurredAt: "2026-09-15T00:00:02Z" });

    const report = await service.sweep(async () => [], { queueOwed: true });

    const batches = calls.filter((c) => c.fn === "queueSpendBatch");
    assert.equal(batches.length, 1, "one transaction for the whole batch");
    const [refs, amounts, dues] = batches[0]!.args as [Hex[], bigint[], bigint[]];
    assert.equal(refs.length, 3);
    const opened = refs.map((r) => openDepositor(KEY, r));
    assert.deepEqual([...opened].sort(), [ALICE, ALICE, BOB].sort(), "each entry opens to its own depositor");
    assert.deepEqual([...amounts].sort(), [1000n, 2000n, 3000n]);
    assert.deepEqual([...dues].sort(), [1_700_000_100n, 1_700_000_150n, 1_700_000_200n], "three different due times");
    assert.equal(report.queued, 3);
    assert.equal(await o.store.owedFor(ALICE), "0", "queued spend is the chain's now");
    assert.equal(await o.store.owedFor(BOB), "0");
  });

  it("leaves owed spend for the next sweep when the batch transaction fails", async () => {
    const { pool, calls, failBatches } = makePool([]);
    const o = opts();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    await o.store.recordOwed({ id: "a", depositor: ALICE, amount: "1000", incurredAt: "2026-09-15T00:00:00Z" });

    failBatches(true);
    const failed = await service.sweep(async () => [], { queueOwed: true });
    assert.equal(failed.queued, 0);
    assert.equal(await o.store.owedFor(ALICE), "1000", "still owed");

    failBatches(false);
    const retried = await service.sweep(async () => [], { queueOwed: true });
    assert.equal(retried.queued, 1);
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 2);
    assert.equal(await o.store.owedFor(ALICE), "0");
  });

  it("queues nothing owed unless asked to: a sweep riding on a trader's request must not put a batch beside that request's buy", async () => {
    const { pool, calls } = makePool([]);
    const o = opts();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    await o.store.recordOwed({ id: "a", depositor: ALICE, amount: "1000", incurredAt: "2026-09-15T00:00:00Z" });

    const report = await service.sweep(async () => []);
    assert.equal(report.queued, 0);
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 0);
    assert.equal(await o.store.owedFor(ALICE), "1000", "still owed, for the scheduled sweep");
  });

  it("caps a batch and carries the rest to the next sweep", async () => {
    const { pool, calls } = makePool([]);
    const o = opts();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    for (let i = 0; i < BATCH_LIMIT + 2; i++) {
      await o.store.recordOwed({ id: `o${i}`, depositor: ALICE, amount: "1000", incurredAt: new Date(i * 1000).toISOString() });
    }
    assert.equal((await service.sweep(async () => [], { queueOwed: true })).queued, BATCH_LIMIT);
    assert.equal((await service.sweep(async () => [], { queueOwed: true })).queued, 2);
    assert.equal((calls[0]!.args[0] as Hex[]).length, BATCH_LIMIT);
  });
});

describe("balance", () => {
  it("subtracts spend that is owed but not yet on the chain", async () => {
    const { pool } = makePool([]);
    const funded: FleetPool = { ...pool, ledgerInputs: async () => ({ deposited: parseEther("0.05"), spent: 0n, draws: [], queued: [] }) as never };
    const o = opts();
    const service = createPoolService(wallet, publicClient, funded, KEY, o);
    await o.store.recordOwed({ id: "a", depositor: ALICE, amount: parseEther("0.01").toString(), incurredAt: "2026-09-15T00:00:00Z" });

    const view = await service.balance(ALICE);
    assert.equal(view.available, parseEther("0.04").toString());
    assert.equal(view.owed, parseEther("0.01").toString());
  });
});

describe("the batch through the signed step (T025)", () => {
  const seed = async (o: ReturnType<typeof opts>) => {
    await o.store.recordOwed({ id: "m1", depositor: ALICE, amount: "5000", incurredAt: "2026-09-15T00:00:00Z" });
    await o.store.recordOwed({ id: "m2", depositor: BOB, amount: "7000", incurredAt: "2026-09-15T00:00:01Z" });
  };
  const quietly = async <T,>(name: "warn" | "error", work: () => Promise<T>): Promise<T> => {
    const original = console[name];
    console[name] = () => {};
    try { return await work(); } finally { console[name] = original; }
  };

  it("mined: the rows are the chain's, nothing is owed and nothing is sent", async () => {
    const { pool, calls } = makePool([]);
    const o = opts();
    await seed(o);
    const report = await createPoolService(wallet, publicClient, pool, KEY, o).sweep(async () => [], { queueOwed: true });
    assert.equal(report.queued, 2);
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 1);
    assert.equal(await o.store.owedFor(ALICE), "0");
    assert.deepEqual(await o.store.sentBatches(), []);
    assert.deepEqual(await o.store.takeOwed(5), []);
  });

  it("reverted: the rows go back to the next sweep, which sends them again", async () => {
    const { pool, calls, setBatchOutcome } = makePool([]);
    const o = opts();
    await seed(o);
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    setBatchOutcome("reverted");
    const first = await quietly("error", () => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(first.queued, 0);
    assert.equal(await o.store.owedFor(ALICE), "5000", "still owed");
    assert.deepEqual(await o.store.sentBatches(), [], "not sent: a receipt said reverted");
    setBatchOutcome("mined");
    const second = await service.sweep(async () => [], { queueOwed: true });
    assert.equal(second.queued, 2, "the same two rows, in the next batch");
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 1, "the reverted attempt never ran the function; the mined one did");
  });

  it("never-mined: an unknown outcome leaves the rows sent, the next sweep resolves the hash, and only then are they queued again", async () => {
    const { pool, calls, setBatchOutcome, setResolveAs } = makePool([]);
    const o = opts();
    await seed(o);
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    setBatchOutcome("unknown");
    const first = await quietly("warn", () => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(first.queued, 0);
    assert.equal((await o.store.sentBatches()).length, 1, "sent, under the hash recorded before the broadcast");
    assert.deepEqual(await o.store.takeOwed(5), [], "and offered to nobody on the strength of an exception");

    setBatchOutcome("mined");
    setResolveAs("unknown");
    const second = await quietly("warn", () => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(second.queued, 0, "still unknown: still sent, still not queued again");

    setResolveAs("never-mined");
    const third = await quietly("error", () => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(third.queued, 2, "provably never mined: owed again, and queued in this very sweep");
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 2);
    assert.deepEqual(await o.store.sentBatches(), []);
  });
});

describe("the automatic pause (T050, T052)", () => {
  const NOW = 1_700_000_000n;
  const expiredCharge = (n: number, queuedAt: bigint): PoolQueued =>
    ({ id: `0x${n.toString(16).padStart(64, "0")}` as Hex, encDepositor: sealDepositor(KEY, ALICE), amount: 5_000n, dueAt: queuedAt + 60n, queuedAt, posted: false });
  const quietly = async <T,>(work: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => {};
    try { return await work(); } finally { console.error = original; }
  };

  it("a charge that passed its deadline unrecorded pauses the pool in the same sweep, once", async () => {
    const { pool, calls } = makePool([], [expiredCharge(1, NOW - 13n * 3600n)]);
    const o = opts();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    const report = await quietly(() => service.sweep(async () => [], { queueOwed: true }));
    assert.deepEqual(report.paused, { trigger: "charge-expired", detail: [`0x${"1".padStart(64, "0")}`] });
    assert.equal(calls.filter((c) => c.fn === "pause").length, 1, "the brake, in the sweep that saw it");
    const again = await quietly(() => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(again.paused?.trigger, "charge-expired", "still the reason");
    assert.equal(calls.filter((c) => c.fn === "pause").length, 1, "and not pulled twice");
  });

  it("a charge that expired before the pool was last resumed has been dealt with and pauses nothing", async () => {
    const { pool, calls, setResumedAt } = makePool([], [expiredCharge(2, NOW - 13n * 3600n)]);
    setResumedAt(NOW - 60n);
    const report = await quietly(() => createPoolService(wallet, publicClient, pool, KEY, opts()).sweep(async () => [], { queueOwed: true }));
    assert.equal(report.paused, undefined);
    assert.equal(calls.filter((c) => c.fn === "pause").length, 0);
  });

  it("an exit that would fail if sent pauses the pool, and one that is not yet due does not", async () => {
    const { pool, calls, setExiting } = makePool([]);
    const requestedAt = NOW - 25n * 3600n;
    const due: FleetPool = { ...pool, depositorOf: async () => ({ deposited: parseEther("0.1"), spent: 0n, exitRequestedAt: requestedAt, exitAmount: parseEther("0.1") }) };
    setExiting([ALICE], true);
    const report = await quietly(() => createPoolService(wallet, publicClient, due, KEY, opts()).sweep(async () => [], { queueOwed: true }));
    assert.equal(report.paused?.trigger, "exit-failed");
    assert.ok(!report.paused?.detail.join(" ").toLowerCase().includes(ALICE.toLowerCase()), "the depositor is never named");
    assert.equal(calls.filter((c) => c.fn === "pause").length, 1);

    const { pool: p2, calls: c2, setExiting: e2 } = makePool([]);
    const notDue: FleetPool = { ...p2, depositorOf: async () => ({ deposited: parseEther("0.1"), spent: 0n, exitRequestedAt: NOW - 3600n, exitAmount: parseEther("0.1") }) };
    e2([ALICE], true);
    const quiet = await createPoolService(wallet, publicClient, notDue, KEY, opts()).sweep(async () => [], { queueOwed: true });
    assert.equal(quiet.paused, undefined, "not due: nobody could have sent it yet");
    assert.equal(c2.filter((c) => c.fn === "pause").length, 0);
  });

  it("the opportunistic sweep never pulls the brake; the scheduled one does", async () => {
    const { pool, calls } = makePool([], [expiredCharge(3, NOW - 13n * 3600n)]);
    const service = createPoolService(wallet, publicClient, pool, KEY, opts());
    const opportunistic = await quietly(() => service.sweep(async () => []));
    assert.equal(opportunistic.paused, undefined);
    assert.equal(calls.filter((c) => c.fn === "pause").length, 0);
    await quietly(() => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(calls.filter((c) => c.fn === "pause").length, 1);
  });
});

describe("withdraw", () => {
  it("records the charge before it pays, so a failure between the two is recoverable", async () => {
    const { pool, calls } = makePool([]);
    const order: string[] = [];
    const o = opts();
    const store = {
      ...o.store,
      recordOwed: async (e: Parameters<typeof o.store.recordOwed>[0]) => { order.push("record"); return o.store.recordOwed(e); },
      markSent: async (...a: Parameters<typeof o.store.markSent>) => { order.push("name"); return o.store.markSent(...a); },
    };
    const paying: FleetPool = { ...pool, signAndBroadcast: async (step) => { const out = await pool.signAndBroadcast(step); order.push("pay"); return out; } };
    const service = createPoolService(wallet, publicClient, paying, KEY, { ...o, store });

    const receipt = await service.withdraw({ depositor: ALICE, amount: parseEther("0.01").toString(), destination: BOB });

    assert.deepEqual(order, ["record", "name", "pay"], "recorded, named by the payout's hash, then paid");
    assert.deepEqual(calls.filter((c) => c.fn === "transfer").map((c) => c.args), [[BOB, parseEther("0.01")]], "the payout is a plain transfer of the exact amount");
    assert.equal(typeof receipt.chargeId, "string");
    assert.deepEqual(await o.store.sentBatches(), [], "the payout mined: the charge stands as plain owed, for a later batch");
    assert.equal(await o.store.owedFor(ALICE), coarseCharge(parseEther("0.01")).toString());
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 0, "the payout and the charge never share the operator's transaction window");
  });
});

describe("an atomic buy", () => {
  it("funds and executes in one call, charges what the draw's spent moved by, and never rolls back", async () => {
    const funded = { ...draw(6, ALICE, parseEther("0.01")), state: DRAW_STATE.funded };
    const { pool, calls } = makePool([funded]);
    const o = opts();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);

    const report = await service.buy({
      campaign: campaign(6), depositor: ALICE, target: account(9),
      buys: [{ account: account(1), value: parseEther("0.001").toString(), callData: "0x", maxCost: parseEther("0.0001").toString() }],
    });

    assert.equal(report.results[0]?.status, "sponsored");
    assert.equal(calls.filter((c) => c.fn === "fundAndExecute").length, 1, "one transaction");
    assert.equal(calls.filter((c) => ["fundPrincipal", "commit", "rollback"].includes(c.fn)).length, 0, "no reservation, no commit, no rollback");
    assert.equal(calls.filter((c) => c.fn === "queueSpendBatch").length, 0, "the buy queues nothing: no depositor-keyed transaction follows it");
    assert.equal(await o.store.owedFor(ALICE), coarseCharge(parseEther("0.001") + 1000n).toString(), "the depositor owes the draw's spent delta, in coarse form");
  });

  it("reports a reverted buy as rejected, with nothing moved and nothing to roll back", async () => {
    const funded = { ...draw(7, ALICE, parseEther("0.01")), state: DRAW_STATE.funded };
    const { pool, calls, failBuys } = makePool([funded]);
    failBuys();
    const o = opts();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);

    const report = await service.buy({
      campaign: campaign(7), depositor: ALICE, target: account(9),
      buys: [{ account: account(1), value: "1", callData: "0x", maxCost: parseEther("0.0001").toString() }],
    });

    assert.equal(report.results[0]?.status, "rejected");
    assert.equal(report.results[0]?.reason, "CallFailed");
    assert.equal(calls.filter((c) => c.fn === "rollback").length, 0);
    assert.equal(await o.store.owedFor(ALICE), "0", "nothing charged for a buy that did not happen");
  });

  it("bounds the transaction by the gas ceiling", async () => {
    const funded = { ...draw(8, ALICE, parseEther("0.01")), state: DRAW_STATE.funded };
    const { pool, calls } = makePool([funded]);
    const service = createPoolService(wallet, publicClient, pool, KEY, opts());

    await service.buy({
      campaign: campaign(8), depositor: ALICE, target: account(9),
      buys: [{ account: account(1), value: "1", callData: "0x", maxCost: parseEther("0.0001").toString() }],
    });

    const call = calls.find((c) => c.fn === "fundAndExecute");
    assert.equal(call?.args[6], parseEther("0.0001") / 1_000_000_000n, "gas limit = ceiling / gas price");
  });
});

describe("coarse charges", () => {
  it("post strictly below the exact amount, on a grain, so a campaign-side amount never reappears depositor-side", () => {
    for (const exact of [CHARGE_GRAIN + 1n, GAS_HEADROOM, parseEther("0.0123"), parseEther("0.05") + 7n]) {
      const posted = coarseCharge(exact);
      assert.ok(posted < exact, `${posted} < ${exact}`);
      assert.equal(posted % CHARGE_GRAIN, 0n, "a multiple of the grain");
      assert.ok(exact - posted <= CHARGE_GRAIN, "the pool eats at most one grain");
    }
    assert.equal(coarseCharge(CHARGE_GRAIN), 0n, "a charge of one grain or less is the pool's");
    assert.equal(coarseCharge(1n), 0n);
  });
});

describe("constants", () => {
  it("keeps the service delay floor above the contract's 60 second floor", () => {
    assert.ok(MIN_DELAY_SECONDS > 60);
  });
  it("refuses a draw that could not fund its own fleet", () => {
    assert.equal(minimumDraw(5), GAS_HEADROOM * 5n + 1n);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { DRAW_STATE, type FleetPool, type PoolDraw, type PoolQueued, type SignedStep, type WriteOutcome } from "../../src/fleet/chain-pool.js";
import { createPoolService, type PoolPort } from "../../src/fleet/pool-buy.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { createMemoryStore, HELD, type StorePort } from "../../src/fleet/store.js";
import { createNeonStore } from "../../src/fleet/store-neon.js";

/**
 * The operator lock around each signed step (T026, T027, T029).
 *
 * One account signs for every instance of the service. An account has one
 * nonce sequence, and a node accepts a nonce once: two instances that read
 * the pending count together and sign together send two transactions with
 * one nonce, and the node refuses the second. The lock is held across
 * reading the nonce and broadcasting, for one step, and released between
 * steps, so a sweep does not hold the account for the length of a sweep.
 *
 * The node here keeps an account's nonce the way a node does: the pending
 * count is the next nonce it accepts, a lower one is refused, a higher one
 * waits for the gap and never mines. The store is Neon on a real Postgres,
 * shared by both instances, so the lock is the row the instances would share.
 */

const KEY = ledgerKey(`0x${"7".repeat(64)}`);
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const PAYEE = "0x0000000000000000000000000000000000009a7e" as Address;
const OPERATOR = "0x000000000000000000000000000000000000dead" as Address;
const campaign = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const NOW = 1_700_000_000n;
/** A round trip to the node: long enough that two unlocked readers are both inside it. */
const roundTrip = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

/** An account's nonce as a node keeps it. `broadcast` answers the way `eth_sendRawTransaction` would. */
const makeNode = (start = 5) => {
  const node = {
    pending: start,
    mined: [] as { nonce: number; hash: Hex }[],
    refused: [] as { nonce: number; reason: string }[],
    async broadcast(nonce: number, hash: Hex): Promise<WriteOutcome> {
      if (nonce < node.pending) { node.refused.push({ nonce, reason: "nonce too low" }); return { status: "unknown", hash, nonce }; }
      if (nonce > node.pending) { node.refused.push({ nonce, reason: "nonce gap: never mined" }); return { status: "unknown", hash, nonce }; }
      node.pending += 1;
      node.mined.push({ nonce, hash });
      return { status: "mined", hash };
    },
  };
  return node;
};

/** A pool whose signed step goes through the node. Reading the nonce is a round trip, so an unlocked rival reads the same one. */
const makePool = (node: ReturnType<typeof makeNode>, draws: PoolDraw[] = []) => {
  const queued: PoolQueued[] = [];
  const posted: Hex[] = [];
  const writes: string[] = [];
  let hashes = 0;
  const hash = (): Hex => `0x${(++hashes).toString(16).padStart(64, "0")}`;
  const pool = {
    address: OPERATOR,
    // The node answers with what it held when the request arrived; the answer takes the trip back.
    async nextNonce() { const answer = node.pending; await roundTrip(); return answer; },
    async signAndBroadcast(step: SignedStep) {
      const h = hash();
      await step.record(h, step.nonce);
      if (step.functionName === "queueSpendBatch") {
        const [refs, amounts, dueAts] = step.args as [readonly Hex[], readonly bigint[], readonly bigint[]];
        refs.forEach((ref, i) => queued.push({ id: hash(), encDepositor: ref, amount: amounts[i]!, dueAt: dueAts[i]!, queuedAt: NOW, posted: false }));
      }
      if (step.functionName === "fund") {
        const draw = draws.find((d) => d.campaign === (step.args as [Hex])[0]);
        if (draw) draw.state = DRAW_STATE.funded;
      }
      return node.broadcast(step.nonce, h);
    },
    async resolve(h: Hex, nonce: number) { return { status: "never-mined", hash: h, nonce }; },
    async depositorOf() { return { deposited: parseEther("0.5"), spent: 0n, exitRequestedAt: 0n, exitAmount: 0n }; },
    async headroom() { return { perDepositor: 0n, perPool: 0n }; },
    async caps() { return { depositor: parseEther("0.5"), draw: parseEther("0.2"), pool: parseEther("5") }; },
    async paused() { return false; },
    async draws() { return draws; },
    async drawOf(c: Hex) { return draws.find((d) => d.campaign === c); },
    async queued() { return queued; },
    async ledgerInputs() { return { deposited: parseEther("0.5"), spent: 0n, draws, queued }; },
    // The writes that do not go through the signed step yet: they still sign with the operator's key.
    async openDraw(c: Hex, amount: bigint, dueAt: bigint, ownerRef: Hex) { writes.push("openDraw"); draws.push({ campaign: c, amount, spent: 0n, reserved: 0n, principalOut: 0n, dueAt, ownerRef, state: DRAW_STATE.pending }); return hash(); },
    async topUpDraw() { writes.push("topUpDraw"); return hash(); },
    async closeDraw(c: Hex) { writes.push("closeDraw"); const d = draws.find((x) => x.campaign === c); if (d) d.state = DRAW_STATE.closed; return hash(); },
    async postQueued(id: Hex) { writes.push("postQueued"); const e = queued.find((q) => q.id === id); if (e) e.posted = true; posted.push(id); return hash(); },
    async pause() { writes.push("pause"); return hash(); },
  } as unknown as FleetPool;
  return { pool, queued, posted, writes };
};

const publicClient = {
  getBlock: async () => ({ timestamp: NOW }),
  getGasPrice: async () => 1_000_000_000n,
  getBalance: async () => parseEther("1"),
} as unknown as PublicClient;
const wallet = { account: { address: OPERATOR } } as unknown as WalletClient;

/** Two instances of the service over one store: what two warm functions are. */
const instances = (pool: FleetPool, store: StorePort, n = 2): PoolPort[] =>
  Array.from({ length: n }, () => createPoolService(wallet, publicClient, pool, KEY, { store, delaySeconds: () => -10, random: () => 0.5 }));

/** A store on a real Postgres, shared by every instance of a test. */
const shared = async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const sql = { query: async (q: string, params?: unknown[]) => (await db.query(q, params)).rows as Record<string, unknown>[] };
  const store = createNeonStore(sql, { pollMs: 2 });
  await store.initialize();
  return { store, close: () => db.close() };
};

/** The store as it was: a lock that locks nothing, so the test can show what the lock closes. */
const unlocked = (store: StorePort): StorePort => ({ ...store, withLock: (_name, work) => work(HELD) });

describe("two instances, one operator account", () => {
  it("two withdrawals at once are signed with two nonces, and both are paid", async () => {
    const node = makeNode();
    const { pool } = makePool(node);
    const { store, close } = await shared();
    try {
      const [a, b] = instances(pool, store);
      const [ra, rb] = await Promise.all([
        a!.withdraw({ depositor: ALICE, amount: parseEther("0.01").toString(), destination: PAYEE }),
        b!.withdraw({ depositor: BOB, amount: parseEther("0.02").toString(), destination: PAYEE }),
      ]);
      assert.deepEqual(node.refused, [], "the node refused nothing");
      assert.deepEqual(node.mined.map((m) => m.nonce).sort(), [5, 6], "one nonce each, in sequence");
      assert.equal(ra.unresolved, undefined);
      assert.equal(rb.unresolved, undefined);
    } finally {
      await close();
    }
  });

  it("without the lock the same two withdrawals read one nonce, and the node refuses the second: what the lock closes", async () => {
    const node = makeNode();
    const { pool } = makePool(node);
    const { store, close } = await shared();
    try {
      const [a, b] = instances(pool, unlocked(store));
      const results = await Promise.all([
        a!.withdraw({ depositor: ALICE, amount: parseEther("0.01").toString(), destination: PAYEE }),
        b!.withdraw({ depositor: BOB, amount: parseEther("0.02").toString(), destination: PAYEE }),
      ]);
      assert.deepEqual(node.refused.map((r) => r.reason), ["nonce too low"]);
      assert.equal(results.filter((r) => r.unresolved).length, 1, "one payout was never sent, and its charge waits on a hash that will never mine");
    } finally {
      await close();
    }
  });

  it("a sweep and a withdrawal at once: every signed step of the sweep takes its own turn", async () => {
    const node = makeNode();
    const draws = [1, 2, 3].map((n) => ({ campaign: campaign(n), amount: parseEther("0.02"), spent: 0n, reserved: 0n, principalOut: 0n, dueAt: NOW - 10n, ownerRef: sealDepositor(KEY, ALICE), state: DRAW_STATE.pending }));
    const { pool } = makePool(node, draws);
    const { store, close } = await shared();
    try {
      const [a, b] = instances(pool, store);
      await store.recordOwed({ id: "x", depositor: ALICE, amount: "5000", incurredAt: "2026-09-19T00:00:00Z" });
      const [report] = await Promise.all([
        a!.sweep(async () => [`0x${"1".repeat(40)}` as Address], { queueOwed: true }),
        b!.withdraw({ depositor: BOB, amount: parseEther("0.02").toString(), destination: PAYEE }),
      ]);
      assert.deepEqual(node.refused, []);
      assert.equal(report.funded.length, 3);
      assert.ok((report.queued ?? 0) >= 1, "the batch went, with the withdrawal's own charge in it or not, depending on who got to the store first");
      assert.deepEqual(node.mined.map((m) => m.nonce), [5, 6, 7, 8, 9], "one batch, three fundings, one payout: five steps, five nonces, none twice");
    } finally {
      await close();
    }
  });
});

describe("the lock is per step, not per sweep", () => {
  /** A store whose lock counts its holders and refuses to be taken twice at once. */
  const counting = () => {
    const memory = createMemoryStore();
    let depth = 0;
    const takes: string[] = [];
    const store: StorePort = {
      ...memory,
      async withLock(name, work) {
        takes.push(name);
        return memory.withLock(name, async (lease) => {
          depth += 1;
          assert.equal(depth, 1, "the operator lock is never held twice at once");
          try { return await work(lease); } finally { depth -= 1; }
        });
      },
    };
    return { store, takes };
  };

  it("a sweep that queues a batch, posts it and funds three draws takes the operator lock five times, once per signed step", async () => {
    const node = makeNode();
    const draws = [1, 2, 3].map((n) => ({ campaign: campaign(n), amount: parseEther("0.02"), spent: 0n, reserved: 0n, principalOut: 0n, dueAt: NOW - 10n, ownerRef: sealDepositor(KEY, ALICE), state: DRAW_STATE.pending }));
    const { pool } = makePool(node, draws);
    const { store, takes } = counting();
    const [service] = instances(pool, store, 1);
    await store.recordOwed({ id: "x", depositor: ALICE, amount: "5000", incurredAt: "2026-09-19T00:00:00Z" });
    const report = await service!.sweep(async () => [`0x${"1".repeat(40)}` as Address], { queueOwed: true });
    assert.equal(report.funded.length, 3);
    assert.equal(report.queued, 1);
    assert.equal(report.posted.length, 1, "the charge was due at once (the test's delay is negative), so the same sweep posted it");
    assert.equal(takes.filter((t) => t === "operator").length, 5);
  });

  it("the writes that do not go through the signed step yet still take the lock: a draw opened, topped up, closed, a posting, the brake", async () => {
    const node = makeNode();
    const { pool, queued } = makePool(node);
    const { store, takes } = counting();
    const [service] = instances(pool, store, 1);
    await service!.openDraw({ campaign: campaign(9), depositor: ALICE, amount: parseEther("0.02").toString() });
    await service!.topUpDraw({ campaign: campaign(9), amount: parseEther("0.01").toString() });
    await service!.closeDraw(campaign(9));
    queued.push({ id: campaign(77), encDepositor: sealDepositor(KEY, ALICE), amount: 5000n, dueAt: NOW - 10n, queuedAt: NOW - 100n, posted: false });
    const report = await service!.sweep(async () => []);
    assert.deepEqual(report.posted, [campaign(77)]);
    assert.equal(takes.filter((t) => t === "operator").length, 4);
  });
});

describe("a lease lost before the broadcast", () => {
  /** A store whose lease answers "lost" once the holder asks: the TTL passed and another instance took the lock. */
  const losing = () => {
    const memory = createMemoryStore();
    const store: StorePort = { ...memory, withLock: (_name, work) => work({ renew: async () => undefined, held: async () => false }) };
    return store;
  };

  it("a batch is not broadcast, and its rows go back to the next sweep", async () => {
    const node = makeNode();
    const { pool, queued } = makePool(node);
    const store = losing();
    const [service] = instances(pool, store, 1);
    await store.recordOwed({ id: "x", depositor: ALICE, amount: "5000", incurredAt: "2026-09-19T00:00:00Z" });
    const silenced = console.error;
    console.error = () => undefined;
    const report = await service!.sweep(async () => [], { queueOwed: true }).finally(() => { console.error = silenced; });
    assert.equal(report.queued, 0);
    assert.deepEqual(node.mined, [], "nothing reached the node");
    assert.deepEqual(queued, []);
    assert.deepEqual((await store.takeOwed(10)).map((o) => o.id), ["x"], "the row is owed again, not sent under a hash nobody broadcast");
  });

  it("a payout is refused, and its charge is void", async () => {
    const node = makeNode();
    const { pool } = makePool(node);
    const store = losing();
    const [service] = instances(pool, store, 1);
    await assert.rejects(service!.withdraw({ depositor: ALICE, amount: parseEther("0.01").toString(), destination: PAYEE }), /OperatorLockLost/);
    assert.deepEqual(node.mined, []);
    assert.equal(await store.owedFor(ALICE), "0", "nothing is owed for a payout that never happened");
  });
});

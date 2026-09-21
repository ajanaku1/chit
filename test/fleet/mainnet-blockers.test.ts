import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPublicClient, encodeAbiParameters, http, keccak256, parseEther,
  type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService } from "../../src/fleet/campaign-service.js";
import type { FleetPool, PoolDraw, PoolQueued } from "../../src/fleet/chain-pool.js";
import { DRAW_STATE, createFleetPool } from "../../src/fleet/chain-pool.js";
import { planSlices } from "../../src/fleet/order-plan.js";
import { CHARGE_GRAIN, coarseCharge, createPoolService, type PoolPort } from "../../src/fleet/pool-buy.js";
import { ledgerKey, openDepositor, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { fleetChain } from "../../src/fleet/service-runtime.js";
import { createMemoryStore, type StorePort } from "../../src/fleet/store.js";
import { UNIVERSAL_ROUTER_EXECUTE, encodeBuyCall, venuePoolKey } from "../../src/fleet/v4-swap.js";

/**
 * Mainnet readiness: each `finding_*` reproduces one item of
 * chit-fleet-mainnet-readiness-2026-09-19.md against the service as it is at
 * 40aee16. They PASS today, in the idiom of the pre-audit's `test_finding_*`:
 * the assertion states the behaviour that has to change, and the fix flips it.
 */

const KEY = ledgerKey(`0x${"7".repeat(64)}`);
const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const campaign = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const account = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

const NOW = 1_700_000_000n;

const publicClient = {
  getBlock: async () => ({ timestamp: NOW }),
  getGasPrice: async () => 1_000_000_000n,
  waitForTransactionReceipt: async () => ({ status: "success" }),
} as unknown as PublicClient;

const wallet = {
  account: { address: account(0xdead) },
  chain: null,
  sendTransaction: async () => `0x${"a".repeat(64)}`,
} as unknown as WalletClient;

/** A pool that keeps what it is told the way the chain would: a queued batch is on chain once sent. */
const makePool = (draws: PoolDraw[] = []) => {
  const queued: PoolQueued[] = [];
  const posted: { id: Hex; depositor: Address; amount: bigint }[] = [];
  const knobs = { batchLandsThenReceiptFails: false, buyLandsThenReceiptFails: false, postingFails: false };
  let n = 0;
  const pool = {
    address: account(0x901),
    depositorOf: async () => ({ deposited: 0n, spent: 0n, exitRequestedAt: 0n, exitAmount: 0n }),
    headroom: async () => ({ perDepositor: 0n, perPool: 0n }),
    paused: async () => false,
    draws: async () => draws,
    drawOf: async (c: Hex) => draws.find((d) => d.campaign === c),
    queued: async () => queued,
    ledgerInputs: async () => ({ deposited: 0n, spent: 0n, draws, queued }),
    queueSpendBatch: async (refs: readonly Hex[], amounts: readonly bigint[], dueAts: readonly bigint[]) => {
      refs.forEach((ref, i) => {
        n += 1;
        queued.push({ id: `0x${n.toString(16).padStart(64, "0")}`, encDepositor: ref, amount: amounts[i]!, dueAt: dueAts[i]!, queuedAt: NOW, posted: false });
      });
      // chain-pool.ts write(): writeContract resolved, the transaction is mined,
      // and then waitForTransactionReceipt gives up on an RPC that dropped the poll.
      if (knobs.batchLandsThenReceiptFails) throw new Error("WaitForTransactionReceiptTimeoutError: Timed out while waiting for transaction");
      return `0x${"c".repeat(64)}` as Hex;
    },
    postQueued: async (id: Hex, depositor: Address) => {
      if (knobs.postingFails) throw new Error("HttpRequestError: the RPC dropped the request");
      const entry = queued.find((q) => q.id === id)!;
      entry.posted = true;
      posted.push({ id, depositor, amount: entry.amount });
      return "0x01" as Hex;
    },
    fundAndExecute: async (c: Hex, _account: Address, principal: bigint) => {
      const d = draws.find((x) => x.campaign === c)!;
      d.spent += principal + 1_000n;
      if (knobs.buyLandsThenReceiptFails) throw new Error("WaitForTransactionReceiptTimeoutError: Timed out while waiting for transaction");
      return `0x${"b".repeat(64)}` as Hex;
    },
    fund: async () => "0x01" as Hex,
  } as unknown as FleetPool;
  return { pool, queued, posted, knobs };
};

const funded = (n: number, owner: Address, amount: bigint): PoolDraw => ({
  campaign: campaign(n), amount, spent: 0n, reserved: 0n, principalOut: 0n,
  dueAt: NOW - 1_000n, ownerRef: sealDepositor(KEY, owner), state: DRAW_STATE.funded,
});

/** Due times land in the past, so the sweep that follows a batch can post it. */
const opts = () => ({ delaySeconds: () => -10, store: createMemoryStore(), random: () => 0.5 });

describe("M1: a withdrawal whose payout fails", () => {
  it("finding_M1: still charges the trader, the next sweep puts the charge on chain, and the store has no way to void it", async () => {
    const o = opts();
    const { pool, posted } = makePool();
    // The operator's wallet is short: exactly what an unreimbursed float runs into (M2).
    const broke = { ...wallet, sendTransaction: async () => { throw new Error("insufficient funds for gas * price + value"); } } as unknown as WalletClient;
    const service = createPoolService(broke, publicClient, pool, KEY, o);

    await assert.rejects(
      service.withdraw({ depositor: ALICE, amount: parseEther("0.04").toString(), destination: BOB }),
      /insufficient funds/,
    );
    assert.equal(await o.store.owedFor(ALICE), coarseCharge(parseEther("0.04")).toString(), "nothing was paid and the charge stands");

    await service.sweep(async () => [], { queueOwed: true });
    assert.deepEqual(posted.map((p) => [p.depositor.toLowerCase(), p.amount]), [[ALICE, coarseCharge(parseEther("0.04"))]], "posted to Alice on chain");
    assert.deepEqual(Object.keys(o.store).filter((k) => /void|cancel|delete|remove/i.test(k)), [], "StorePort has no cancel path");
  });
});

describe("M4: a transaction that lands while its receipt wait fails", () => {
  it("finding_M4a: a batch that landed is released and queued again, so the trader is charged twice", async () => {
    const o = opts();
    const { pool, posted, knobs } = makePool();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    await o.store.recordOwed({ id: "one-buy", depositor: ALICE, amount: "5000", incurredAt: "2026-09-19T00:00:00Z" });

    knobs.batchLandsThenReceiptFails = true;
    await service.sweep(async () => [], { queueOwed: true });
    knobs.batchLandsThenReceiptFails = false;
    await service.sweep(async () => [], { queueOwed: true });
    await service.sweep(async () => []);

    const charged = posted.filter((p) => p.depositor.toLowerCase() === ALICE).reduce((sum, p) => sum + p.amount, 0n);
    assert.equal(charged, 10_000n, "one buy of 5000, posted twice");
  });

  it("finding_M4b: a buy that landed is reported rejected and never charged, so the pool pays for it", async () => {
    const o = opts();
    const draw = funded(1, ALICE, parseEther("0.05"));
    const { pool, knobs } = makePool([draw]);
    const service = createPoolService(wallet, publicClient, pool, KEY, o);

    knobs.buyLandsThenReceiptFails = true;
    const report = await service.buy({
      campaign: campaign(1), depositor: ALICE, target: account(0x10),
      buys: [{ account: account(1), value: parseEther("0.01").toString(), callData: "0x", maxCost: parseEther("0.0001").toString() }],
    });

    assert.equal(report.results[0]?.status, "rejected");
    assert.equal(draw.spent, parseEther("0.01") + 1_000n, "the chain charged the draw");
    assert.equal(await o.store.owedFor(ALICE), "0", "and nobody charged Alice");
  });
});

describe("M3: the sweep", () => {
  it("finding_M3a: a posting that fails is dropped without a word and without a count", async () => {
    const o = opts();
    const { pool, queued, knobs } = makePool();
    const service = createPoolService(wallet, publicClient, pool, KEY, o);
    await o.store.recordOwed({ id: "x", depositor: ALICE, amount: "5000", incurredAt: "2026-09-19T00:00:00Z" });

    const logged: unknown[] = [];
    const original = { error: console.error, warn: console.warn, log: console.log };
    console.error = console.warn = console.log = (...args: unknown[]) => { logged.push(args); };
    knobs.postingFails = true;
    const report = await service.sweep(async () => [], { queueOwed: true }).finally(() => Object.assign(console, original));

    assert.equal(report.queued, 1, "the charge is on chain and due");
    assert.equal(queued.filter((q) => !q.posted).length, 1, "postQueued was tried and failed");
    assert.deepEqual(report.posted, [], "nothing was posted");
    assert.deepEqual(logged, [], "and nothing was logged: not the window, not the RPC error this was");
    assert.deepEqual(Object.keys(report).sort(), ["funded", "posted", "queued"], "the report has no field for a failed posting");
  });

  it("finding_M3b: one balance read costs 2N + M + 3 reads, and each loop has one request in flight at a time", async () => {
    const N = 20, M = 100;
    let calls = 0, inFlight = 0, widest = 0;
    const counting = {
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        calls += 1; inFlight += 1; widest = Math.max(widest, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        switch (functionName) {
          case "campaignCount": return BigInt(N);
          case "campaignAt": return campaign(Number(args![0]) + 1);
          case "drawOf": return { amount: 1n, spent: 0n, reserved: 0n, principalOut: 0n, dueAt: 0n, ownerRef: "0x", state: DRAW_STATE.closed };
          case "queuedSpendCount": return BigInt(M);
          case "queuedSpendAt": return [campaign(Number(args![0]) + 1), { encDepositor: "0x", amount: 1n, dueAt: 0n, queuedAt: 1n, posted: true }];
          case "depositorOf": return [0n, 0n, 0n, 0n];
          default: throw new Error(functionName);
        }
      },
    } as unknown as PublicClient;
    await createFleetPool(wallet, counting, account(0x901)).ledgerInputs(ALICE);

    assert.equal(calls, 2 * N + M + 3, "every closed draw and every posted spend, read again on every balance");
    assert.equal(widest, 3, "three chains of awaited calls: batch: true on the transport has nothing to batch");
  });

  // Replaces finding_M3c (T046), which built its own chain and so could not see the fix:
  // this one takes the chain the service itself builds its clients from.
  it("fixed_M3c: the service's chain states its block time, so viem polls a receipt every half second, not every four", () => {
    const client = createPublicClient({ chain: fleetChain("http://127.0.0.1:1"), transport: http("http://127.0.0.1:1", { batch: true }) });
    assert.equal(client.pollingInterval, 500);
  });
});

describe("M5: the operator lock", () => {
  it("finding_M5: the scheduled sweep signs with the operator key while holding no lock", async () => {
    const held: string[] = [];
    const memory = createMemoryStore();
    const store: StorePort = {
      ...memory,
      withLock: async (name, work) => { held.push(name); try { return await work(); } finally { held.pop(); } },
    };
    let locksDuringSweep: string[] | undefined;
    const pool = {
      sweep: async () => { locksDuringSweep = [...held]; return { funded: [], posted: [], queued: 0 }; },
    } as unknown as PoolPort;
    const service = new CampaignService({ origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 }, { store });
    const router = new CampaignRouter({ service, store, pool } as RouterDeps);

    const result = await router.handle({ action: "sweep", body: {} });

    assert.equal(result.status, 200);
    assert.deepEqual(locksDuringSweep, [], "queueSpendBatch, postQueued and fund are sent with the operator lock free");
  });
});

describe("M6: the venue", () => {
  const CHIT = "0xd523a627030509021cc39b6d7c8543417d3e50d8" as Address;
  const POOL_KEY = [
    { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" },
  ] as const;
  const idOf = (k: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): Hex =>
    keccak256(encodeAbiParameters(POOL_KEY, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

  it("finding_M6: a fleet buy of CHIT is quoted and routed against a pool that does not exist on 4663", () => {
    // deployments/buyback-4663.json: the pool CHIT trades in on mainnet.
    const recorded = { currency0: `0x${"0".repeat(40)}` as Address, currency1: CHIT, fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address };
    assert.equal(idOf(recorded), "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41", "the record's own poolId, as a check on this arithmetic");

    // market.ts quotes poolId(venuePoolKey(token)); campaign-routes.ts encodes the buy with encodeBuyCall, which takes no pool key.
    assert.notEqual(idOf(venuePoolKey(CHIT)), idOf(recorded));
    const data = encodeBuyCall(UNIVERSAL_ROUTER_EXECUTE, CHIT, parseEther("0.01"), new Date(0), 1n).toLowerCase();
    assert.ok(!data.includes("e5e702641ea86f4ae6cc3cdaed2b886f976be044"), "the buy never names the hook");
    assert.ok(data.includes("0".repeat(60) + "0bb8"), "it names the testnet venue's 0.30% fee tier");
  });
});

describe("P1: the amount join", () => {
  it("finding_P1: every charge in a batch maps back to exactly one campaign-keyed buy", () => {
    const order = (seed: number, owner: Address) => ({
      campaign: `c-${seed}`, token: account(0xfee), totalWei: parseEther("0.05").toString(),
      wallets: [1, 2, 3, 4, 5].map((i) => account(seed * 16 + i)), seed: campaign(seed),
      windowMs: 300_000, createdAt: "2026-09-19T00:00:00.000Z", owner,
    });
    // Four traders place the same order in the same sweep window. `actual` is what
    // Committed(campaign, actual) publishes: the slice plus gas (250k gas at 0.1 gwei here).
    const committed = [1, 2, 3, 4].flatMap((seed) =>
      planSlices(order(seed, account(0xa0 + seed)), parseEther("0.2").toString()).map((slice) => ({
        campaign: `c-${seed}`, actual: BigInt(slice.amountWei) + 250_000n * 100_000_000n,
      })));
    assert.equal(committed.length, 20);

    // SpendQueued(id, amount, dueAt) publishes coarseCharge(actual); the function is in the public mirror.
    const queuedAmounts = committed.map((c) => coarseCharge(c.actual));
    for (const amount of queuedAmounts) {
      const candidates = committed.filter((c) => coarseCharge(c.actual) === amount);
      assert.equal(candidates.length, 1, "one candidate: the charge names its campaign");
    }
    assert.ok(CHARGE_GRAIN === parseEther("0.00001"));
    // postQueued(bytes32 id, address depositor) then puts that id beside the depositor in calldata.
    assert.ok(openDepositor(KEY, sealDepositor(KEY, ALICE)));
  });
});

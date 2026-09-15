import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { FleetPool, PoolDraw, PoolQueued } from "../../src/fleet/chain-pool.js";
import { DRAW_STATE } from "../../src/fleet/chain-pool.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { GAS_HEADROOM, MIN_DELAY_SECONDS, createPoolService, minimumDraw } from "../../src/fleet/pool-buy.js";

/**
 * The pool service's money operations, against a pool that records what it
 * is asked and can be told to refuse. These are the audit findings A1, A3,
 * A11, A12 and A37 as behaviour: a sweep that survives one bad draw, headroom
 * that is charged, a withdrawal that is recorded before it is paid, a mined
 * buy that is never rolled back, and a delay floor above the contract's.
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
  const pool: FleetPool = {
    address: "0x0000000000000000000000000000000000000901" as Address,
    depositorOf: async () => ({ deposited: 0n, spent: 0n, exitRequestedAt: 0n, exitAmount: 0n }),
    headroom: async () => ({ perDepositor: 0n, perPool: 0n }),
    paused: async () => false,
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
    commit: async (...args) => {
      calls.push({ fn: "commit", args });
      if (commitFailures > 0) { commitFailures -= 1; throw new Error("rpc: nonce too low"); }
      return "0x01";
    },
    rollback: async (...args) => { calls.push({ fn: "rollback", args }); return "0x01"; },
    closeDraw: async (...args) => { calls.push({ fn: "closeDraw", args }); return "0x01"; },
    queueSpend: async (...args) => { calls.push({ fn: "queueSpend", args }); return "0x01"; },
    postQueued: async (...args) => { calls.push({ fn: "postQueued", args }); return "0x01"; },
    claimable: async () => 0n,
    claimOperator: async () => "0x01",
  };
  return {
    pool, calls,
    refuse: (c: Hex) => { refuseFund = new Set([...refuseFund, c]); },
    failCommits: (n: number) => { commitFailures = n; },
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
  getGasPrice: async () => 1_000_000_000n,
  waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 50_000n, effectiveGasPrice: 1_000_000_000n }),
} as unknown as PublicClient;

const draw = (n: number, owner: Address, amount: bigint, spent = 0n): PoolDraw => ({
  campaign: campaign(n), amount, spent, reserved: 0n, principalOut: 0n,
  dueAt: 1_699_999_000n, ownerRef: sealDepositor(KEY, owner), state: DRAW_STATE.pending,
});

describe("sweep", () => {
  it("posts every due charge and funds every other draw when one draw cannot be funded", async () => {
    const queued: PoolQueued[] = [
      { id: 0n, encDepositor: sealDepositor(KEY, ALICE), amount: 1n, dueAt: 1_699_999_000n, queuedAt: 1_699_998_000n, posted: false },
    ];
    const { pool, calls, refuse } = makePool([draw(1, ALICE, parseEther("0.01")), draw(2, BOB, parseEther("0.01"))], queued);
    refuse(campaign(1));
    const service = createPoolService(wallet, publicClient, pool, KEY, { delaySeconds: () => 120 });

    const report = await service.sweep(async () => [account(1), account(2)]);

    assert.deepEqual(report.posted, ["0"], "the charge was posted although the first draw failed");
    assert.deepEqual(report.funded, [campaign(2)], "the second draw was funded although the first failed");
    const order = calls.map((c) => c.fn);
    assert.equal(order.indexOf("postQueued") < order.indexOf("fund"), true, "charges are posted before any draw is funded");
  });

  it("skips a draw smaller than its own headroom instead of reverting on it every sweep", async () => {
    const tiny = draw(3, ALICE, GAS_HEADROOM * 2n - 1n);
    const { pool, calls } = makePool([tiny, draw(4, BOB, parseEther("0.01"))]);
    const service = createPoolService(wallet, publicClient, pool, KEY, { delaySeconds: () => 120 });

    const report = await service.sweep(async () => [account(1), account(2)]);

    assert.deepEqual(report.funded, [campaign(4)]);
    assert.equal(calls.filter((c) => c.fn === "fund" && (c.args[0] as Hex) === campaign(3)).length, 0, "fund was never attempted for the tiny draw");
  });

  it("charges the seeded headroom to the depositor, queued like any other spend", async () => {
    const { pool, calls } = makePool([draw(5, ALICE, parseEther("0.01"))]);
    const service = createPoolService(wallet, publicClient, pool, KEY, { delaySeconds: () => 120 });

    await service.sweep(async () => [account(1), account(2), account(3)]);

    const queue = calls.find((c) => c.fn === "queueSpend");
    assert.ok(queue, "a charge was queued after funding");
    assert.equal(queue.args[1], GAS_HEADROOM * 3n, "for exactly the headroom that left the pool");
    assert.equal(queue.args[2], 1_700_000_000n + 120n, "on its own timer, not in the funding transaction");
  });
});

describe("withdraw", () => {
  it("records the charge before it pays, so a failure between the two is recoverable", async () => {
    const { pool } = makePool([]);
    const order: string[] = [];
    const recording: FleetPool = { ...pool, queueSpend: async (...args) => { order.push("queue"); return pool.queueSpend(...args); } };
    const w = { ...wallet, sendTransaction: async () => { order.push("pay"); return `0x${"a".repeat(64)}`; } } as unknown as WalletClient;
    const service = createPoolService(w, publicClient, recording, KEY, { delaySeconds: () => 120 });

    await service.withdraw({ depositor: ALICE, amount: parseEther("0.01").toString(), destination: BOB });

    assert.deepEqual(order, ["queue", "pay"]);
  });
});

describe("a mined buy", () => {
  it("is never rolled back when only the commit fails; the commit is retried and the buy reported", async () => {
    const funded = { ...draw(6, ALICE, parseEther("0.01")), state: DRAW_STATE.funded };
    const { pool, calls, failCommits } = makePool([funded]);
    failCommits(1);
    const service = createPoolService(wallet, publicClient, pool, KEY, { delaySeconds: () => 120 });

    const report = await service.buy({
      campaign: campaign(6), depositor: ALICE, target: account(9),
      buys: [{ account: account(1), value: parseEther("0.001").toString(), callData: "0x", maxCost: parseEther("0.0001").toString() }],
    });

    assert.equal(report.results[0]?.status, "sponsored");
    assert.equal(calls.filter((c) => c.fn === "commit").length, 2, "the commit was retried once");
    assert.equal(calls.filter((c) => c.fn === "rollback").length, 0, "and nothing was rolled back");
  });

  it("bounds the execute transaction by the gas ceiling", async () => {
    const funded = { ...draw(7, ALICE, parseEther("0.01")), state: DRAW_STATE.funded };
    const { pool } = makePool([funded]);
    let seen: { gas?: bigint } = {};
    const w = { ...wallet, writeContract: async (req: { gas?: bigint }) => { seen = req; return `0x${"b".repeat(64)}`; } } as unknown as WalletClient;
    const service = createPoolService(w, publicClient, pool, KEY, { delaySeconds: () => 120 });

    await service.buy({
      campaign: campaign(7), depositor: ALICE, target: account(9),
      buys: [{ account: account(1), value: "1", callData: "0x", maxCost: parseEther("0.0001").toString() }],
    });

    assert.equal(seen.gas, parseEther("0.0001") / 1_000_000_000n, "gas limit = ceiling / gas price");
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

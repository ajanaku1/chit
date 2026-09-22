import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { parseEther, type Address, type Hex } from "viem";

import { createFleetPool } from "../../src/fleet/chain-pool.js";
import { guardianFromEnv } from "../../src/fleet/deploy-guards.js";
import { createPoolService } from "../../src/fleet/pool-buy.js";
import { MAINNET_BETA_CAPS, capsFromEnv } from "../../src/fleet/pool-caps.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { connectRobinhoodMainnetFork } from "./robinhood-fork.js";

/**
 * The launch rehearsal on a fork of Robinhood Chain mainnet (T089, T090;
 * FR-040's rehearsal, SC-012). The beta's own pool is deployed on the fork
 * with the beta's caps and a guardian, and each thing the runbook says must
 * be true is made to happen: the caps read back as specified; deployment is
 * refused without a guardian, and with a guardian that is the operator; the
 * guardian pauses without the operator touching anything; an exit completes
 * while the pool is paused; and each of FR-026's three pause triggers is
 * fired, the two machine-detectable ones by the scheduled sweep itself
 * (charge expired unrecorded; an exit that would fail) and the third, a
 * depositor's loss, by the hand that confirms it, inside the fifteen minutes
 * FR-034 allows.
 *
 * Nothing here is sent to the chain: the fork is discarded when the run ends.
 */
describe("the mainnet beta rehearsed on the 4663 fork", () => {
  const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;
  const OWNER_REF = `0x${"ab".repeat(16)}` as const;
  const DAY = 24 * 3600;

  let viem: Awaited<ReturnType<typeof connectRobinhoodMainnetFork>>["viem"];

  before(async () => {
    ({ viem } = await connectRobinhoodMainnetFork());
  });

  const travel = async (seconds: number) => {
    const test = await viem.getTestClient();
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  };

  /** The beta's pool as the redeploy script makes it: the deployer as admin, the operator its own key, a guardian that is neither. */
  const deployed = async () => {
    const [admin, operator, guardian, alice] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const caps = capsFromEnv(4663, {});
    const pool = await viem.deployContract("FleetPool", [admin!.account.address, operator!.account.address, caps.depositor, caps.draw, caps.pool]);
    await pool.write.setGuardian([guardian!.account.address], { account: admin!.account });
    return { admin: admin!, operator: operator!, guardian: guardian!, alice: alice!, publicClient, pool, caps };
  };

  const quietly = async <T,>(work: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => {};
    try { return await work(); } finally { console.error = original; }
  };

  it("T089: the deployed caps read back as the specification states them, on chain 4663", async () => {
    const { pool, publicClient } = await deployed();
    assert.equal(await publicClient.getChainId(), 4663);
    assert.equal(await pool.read.DEPOSITOR_CAP(), parseEther("0.1"));
    assert.equal(await pool.read.DRAW_CAP(), parseEther("0.05"));
    assert.equal(await pool.read.POOL_CAP(), parseEther("1"));
    assert.deepEqual(capsFromEnv(4663, {}), MAINNET_BETA_CAPS, "the environment adds nothing on the day: the caps are the spec's");
    const { pool: read } = await deployed();
    const view = createFleetPool((await viem.getWalletClients())[1]!, publicClient, read.address as Address);
    assert.deepEqual(await view.caps(), MAINNET_BETA_CAPS, "and the service reads the same three numbers from the pool");
  });

  it("T089: deployment is refused without a guardian, and with a guardian that is the operator", async () => {
    const operator = (await viem.getWalletClients())[1]!.account.address;
    assert.throws(() => guardianFromEnv({}, operator, true), /needs a guardian before anything is deployed/);
    assert.throws(() => guardianFromEnv({ FLEET_GUARDIAN_ADDRESS: operator }, operator, true), /must not be the operator/);
    const other = (await viem.getWalletClients())[2]!.account.address;
    assert.equal(guardianFromEnv({ FLEET_GUARDIAN_ADDRESS: other }, operator, true)?.toLowerCase(), other.toLowerCase());
  });

  it("T089: the guardian pauses without the operator, the operator cannot unpause, and an exit completes while paused", async () => {
    const { admin, operator, guardian, alice, pool, publicClient } = await deployed();
    await pool.write.deposit({ account: alice.account, value: parseEther("0.1") });
    await pool.write.requestExit({ account: alice.account });

    const operatorNonce = await publicClient.getTransactionCount({ address: operator.account.address });
    await pool.write.pause({ account: guardian.account });
    assert.equal(await pool.read.paused(), true, "the brake is the guardian's alone");
    assert.equal(await publicClient.getTransactionCount({ address: operator.account.address }), operatorNonce, "the operator signed nothing");

    await assert.rejects(pool.write.setPaused([false], { account: operator.account }), "unpausing is the admin's, never the hot key's");
    await assert.rejects(pool.write.deposit({ account: alice.account, value: parseEther("0.01") }), "a paused pool takes no deposit");

    await travel(DAY + 1);
    const before = await publicClient.getBalance({ address: alice.account.address });
    await pool.write.executeExit({ account: alice.account });
    const after = await publicClient.getBalance({ address: alice.account.address });
    assert.ok(after - before > parseEther("0.099"), `the exit paid while paused: ${after - before}`);
    assert.equal(await pool.read.paused(), true, "and the pool stayed paused");

    await pool.write.setPaused([false], { account: admin.account });
    assert.equal(await pool.read.paused(), false, "the admin resumes");
  });

  it("T090: a charge that passes its deadline unrecorded pauses the pool from the scheduled sweep, with no hand on it", async () => {
    const { operator, alice, pool, publicClient } = await deployed();
    await pool.write.deposit({ account: alice.account, value: parseEther("0.1") });
    const chain = createFleetPool(operator, publicClient, pool.address as Address);
    const service = createPoolService(operator, publicClient, chain, ledgerKey(OPERATOR_KEY), { delaySeconds: () => 120 });

    // A charge queued by an earlier instance, due in a minute, then never posted: the window passes on chain.
    const block = await publicClient.getBlock();
    await pool.write.queueSpendBatch([[sealDepositor(ledgerKey(OPERATOR_KEY), alice.account.address as Address)], [parseEther("0.01")], [block.timestamp + 60n]], { account: operator.account });
    await travel(13 * 3600);

    const report = await quietly(() => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(report.paused?.trigger, "charge-expired");
    assert.equal(await pool.read.paused(), true, "the pool is paused on chain by the sweep that saw it");
    assert.equal(report.expired?.length, 1, "and the charge is reported as expired, not posted");
  });

  it("T090: an exit that would fail if sent pauses the pool from the scheduled sweep", async () => {
    const { operator, alice, pool, publicClient } = await deployed();
    await pool.write.deposit({ account: alice.account, value: parseEther("0.1") });
    const chain = createFleetPool(operator, publicClient, pool.address as Address);
    const service = createPoolService(operator, publicClient, chain, ledgerKey(OPERATOR_KEY), { delaySeconds: () => 120 });

    // The pool has paid a draw's principal out and nothing is posted yet, so a full exit would revert on the transfer.
    const campaign = `0x${"c9".repeat(32)}` as Hex;
    const block = await publicClient.getBlock();
    await pool.write.openDraw([campaign, parseEther("0.05"), block.timestamp + 300n, OWNER_REF], { account: operator.account });
    await travel(301);
    await pool.write.fund([campaign, ["0x0000000000000000000000000000000000000a01"]], { account: operator.account });
    await pool.write.fundPrincipal([campaign, "0x0000000000000000000000000000000000000a01", parseEther("0.045"), 0n], { account: operator.account });
    await pool.write.requestExit({ account: alice.account });
    await travel(DAY + 1);
    await assert.rejects(pool.write.executeExit({ account: alice.account }), "the exit itself fails: the pool is short");

    const report = await quietly(() => service.sweep(async () => [], { queueOwed: true }));
    assert.equal(report.paused?.trigger, "exit-failed");
    assert.ok(!report.paused?.detail.join(" ").toLowerCase().includes(alice.account.address.toLowerCase()), "the depositor is never named");
    assert.equal(await pool.read.paused(), true);
  });

  it("T090: a depositor's loss is the trigger a hand confirms; the guardian's pause lands inside fifteen minutes and the exit stays reachable", async () => {
    const { guardian, alice, pool, publicClient } = await deployed();
    await pool.write.deposit({ account: alice.account, value: parseEther("0.1") });
    const confirmedAt = (await publicClient.getBlock()).timestamp;
    await pool.write.pause({ account: guardian.account });
    const pausedAt = (await publicClient.getBlock()).timestamp;
    assert.ok(pausedAt - confirmedAt < 15n * 60n, "FR-034: within fifteen minutes of confirmation");
    assert.equal(await pool.read.paused(), true);
    await pool.write.requestExit({ account: alice.account });
    const chain = createFleetPool(guardian, publicClient, pool.address as Address);
    assert.deepEqual((await chain.exitsRequested!()).map((a) => a.toLowerCase()), [alice.account.address.toLowerCase()], "the exit is on its way while paused");
    assert.equal(await chain.exitWouldFail!(alice.account.address as Address), true, "not due yet, so it would revert today");
    await travel(DAY + 1);
    assert.equal(await chain.exitWouldFail!(alice.account.address as Address), false, "and goes through once due, pool still paused");
  });
});

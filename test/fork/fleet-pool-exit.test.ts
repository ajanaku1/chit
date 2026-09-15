import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";
import { TESTNET_CAPS } from "../../src/fleet/pool-caps.js";

/**
 * The self-serve exit (FR-011, SC-007): a trader recovers deposit minus posted
 * spend from the contract alone, after the delay, with Chit gone. This is the
 * promise that makes semi-custody acceptable, so it must not depend on the
 * operator being alive at exit time.
 */
describe("FleetPool self-serve exit", () => {
  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];
  let operator: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getWalletClients"]>>[number];
  let alice: typeof operator;

  before(async () => {
    ({ viem } = await network.connect({ network: "default" }));
    [operator, alice] = await viem.getWalletClients();
  });

  const DAY = 24 * 60 * 60;

  const funded = async () => {
    const pool = await viem.deployContract("FleetPool", [operator!.account.address, operator!.account.address, TESTNET_CAPS.depositor, TESTNET_CAPS.draw, TESTNET_CAPS.pool]);
    await pool.write.deposit({ account: alice!.account, value: parseEther("0.1") });
    return pool;
  };

  const travel = async (seconds: number) => {
    const test = await viem.getTestClient();
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  };

  it("pays deposit minus posted spend after the delay, with no operator action", async () => {
    const pool = await funded();
    const publicClient = await viem.getPublicClient();
    const enc = `0x${"e1".repeat(32)}` as const;
    await pool.write.queueSpendBatch([[enc], [parseEther("0.02")], [0n]]);
    const [id] = await pool.read.queuedSpendAt([0n]);
    await pool.write.postQueued([id, alice!.account.address]);

    await pool.write.requestExit({ account: alice!.account });
    await assert.rejects(pool.write.executeExit({ account: alice!.account }), "the delay is not optional");

    await travel(DAY + 1);
    const before = await publicClient.getBalance({ address: alice!.account.address });
    await pool.write.executeExit({ account: alice!.account });
    const after = await publicClient.getBalance({ address: alice!.account.address });
    assert.ok(after > before, "the trader was paid");
    // 0.1 deposited − 0.02 posted spend = 0.08, minus this call's own gas.
    assert.ok(after - before > parseEther("0.079"), `paid ${after - before}`);
    assert.ok(after - before <= parseEther("0.08"));

    const [deposited, spent] = await pool.read.depositorOf([alice!.account.address]);
    assert.equal(deposited, 0n, "the record is cleared, not left to be drained twice");
    assert.equal(spent, 0n);
  });

  it("refuses an exit that was never requested, and a second exit", async () => {
    const pool = await funded();
    await assert.rejects(pool.write.executeExit({ account: alice!.account }));
    await pool.write.requestExit({ account: alice!.account });
    await travel(DAY + 1);
    await pool.write.executeExit({ account: alice!.account });
    await assert.rejects(pool.write.executeExit({ account: alice!.account }), "no double exit");
  });

  it("charges spend posted after the request, so exiting is not a way to escape a bill", async () => {
    const pool = await funded();
    const publicClient = await viem.getPublicClient();
    await pool.write.requestExit({ account: alice!.account });
    // The trader keeps trading after asking to leave; that spend still counts.
    await pool.write.queueSpendBatch([[`0x${"e2".repeat(32)}`], [parseEther("0.03")], [0n]]);
    const [id] = await pool.read.queuedSpendAt([0n]);
    await pool.write.postQueued([id, alice!.account.address]);

    await travel(DAY + 1);
    const before = await publicClient.getBalance({ address: alice!.account.address });
    await pool.write.executeExit({ account: alice!.account });
    const after = await publicClient.getBalance({ address: alice!.account.address });
    assert.ok(after - before < parseEther("0.071"), "the later spend reduced the payout");
    assert.ok(after - before > parseEther("0.069"));
  });

  it("stops a queued spend from being posted once its window has passed", async () => {
    const pool = await funded();
    // Chain time, not wall time: earlier cases in this file have already
    // travelled forward, so the wall clock is behind the EVM.
    const block = await (await viem.getPublicClient()).getBlock();
    await pool.write.queueSpendBatch([[`0x${"e3".repeat(32)}`], [parseEther("0.02")], [block.timestamp + 60n]]);
    const [id] = await pool.read.queuedSpendAt([0n]);
    await assert.rejects(pool.write.postQueued([id, alice!.account.address]), "not due yet");

    // The window is what lets the exit be safe without the operator: an unposted
    // spend cannot ambush a trader who already waited out the exit delay.
    await travel(DAY + 1);
    await assert.rejects(pool.write.postQueued([id, alice!.account.address]), "too late to post");
    const [, spent] = await pool.read.depositorOf([alice!.account.address]);
    assert.equal(spent, 0n, "the operator ate the loss, not the trader");
  });

  it("posts a queued spend inside its window and only once", async () => {
    const pool = await funded();
    const block = await (await viem.getPublicClient()).getBlock();
    await pool.write.queueSpendBatch([[`0x${"e4".repeat(32)}`], [parseEther("0.01")], [block.timestamp + 60n]]);
    const [id] = await pool.read.queuedSpendAt([0n]);
    await travel(120);
    await pool.write.postQueued([id, alice!.account.address]);
    assert.equal((await pool.read.depositorOf([alice!.account.address]))[1], parseEther("0.01"));
    await assert.rejects(pool.write.postQueued([id, alice!.account.address]), "no double posting");
  });
});

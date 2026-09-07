import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address } from "viem";

/**
 * FleetPool deposits, sizes, caps, and pause (FR-001, FR-003, FR-004, FR-012).
 *
 * The pool is the custody boundary: every limit the app shows must also hold
 * here, because the app is not what protects the money.
 */
describe("FleetPool deposits, caps, and pause", () => {
  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];
  let operator: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getWalletClients"]>>[number];
  let alice: typeof operator;
  let bob: typeof operator;

  before(async () => {
    ({ viem } = await network.connect({ network: "default" }));
    [operator, alice, bob] = await viem.getWalletClients();
  });

  const deploy = () => viem.deployContract("FleetPool", [operator!.account.address]);

  it("accepts only the published deposit sizes", async () => {
    const pool = await deploy();
    await pool.write.deposit({ account: alice!.account, value: parseEther("0.05") });
    assert.equal((await pool.read.depositorOf([alice!.account.address]))[0], parseEther("0.05"));

    for (const odd of ["0.0437", "0.011", "0.5"]) {
      await assert.rejects(
        pool.write.deposit({ account: alice!.account, value: parseEther(odd) }),
        `an odd size (${odd}) is correlatable and must be refused`,
      );
    }
    await assert.rejects(pool.write.deposit({ account: alice!.account, value: 0n }));
  });

  it("holds the per-depositor cap and leaves other depositors unaffected", async () => {
    const pool = await deploy();
    for (let i = 0; i < 5; i += 1) {
      await pool.write.deposit({ account: alice!.account, value: parseEther("0.1") });
    }
    assert.equal((await pool.read.depositorOf([alice!.account.address]))[0], parseEther("0.5"));
    await assert.rejects(pool.write.deposit({ account: alice!.account, value: parseEther("0.01") }), "at the cap");

    await pool.write.deposit({ account: bob!.account, value: parseEther("0.1") });
    assert.equal((await pool.read.depositorOf([bob!.account.address]))[0], parseEther("0.1"));
  });

  it("holds the whole-pool cap across depositors", async () => {
    const pool = await deploy();
    const wallets = await viem.getWalletClients();
    // Ten wallets at 0.5 ETH each is 5 ETH, exactly the pool cap.
    for (const w of wallets.slice(0, 10)) {
      for (let i = 0; i < 5; i += 1) {
        await pool.write.deposit({ account: w.account, value: parseEther("0.1") });
      }
    }
    assert.equal(await pool.read.totalDeposited(), parseEther("5"));
    await assert.rejects(
      pool.write.deposit({ account: wallets[10]!.account, value: parseEther("0.01") }),
      "pool cap is absolute",
    );
  });

  it("reports headroom that matches what it will accept", async () => {
    const pool = await deploy();
    await pool.write.deposit({ account: alice!.account, value: parseEther("0.1") });
    const [perDepositor, perPool] = await pool.read.headroom([alice!.account.address]);
    assert.equal(perDepositor, parseEther("0.4"));
    assert.equal(perPool, parseEther("4.9"));
  });

  it("refuses deposits while paused, and only the operator may pause", async () => {
    const pool = await deploy();
    await assert.rejects(pool.write.setPaused([true], { account: alice!.account }), "traders cannot pause");
    await pool.write.setPaused([true]);
    await assert.rejects(pool.write.deposit({ account: alice!.account, value: parseEther("0.01") }));
    await pool.write.setPaused([false]);
    await pool.write.deposit({ account: alice!.account, value: parseEther("0.01") });
    assert.equal((await pool.read.depositorOf([alice!.account.address]))[0], parseEther("0.01"));
  });

  it("never lets a non-operator move money", async () => {
    const pool = await deploy();
    await pool.write.deposit({ account: alice!.account, value: parseEther("0.1") });
    const campaign = `0x${"a1".repeat(32)}` as const;
    await assert.rejects(
      pool.write.openDraw([campaign, parseEther("0.02"), 0n, "0xdead"], { account: alice!.account }),
    );
    await assert.rejects(pool.write.claimOperator([parseEther("0.01")], { account: alice!.account }));
    await assert.rejects(
      pool.write.queueSpend(["0xdead", parseEther("0.01"), 0n], { account: alice!.account }),
    );
  });

  it("keeps the pool's ETH equal to what it owes", async () => {
    const pool = await deploy();
    const publicClient = await viem.getPublicClient();
    await pool.write.deposit({ account: alice!.account, value: parseEther("0.05") });
    await pool.write.deposit({ account: bob!.account, value: parseEther("0.01") });
    const held = await publicClient.getBalance({ address: pool.address as Address });
    assert.equal(held, parseEther("0.06"));
    assert.equal(await pool.read.totalDeposited(), parseEther("0.06"));
  });
});

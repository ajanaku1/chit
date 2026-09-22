import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address } from "viem";
import { TESTNET_CAPS } from "../../src/fleet/pool-caps.js";

/**
 * Draws: a campaign's claim on a balance, funded late and spent just in time
 * (FR-005 to FR-008, FR-013). The point of the design is that unspent draw
 * never leaves the pool, so closing returns everything and there is less to
 * correlate.
 */
describe("FleetPool draws", () => {
  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];
  let operator: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getWalletClients"]>>[number];
  let alice: typeof operator;

  const CAMPAIGN = `0x${"c1".repeat(32)}` as const;
  const OWNER_REF = `0x${"55".repeat(48)}` as const;
  const HEADROOM = parseEther("0.0002");

  before(async () => {
    ({ viem } = await network.connect({ network: "default" }));
    [operator, alice] = await viem.getWalletClients();
  });

  const seeded = async () => {
    const pool = await viem.deployContract("FleetPool", [operator!.account.address, operator!.account.address, TESTNET_CAPS.depositor, TESTNET_CAPS.draw, TESTNET_CAPS.pool]);
    await pool.write.deposit({ account: alice!.account, value: parseEther("0.1") });
    return pool;
  };

  const travel = async (seconds: number) => {
    const test = await viem.getTestClient();
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  };

  const accounts = (): Address[] => [
    "0x0000000000000000000000000000000000000a01",
    "0x0000000000000000000000000000000000000a02",
    "0x0000000000000000000000000000000000000a03",
    "0x0000000000000000000000000000000000000a04",
    "0x0000000000000000000000000000000000000a05",
  ];

  it("opens a draw within the cap, carrying an owner reference the chain cannot read", async () => {
    const pool = await seeded();
    const block = await (await viem.getPublicClient()).getBlock();
    await pool.write.openDraw([CAMPAIGN, parseEther("0.02"), block.timestamp + 300n, OWNER_REF]);
    const draw = await pool.read.drawOf([CAMPAIGN]);
    assert.equal(draw.amount, parseEther("0.02"));
    assert.equal(draw.spent, 0n);
    assert.equal(draw.state, 1, "Pending");
    assert.equal(draw.ownerRef, OWNER_REF, "the reference is stored for later audit, not read on chain");

    await assert.rejects(
      pool.write.openDraw([`0x${"c2".repeat(32)}`, parseEther("0.3"), block.timestamp + 300n, OWNER_REF]),
      "over the per-draw cap",
    );
    await assert.rejects(
      pool.write.openDraw([CAMPAIGN, parseEther("0.01"), block.timestamp + 300n, OWNER_REF]),
      "a campaign gets one draw",
    );
  });

  it("refuses a draw whose delay is too short to be a delay", async () => {
    const pool = await seeded();
    const block = await (await viem.getPublicClient()).getBlock();
    // The wait is the privacy. If the service could open a draw due now, a
    // deposit and its fleet funding would land together and pair by timing, so
    // the floor is enforced here rather than trusted to the caller.
    await assert.rejects(pool.write.openDraw([CAMPAIGN, parseEther("0.02"), block.timestamp, OWNER_REF]));
    await assert.rejects(pool.write.openDraw([CAMPAIGN, parseEther("0.02"), 0n, OWNER_REF]));
    await assert.rejects(pool.write.openDraw([CAMPAIGN, parseEther("0.02"), block.timestamp + 30n, OWNER_REF]));
    await pool.write.openDraw([CAMPAIGN, parseEther("0.02"), block.timestamp + 300n, OWNER_REF]);
    assert.equal((await pool.read.drawOf([CAMPAIGN])).state, 1);
  });

  it("refuses to fund the fleet before the delay has run", async () => {
    const pool = await seeded();
    const block = await (await viem.getPublicClient()).getBlock();
    await pool.write.openDraw([CAMPAIGN, parseEther("0.02"), block.timestamp + 600n, OWNER_REF]);
    await assert.rejects(pool.write.fund([CAMPAIGN, accounts()]), "the delay is the privacy");
  });

  it("seeds gas headroom to every account once the delay has run", async () => {
    const pool = await seeded();
    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();
    await pool.write.openDraw([CAMPAIGN, parseEther("0.02"), block.timestamp + 300n, OWNER_REF]);
    await travel(400);
    const before = await Promise.all(accounts().map((a) => publicClient.getBalance({ address: a })));
    await pool.write.fund([CAMPAIGN, accounts()]);

    const after = await Promise.all(accounts().map((a) => publicClient.getBalance({ address: a })));
    for (const [i, account] of accounts().entries()) {
      assert.equal(after[i]! - before[i]!, HEADROOM, `${account} seeded`);
    }
    const draw = await pool.read.drawOf([CAMPAIGN]);
    assert.equal(draw.state, 2, "Funded");
    assert.equal(draw.spent, HEADROOM * 5n, "the seeding is charged to the draw");
    await assert.rejects(pool.write.fund([CAMPAIGN, accounts()]), "funded once");
  });

  const fundedDraw = async () => {
    const pool = await seeded();
    const block = await (await viem.getPublicClient()).getBlock();
    await pool.write.openDraw([CAMPAIGN, parseEther("0.02"), block.timestamp + 300n, OWNER_REF]);
    await travel(400);
    await pool.write.fund([CAMPAIGN, accounts()]);
    return pool;
  };

  it("sends principal just in time and commits principal plus gas", async () => {
    const pool = await fundedDraw();
    const publicClient = await viem.getPublicClient();
    const account = accounts()[0]!;
    const principal = parseEther("0.0005");

    const held = await publicClient.getBalance({ address: account });
    await pool.write.fundPrincipal([CAMPAIGN, account, principal, parseEther("0.0002")]);
    assert.equal(
      (await publicClient.getBalance({ address: account })) - held,
      principal,
      "the account receives exactly this buy's principal, and only for the buy",
    );

    const gas = parseEther("0.00001");
    await pool.write.commit([CAMPAIGN, principal + gas]);
    const draw = await pool.read.drawOf([CAMPAIGN]);
    assert.equal(draw.spent, HEADROOM * 5n + principal + gas);
    assert.equal(draw.reserved, 0n, "nothing left reserved");
  });

  it("returns the principal and charges nothing when a buy fails", async () => {
    const pool = await fundedDraw();
    const account = accounts()[1]!;
    const principal = parseEther("0.0005");
    const spentBefore = (await pool.read.drawOf([CAMPAIGN])).spent;

    await pool.write.fundPrincipal([CAMPAIGN, account, principal, parseEther("0.0002")]);
    await pool.write.rollback([CAMPAIGN, principal], { value: principal });

    const draw = await pool.read.drawOf([CAMPAIGN]);
    assert.equal(draw.spent, spentBefore, "a failed buy costs the trader nothing");
    assert.equal(draw.reserved, 0n);
  });

  it("never lets a draw spend past its amount", async () => {
    const pool = await fundedDraw();
    await assert.rejects(
      pool.write.fundPrincipal([CAMPAIGN, accounts()[0]!, parseEther("0.02"), parseEther("0.0002")]),
      "the draw is the ceiling",
    );
    await assert.rejects(pool.write.commit([CAMPAIGN, parseEther("0.001")]), "nothing reserved to commit");
  });

  it("raises a draw that ran out, without a new deposit and still inside the cap", async () => {
    const pool = await fundedDraw();
    await pool.write.topUpDraw([CAMPAIGN, parseEther("0.01")]);
    assert.equal((await pool.read.drawOf([CAMPAIGN])).amount, parseEther("0.03"));

    await assert.rejects(pool.write.topUpDraw([CAMPAIGN, parseEther("0.2")]), "the per-draw cap still holds");
    await pool.write.closeDraw([CAMPAIGN]);
    await assert.rejects(pool.write.topUpDraw([CAMPAIGN, parseEther("0.01")]), "a closed draw takes nothing more");
  });

  it("closes a draw and leaves the unspent part in the pool", async () => {
    const pool = await fundedDraw();
    const publicClient = await viem.getPublicClient();
    const heldBefore = await publicClient.getBalance({ address: pool.address as Address });
    await pool.write.closeDraw([CAMPAIGN]);

    const draw = await pool.read.drawOf([CAMPAIGN]);
    assert.equal(draw.state, 3, "Closed");
    assert.equal(
      await publicClient.getBalance({ address: pool.address as Address }),
      heldBefore,
      "closing publishes no transfer at all",
    );
    await assert.rejects(pool.write.fundPrincipal([CAMPAIGN, accounts()[0]!, 1n, 1n]), "a closed draw spends nothing");
  });

  it("lets the operator reclaim only the gas it actually fronted, and only once a depositor has been charged for it", async () => {
    const pool = await fundedDraw();
    const publicClient = await viem.getPublicClient();
    const principal = parseEther("0.0005");
    const gas = parseEther("0.00001");
    await pool.write.fundPrincipal([CAMPAIGN, accounts()[0]!, principal, parseEther("0.0002")]);
    await pool.write.commit([CAMPAIGN, principal + gas]);

    // T031 made the claim the pool's surplus, and until a charge is posted
    // there is none: the headroom and the principal have left, and nobody is
    // yet known to owe for them. So the operator may take nothing at all
    // here — it cannot reimburse itself for money no depositor has been
    // charged. Before T031 this read `gas`, which let a claim run ahead of
    // the posting that backs it.
    const out = HEADROOM * BigInt(accounts().length) + principal;
    assert.equal(await pool.read.totalOutflow(), out);
    assert.equal(await pool.read.claimable(), 0n, "nothing posted: nothing to claim");
    await assert.rejects(pool.write.claimOperator([1n]), "not one wei ahead of the posting");

    // The charge the service posts for this campaign: what the depositor's
    // own instruction consumed — the gas seeded to the fleet, the principal,
    // and the gas the operator fronted to execute the buy.
    await pool.write.queueSpendBatch([[`0x${"e9".repeat(32)}`], [out + gas], [0n]]);
    const [id] = await pool.read.queuedSpendAt([0n]);
    await pool.write.postQueued([id, alice!.account.address]);
    assert.equal(await pool.read.totalPosted(), out + gas);

    // Now the surplus is exactly the gas the operator fronted, and no more.
    assert.equal(await pool.read.claimable(), gas);
    await assert.rejects(pool.write.claimOperator([gas + 1n]), "the operator cannot help itself to the pool");
    await pool.write.claimOperator([gas]);
    assert.equal(await pool.read.claimable(), 0n);
    assert.equal(await publicClient.getBalance({ address: pool.address }), parseEther("0.1") - out - gas, "the pool holds the deposit less what left it");
  });
});

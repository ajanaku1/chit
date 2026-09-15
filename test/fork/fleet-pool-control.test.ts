import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address } from "viem";

import { createFleetPool } from "../../src/fleet/chain-pool.js";
import { ledgerKey, sealDepositor } from "../../src/fleet/pool-ledger.js";
import { createPoolService } from "../../src/fleet/pool-buy.js";
import { TESTNET_CAPS } from "../../src/fleet/pool-caps.js";

/**
 * Getting money back, and stopping the pool. Closing must return a campaign's
 * unspent draw to the trader's balance without publishing a transfer, and the
 * operator's pause must actually stop money moving, not just grey out a button.
 */
describe("Pool control and recovery", () => {
  const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;
  const CAMPAIGN = `0x${"d1".repeat(32)}` as const;

  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];

  before(async () => {
    ({ viem } = await network.connect({ network: "default" }));
  });

  const travel = async (seconds: number) => {
    const test = await viem.getTestClient();
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  };

  const setup = async () => {
    const [operator, trader] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const contract = await viem.deployContract("FleetPool", [operator!.account.address, operator!.account.address, TESTNET_CAPS.depositor, TESTNET_CAPS.draw, TESTNET_CAPS.pool]);
    const key = ledgerKey(OPERATOR_KEY);
    const service = createPoolService(
      operator!,
      publicClient,
      createFleetPool(operator!, publicClient, contract.address as Address),
      key,
      { delaySeconds: () => 120 },
    );
    await contract.write.deposit({ account: trader!.account, value: parseEther("0.1") });
    return { operator, trader, publicClient, contract, service, key };
  };

  const accounts = (): Address[] => [
    "0x0000000000000000000000000000000000000b01",
    "0x0000000000000000000000000000000000000b02",
    "0x0000000000000000000000000000000000000b03",
    "0x0000000000000000000000000000000000000b04",
    "0x0000000000000000000000000000000000000b05",
  ];

  it("returns an unspent draw to the balance with no transfer to anyone", async () => {
    const s = await setup();
    const depositor = s.trader!.account.address;

    const before = await s.service.balance(depositor);
    assert.equal(before.available, parseEther("0.1").toString());

    await s.service.openDraw({ campaign: CAMPAIGN, depositor, amount: parseEther("0.02").toString() });
    const committed = await s.service.balance(depositor);
    assert.equal(committed.available, parseEther("0.08").toString(), "the draw is held back, not spent");
    assert.equal(committed.openDraws, parseEther("0.02").toString());

    const traderEthBefore = await s.publicClient.getBalance({ address: depositor });
    const poolEthBefore = await s.publicClient.getBalance({ address: s.contract.address as Address });

    const closed = await s.service.closeDraw(CAMPAIGN);
    assert.equal(closed?.state, "Closed");

    const after = await s.service.balance(depositor);
    assert.equal(after.available, parseEther("0.1").toString(), "every unspent wei is spendable again");
    assert.equal(after.openDraws, "0");
    assert.equal(
      await s.publicClient.getBalance({ address: depositor }),
      traderEthBefore,
      "closing publishes no payment to the trader",
    );
    assert.equal(await s.publicClient.getBalance({ address: s.contract.address as Address }), poolEthBefore);
  });

  it("returns only what a campaign did not spend", async () => {
    const s = await setup();
    const depositor = s.trader!.account.address;
    await s.service.openDraw({ campaign: CAMPAIGN, depositor, amount: parseEther("0.02").toString() });
    await travel(200);
    await s.contract.write.fund([CAMPAIGN, accounts()]);

    await s.service.closeDraw(CAMPAIGN);
    const after = await s.service.balance(depositor);
    // Only the gas headroom actually left the pool; it is charged once the
    // queued posting lands, not twice by closing.
    assert.equal(after.openDraws, "0");
    assert.equal(after.available, parseEther("0.1").toString());
  });

  it("lets a depleted campaign top up without another deposit", async () => {
    const s = await setup();
    const depositor = s.trader!.account.address;
    await s.service.openDraw({ campaign: CAMPAIGN, depositor, amount: parseEther("0.02").toString() });
    const raised = await s.service.topUpDraw({ campaign: CAMPAIGN, amount: parseEther("0.01").toString() });
    assert.equal(raised.amount, parseEther("0.03").toString());

    const after = await s.service.balance(depositor);
    assert.equal(after.available, parseEther("0.07").toString(), "the top-up is held against the balance");
  });

  it("a paused pool takes no deposit, opens no draw, and moves no principal", async () => {
    const s = await setup();
    const depositor = s.trader!.account.address;
    await s.service.openDraw({ campaign: CAMPAIGN, depositor, amount: parseEther("0.02").toString() });
    await travel(200);
    await s.contract.write.fund([CAMPAIGN, accounts()]);

    await s.contract.write.setPaused([true]);
    assert.equal((await s.service.balance(depositor)).pool.paused, true, "the app is told, not left guessing");

    await assert.rejects(s.contract.write.deposit({ account: s.trader!.account, value: parseEther("0.01") }));
    await assert.rejects(
      s.contract.write.openDraw([`0x${"d2".repeat(32)}`, parseEther("0.01"), 0n, sealDepositor(s.key, depositor)]),
    );
    await assert.rejects(
      s.contract.write.fundPrincipal([CAMPAIGN, accounts()[0]!, parseEther("0.0005"), parseEther("0.0002")]),
      "a pause that still lets principal out is not a pause",
    );

    await s.contract.write.setPaused([false]);
    await s.contract.write.fundPrincipal([CAMPAIGN, accounts()[0]!, parseEther("0.0005"), parseEther("0.0002")]);
    assert.ok((await s.contract.read.drawOf([CAMPAIGN])).reserved > 0n);
  });

  it("still lets a trader leave while the pool is paused", async () => {
    const s = await setup();
    await s.contract.write.setPaused([true]);
    // The exit is the promise that survives everything, including the operator
    // deciding to stop.
    await s.contract.write.requestExit({ account: s.trader!.account });
    await travel(24 * 60 * 60 + 1);
    const before = await s.publicClient.getBalance({ address: s.trader!.account.address });
    await s.contract.write.executeExit({ account: s.trader!.account });
    assert.ok((await s.publicClient.getBalance({ address: s.trader!.account.address })) > before);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address, type Hex } from "viem";

import { runFleetBuy, verifyCampaignFunding } from "../../src/fleet/chain-buy.js";

/**
 * The on-chain fleet buy service across multiple accounts: approved buys are
 * sponsored and settled, an unapproved one is isolated as rejected, and the
 * final on-chain budget reflects only the settled gas.
 */
describe("Fleet on-chain buy service", () => {
  const CAMPAIGN = `0x${"f1".repeat(32)}` as Hex;
  const INCREMENT = "0xd09de08a" as Hex;

  it("sponsors approved buys, rejects an unapproved one, and settles the budget", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [operator, owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address, operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const counter = await viem.deployContract("ChitCounter", []);
    const a1 = await viem.deployContract("FleetAccount", [owner!.account.address, operator!.account.address, policy.address, CAMPAIGN]);
    const a2 = await viem.deployContract("FleetAccount", [owner!.account.address, operator!.account.address, policy.address, CAMPAIGN]);

    const accounts = [a1.address, a2.address,
      "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333"].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1)) as Address[];

    await policy.write.openSession([
      CAMPAIGN,
      { chainId: BigInt(chainId), router: counter.address, selector: INCREMENT, maxTradeValue: parseEther("1"),
        perAccountGas: parseEther("0.01"), totalGas: parseEther("0.05"),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400), spentGas: 0n, paused: false, revoked: false, exists: false },
      accounts,
    ]);
    await escrow.write.registerCampaign([CAMPAIGN, owner!.account.address]);
    await escrow.write.fund([CAMPAIGN], { account: owner!.account, value: parseEther("0.1") });

    assert.equal(await verifyCampaignFunding(publicClient, escrow.address, CAMPAIGN, parseEther("0.02")), true);

    const report = await runFleetBuy(operator!, publicClient, {
      escrow: escrow.address,
      campaign: CAMPAIGN,
      accounts: [
        { account: a1.address, key: `0x${"01".repeat(32)}`, router: counter.address, value: 0n, callData: INCREMENT, maxCost: parseEther("0.01") },
        // Unapproved selector: policy.check reverts, this account is rejected.
        { account: a2.address, key: `0x${"02".repeat(32)}`, router: counter.address, value: 0n, callData: "0xdeadbeef", maxCost: parseEther("0.01") },
      ],
    });

    const sponsored = report.results.filter((r) => r.status === "sponsored");
    const rejected = report.results.filter((r) => r.status === "rejected");
    assert.equal(sponsored.length, 1, "one approved buy sponsored");
    assert.equal(rejected.length, 1, "one unapproved buy rejected");
    assert.equal(sponsored[0]!.account, a1.address);
    assert.equal(await counter.read.count(), 1n, "only the approved buy executed");

    // Budget debited by exactly the one sponsored buy's gas; nothing reserved.
    assert.equal(report.budget.spent, sponsored[0]!.gasCost);
    assert.equal(report.budget.reserved, 0n);
    assert.equal(report.budget.unused, parseEther("0.1") - report.budget.spent);
  });
});

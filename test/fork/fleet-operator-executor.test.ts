import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEther, type Address, type Hex } from "viem";

import { executeSponsoredBuy, readBudget } from "../../src/fleet/operator-executor.js";

/**
 * Stage 1 end-to-end on a live EVM: the operator executes a policy-approved call
 * through a fleet account and the escrow settles the gas it fronted. A counter
 * stands in for the approved router/buy; what's proven is the sponsorship
 * settlement (reserve -> execute -> commit) and the on-chain budget debit.
 */
describe("Fleet operator-executes sponsored buy", () => {
  const CAMPAIGN = `0x${"e1".repeat(32)}` as Hex;
  const KEY = `0x${"e2".repeat(32)}` as Hex;
  const INCREMENT = "0xd09de08a" as Hex; // increment()

  it("executes an approved call and debits the budget by the actual gas", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [operator, owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address, operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const counter = await viem.deployContract("FleetTestCounter", []);
    const account = await viem.deployContract("FleetAccount", [
      owner!.account.address,
      operator!.account.address,
      policy.address,
      CAMPAIGN,
    ]);

    // Enroll five accounts (strictly increasing) including the fleet account.
    const dummies = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"] as Address[];
    const accounts = [account.address, ...dummies].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)) as Address[];

    await policy.write.openSession([
      CAMPAIGN,
      {
        chainId: BigInt(chainId),
        router: counter.address,
        selector: INCREMENT,
        maxTradeValue: parseEther("1"),
        perAccountGas: parseEther("0.01"),
        totalGas: parseEther("0.05"),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
        spentGas: 0n,
        paused: false,
        revoked: false,
        exists: false,
      },
      accounts,
    ]);

    // Register and fund the campaign budget.
    await escrow.write.registerCampaign([CAMPAIGN, owner!.account.address]);
    await escrow.write.fund([CAMPAIGN], { account: owner!.account, value: parseEther("0.1") });

    const before = await readBudget(publicClient, escrow.address, CAMPAIGN);
    assert.equal(before.spent, 0n);

    const result = await executeSponsoredBuy(operator!, publicClient, {
      escrow: escrow.address,
      account: account.address,
      campaign: CAMPAIGN,
      key: KEY,
      router: counter.address,
      value: 0n,
      callData: INCREMENT,
      maxCost: parseEther("0.01"),
    });

    // The approved call ran.
    assert.equal(await counter.read.count(), 1n);
    // The budget was debited by exactly the settled gas, and nothing is reserved.
    const after = await readBudget(publicClient, escrow.address, CAMPAIGN);
    assert.equal(after.spent, result.actualGasCost);
    assert.ok(after.spent > 0n, "some gas was settled");
    assert.equal(after.reserved, 0n);
    assert.equal(after.unused, parseEther("0.1") - result.actualGasCost);
  });

  it("rolls the reservation back when the call is not policy-approved", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [operator, owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address, operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const counter = await viem.deployContract("FleetTestCounter", []);
    const account = await viem.deployContract("FleetAccount", [
      owner!.account.address, operator!.account.address, policy.address, CAMPAIGN,
    ]);
    const accounts = [account.address,
      "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444",
    ].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)) as Address[];
    await policy.write.openSession([
      CAMPAIGN,
      { chainId: BigInt(chainId), router: counter.address, selector: INCREMENT, maxTradeValue: parseEther("1"),
        perAccountGas: parseEther("0.01"), totalGas: parseEther("0.05"),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400), spentGas: 0n, paused: false, revoked: false, exists: false },
      accounts,
    ]);
    await escrow.write.registerCampaign([CAMPAIGN, owner!.account.address]);
    await escrow.write.fund([CAMPAIGN], { account: owner!.account, value: parseEther("0.1") });

    // Call an UNAPPROVED selector: policy.check reverts inside execute, so the buy fails.
    await assert.rejects(
      executeSponsoredBuy(operator!, publicClient, {
        escrow: escrow.address, account: account.address, campaign: CAMPAIGN, key: KEY,
        router: counter.address, value: 0n, callData: "0xdeadbeef" as Hex, maxCost: parseEther("0.01"),
      }),
    );
    // Nothing charged, reservation rolled back.
    const after = await readBudget(publicClient, escrow.address, CAMPAIGN);
    assert.equal(after.spent, 0n);
    assert.equal(after.reserved, 0n);
    assert.ok(getAddress(account.address).length === 42);
  });
});

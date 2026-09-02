import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createFleet, openSession, registerCampaign, type FleetInit } from "../../src/fleet/chain-campaign.js";
import { runFleetBuy, verifyCampaignFunding } from "../../src/fleet/chain-buy.js";

/**
 * The full Stage 1 lifecycle on a live EVM, using factory-created accounts:
 * register -> create fleet -> open session -> fund -> verify -> sponsored buy.
 * Proves the CREATE2 accounts from the factory work with the session and the
 * operator-executes settlement, end to end.
 */
describe("Fleet Stage 1 lifecycle (on-chain)", () => {
  const CAMPAIGN = `0x${"ab".repeat(32)}` as Hex;
  const INCREMENT = "0xd09de08a" as Hex;

  it("registers, creates the fleet, opens the session, funds, and settles a buy", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [operator, owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const factory = await viem.deployContract("FleetAccountFactory", [operator!.account.address]);
    const counter = await viem.deployContract("ChitCounter", []);

    // Five distinct browser-generated owners, strictly increasing by address.
    const inits: FleetInit[] = Array.from({ length: 5 }, (_, i) => ({
      ownerAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address,
      salt: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
    })).sort((a, b) => (a.ownerAddress < b.ownerAddress ? -1 : 1));

    await registerCampaign(operator!, publicClient, escrow.address, CAMPAIGN, owner!.account.address);
    const accounts = await createFleet(operator!, publicClient, factory.address, policy.address, CAMPAIGN, inits);
    assert.equal(accounts.length, 5);
    for (const a of accounts) {
      const code = await publicClient.getCode({ address: a });
      assert.ok(code && code !== "0x", `fleet account has code: ${a}`);
    }

    // openSession needs accounts strictly increasing by address.
    const enrolled = [...accounts].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    await openSession(operator!, publicClient, policy.address, CAMPAIGN, {
      chainId: BigInt(chainId),
      router: counter.address,
      selector: INCREMENT,
      maxTradeValue: parseEther("1"),
      perAccountGas: parseEther("0.01"),
      totalGas: parseEther("0.05"),
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    }, enrolled);

    await escrow.write.fund([CAMPAIGN], { account: owner!.account, value: parseEther("0.1") });
    assert.equal(await verifyCampaignFunding(publicClient, escrow.address, CAMPAIGN, parseEther("0.01")), true);

    const report = await runFleetBuy(operator!, publicClient, {
      escrow: escrow.address,
      campaign: CAMPAIGN,
      accounts: [
        { account: accounts[0]!, key: `0x${"c1".repeat(32)}`, router: counter.address, value: 0n, callData: INCREMENT, maxCost: parseEther("0.01") },
      ],
    });

    assert.equal(report.results[0]!.status, "sponsored");
    assert.equal(await counter.read.count(), 1n);
    assert.equal(report.budget.spent, report.results[0]!.gasCost);
    assert.equal(report.budget.unused, parseEther("0.1") - report.budget.spent);
  });
});

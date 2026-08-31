import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { isAddress } from "viem";

import { deployFleet, ROBINHOOD_TESTNET_ENTRYPOINT, ROBINHOOD_TESTNET_ROUTER } from "../../src/fleet/deploy.js";

/**
 * Proves the deploy routine against a live EVM without any credential: the same
 * `deployFleet` the live script calls runs here on the local network, and every
 * deployed address must carry code and land in a well-formed record.
 */
describe("Fleet deployment", () => {
  it("deploys all three contracts and returns a complete record", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const record = await deployFleet({
      wallet: deployer!,
      publicClient,
      operator: deployer!.account.address,
      network: "local",
    });

    for (const address of [record.sessionPolicy, record.accountFactory, record.campaignEscrow, record.paymaster]) {
      assert.ok(isAddress(address), `deployed address malformed: ${address}`);
      const code = await publicClient.getCode({ address });
      assert.ok(code && code !== "0x", `no code at ${address}`);
    }

    // The paymaster is authorized as the escrow's settler.
    const escrow = await viem.getContractAt("FleetCampaignEscrow", record.campaignEscrow);
    assert.equal(
      (await escrow.read.settler()).toLowerCase(),
      record.paymaster.toLowerCase(),
      "paymaster set as escrow settler",
    );

    assert.equal(record.operator, deployer!.account.address);
    assert.equal(record.entryPoint, ROBINHOOD_TESTNET_ENTRYPOINT);
    assert.equal(record.router, ROBINHOOD_TESTNET_ROUTER);
    for (const tx of [record.sessionPolicyTx, record.accountFactoryTx, record.campaignEscrowTx, record.paymasterTx, record.setSettlerTx]) {
      assert.match(tx, /^0x[0-9a-f]{64}$/);
    }
    assert.ok(!Number.isNaN(Date.parse(record.deployedAt)));
  });
});

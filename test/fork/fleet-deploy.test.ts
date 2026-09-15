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
    const [deployer, admin] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const record = await deployFleet({
      wallet: deployer!,
      publicClient,
      operator: deployer!.account.address,
      admin: admin!.account.address,
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

    // The policy's admin is handed to the cold key, which has not accepted yet:
    // the deployer still owns it (so the pool deploy can call setPool), and
    // the cold key's one transaction completes the handover.
    const policy = await viem.getContractAt("FleetSessionPolicy", record.sessionPolicy);
    assert.equal((await policy.read.owner()).toLowerCase(), deployer!.account.address.toLowerCase());
    assert.equal((await policy.read.pendingOwner()).toLowerCase(), admin!.account.address.toLowerCase());
    assert.equal((await policy.read.operator()).toLowerCase(), deployer!.account.address.toLowerCase(), "the hot key stays the deployer");
    await policy.write.acceptOwnership({ account: admin!.account });
    assert.equal((await policy.read.owner()).toLowerCase(), admin!.account.address.toLowerCase());

    assert.equal(record.operator, deployer!.account.address);
    assert.equal(record.admin, admin!.account.address);
    assert.match(record.adminHandoverTx, /^0x[0-9a-f]{64}$/);
    assert.equal(record.entryPoint, ROBINHOOD_TESTNET_ENTRYPOINT);
    assert.equal(record.router, ROBINHOOD_TESTNET_ROUTER);
    for (const tx of [record.sessionPolicyTx, record.accountFactoryTx, record.campaignEscrowTx, record.paymasterTx, record.setSettlerTx]) {
      assert.match(tx, /^0x[0-9a-f]{64}$/);
    }
    assert.ok(!Number.isNaN(Date.parse(record.deployedAt)));
  });

  it("refuses an admin that is the deployer or missing: the cold key must be a different key", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    await assert.rejects(
      deployFleet({ wallet: deployer!, publicClient, operator: deployer!.account.address, admin: deployer!.account.address, network: "local" }),
      /admin must not be the operator/,
    );
    await assert.rejects(
      deployFleet({ wallet: deployer!, publicClient, operator: deployer!.account.address, admin: "0xnope" as never, network: "local" }),
      /admin is not an address/,
    );
  });
});

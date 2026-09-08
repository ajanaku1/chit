import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CampaignRouter } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { createFleetPool } from "../../src/fleet/chain-pool.js";
import { campaignKey, createFleetChain } from "../../src/fleet/chain-service.js";
import { ledgerKey } from "../../src/fleet/pool-ledger.js";
import { createPoolService } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * The claim, checked the way an observer would check it (FR-009, SC-002).
 *
 * A full journey runs, then every log and every transaction it produced is
 * read back from the chain. Nothing an observer can see may put the depositing
 * wallet and a fleet account, or the depositing wallet and the campaign, in the
 * same place. This is the test that fails if the privacy is ever quietly lost.
 */
describe("What an observer can see", () => {
  const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
  const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;

  let viem: Awaited<ReturnType<typeof network.connect>>["viem"];

  before(async () => {
    ({ viem } = await network.connect({ network: "default" }));
  });

  const travel = async (seconds: number) => {
    const test = await viem.getTestClient();
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  };

  /** Every 20-byte and 32-byte word an observer could read out of a hex blob. */
  const words = (data: string): string[] => {
    const raw = data.slice(2).toLowerCase();
    const found: string[] = [];
    for (let i = 0; i + 64 <= raw.length; i += 2) {
      const chunk = raw.slice(i, i + 64);
      found.push(`0x${chunk}`, `0x${chunk.slice(24)}`);
    }
    return found;
  };

  it("never puts the depositor and the fleet in one log or one transaction", async () => {
    const [operator, trader] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address]);
    const factory = await viem.deployContract("FleetAccountFactory", [operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const poolContract = await viem.deployContract("FleetPool", [operator!.account.address]);
    const sink = await viem.deployContract("FleetTestSink", []);

    const pool = createPoolService(
      operator!, publicClient,
      createFleetPool(operator!, publicClient, poolContract.address as Address),
      ledgerKey(OPERATOR_KEY),
      { delaySeconds: () => 120 },
    );
    const chain = createFleetChain(operator!, publicClient, {
      escrow: escrow.address as Address,
      factory: factory.address as Address,
      policy: policy.address as Address,
    });
    const service = new CampaignService(serviceConfig, { nonceSecret: "s" });
    const router = new CampaignRouter({ service, pool, chain });

    let calls = 0;
    const call = async (action: string, body: Record<string, unknown>) => {
      const hash = payloadHash(body);
      const c = service.issueChallenge({ primaryWallet: trader!.account.address, action, payloadHash: hash });
      const fields = {
        primaryWallet: trader!.account.address, nonce: c.nonce, issuedAt: c.issuedAt,
        expiresAt: c.expiresAt, action, payloadHash: hash,
      };
      const signature = await trader!.signMessage({ account: trader!.account, message: challengeBytes(serviceConfig, fields) });
      return router.handle(
        { action, auth: { ...fields, signature } as AuthEnvelope, body },
        `fleet-${action}-${String(calls++).padStart(16, "0")}`,
      );
    };

    // The whole journey an observer would be watching.
    const from = await publicClient.getBlockNumber();
    await poolContract.write.deposit({ account: trader!.account, value: parseEther("0.1") });
    const created = await call("create", {
      quoteId: "q",
      policy: {
        chainId, accounts: 5, router: sink.address, function: "buy()",
        maxTradeValue: parseEther("0.05").toString(),
        perAccountGas: parseEther("0.002").toString(),
        totalGas: parseEther("0.01").toString(),
        expiry: new Date(Date.now() + 86_400_000).toISOString(),
      },
      accounts: Array.from({ length: 5 }, (_, i) => ({
        ownerAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address,
        salt: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
      })),
      recoveryVaultCommitment: generatePrivateKey(),
    });
    const campaign = (created.body as { campaign: string }).campaign;
    await call("confirmRecovery", { campaign });
    const activated = await call("activate", { campaign, draw: parseEther("0.02").toString() });
    const fleet = (activated.body as { accounts: Address[] }).accounts;
    await travel(200);
    await call("sweep", {});
    await call("buy", {
      campaign, accounts: [fleet[0], fleet[1]], token: sink.address, value: parseEther("0.0005").toString(),
    });
    await travel(200);
    await call("sweep", {});
    await call("close", { campaign });

    // Now read it all back the way anyone could.
    const depositor = trader!.account.address.toLowerCase();
    const key = campaignKey(campaign).toLowerCase();
    const fleetSet = new Set(fleet.map((account) => account.toLowerCase()));
    const to = await publicClient.getBlockNumber();

    const logs = await publicClient.getLogs({ fromBlock: from, toBlock: to });
    assert.ok(logs.length > 10, `the journey really happened: ${logs.length} logs`);

    for (const log of logs) {
      const seen = new Set([
        ...log.topics.flatMap((topic) => words(topic)),
        ...words(log.data),
        log.address.toLowerCase(),
      ]);
      const hasDepositor = seen.has(depositor);
      const hasFleet = [...fleetSet].some((account) => seen.has(account));
      const hasCampaign = seen.has(key);
      assert.ok(
        !(hasDepositor && (hasFleet || hasCampaign)),
        `a log joins the depositor to the fleet: ${log.address} ${log.topics[0]}`,
      );
    }

    for (let block = from; block <= to; block += 1n) {
      const { transactions } = await publicClient.getBlock({ blockNumber: block, includeTransactions: true });
      for (const tx of transactions) {
        if (typeof tx === "string") continue;
        if (tx.from.toLowerCase() !== depositor) continue;
        // Everything the trader signs themselves touches the pool alone.
        const seen = new Set([...words(tx.input), (tx.to ?? "").toLowerCase()]);
        assert.ok(!seen.has(key), "a trader transaction names a campaign");
        for (const account of fleetSet) {
          assert.ok(!seen.has(account), "a trader transaction names a fleet account");
        }
      }
    }

    // And the journey did happen: the fleet traded, the draw was charged, and
    // the trader's balance is what is left.
    assert.equal(await sink.read.totalBought(), parseEther("0.001"));
    const balance = await pool.balance(trader!.account.address);
    assert.equal(balance.openDraws, "0", "the closed draw stopped holding the balance");
    assert.ok(BigInt(balance.available) < parseEther("0.1"), "the buys were charged");
    assert.ok(BigInt(balance.available) > parseEther("0.09"), "and only the buys were charged");
  });
});

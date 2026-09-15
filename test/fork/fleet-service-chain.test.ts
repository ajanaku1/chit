import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CampaignRouter } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { campaignKey, createFleetChain } from "../../src/fleet/chain-service.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * Step 0 done-check: the service itself (router + on-chain adapter, open
 * access) drives create -> confirmRecovery -> fund -> activate -> buy against
 * the deployed contracts on a live EVM. The escrow is the budget; the response
 * budgets are what the chain reports, not a mirror.
 */
describe("Fleet service on-chain lifecycle (router-driven)", () => {
  const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
  const commitment = `0x${"3".repeat(64)}` as Hex;

  it("creates, funds, activates, and sponsors a buy through the router on-chain", async () => {
    const { viem } = await network.connect({ network: "default" });
    const [operator, owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address, operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const factory = await viem.deployContract("FleetAccountFactory", [operator!.account.address]);
    const counter = await viem.deployContract("ChitCounter", []);

    const chain = createFleetChain(operator!, publicClient, {
      escrow: escrow.address, factory: factory.address, policy: policy.address,
    });
    // Each router is a separate serverless instance: its own service memory,
    // the same derived nonce secret, the same chain.
    const instance = () => {
      const service = new CampaignService(serviceConfig, { nonceSecret: "derived-from-operator-key" });
      return { service, router: new CampaignRouter({ service, chain }) };
    };
    const first = instance();
    const service = first.service;
    const router = first.router;

    let calls = 0;
    const signed = async (issuer: CampaignService, action: string, body: Record<string, unknown>) => {
      const hash = payloadHash(body);
      const c = issuer.issueChallenge({ primaryWallet: owner!.account.address, action, payloadHash: hash });
      const fields = { primaryWallet: owner!.account.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
      const signature = await owner!.signMessage({ account: owner!.account, message: challengeBytes(serviceConfig, fields) });
      const auth: AuthEnvelope = { ...fields, signature };
      return { action, auth, body };
    };
    const call = async (action: string, body: Record<string, unknown>) =>
      router.handle(await signed(service, action, body), `fleet-${action}-${String(calls++).padStart(16, "0")}`);
    // A request that lands on a different instance: challenge issued by the
    // campaign function, verified and served by a fresh one.
    const elsewhere = async (action: string, body: Record<string, unknown>) =>
      instance().router.handle(await signed(service, action, body), `fleet-${action}-${String(calls++).padStart(16, "0")}`);

    // Open access: the quote is eligible with zero fee, no CHIT read.
    const quote = await router.handle({ action: "quote", body: { primaryWallet: owner!.account.address } });
    assert.equal((quote.body as { eligible: boolean; netFee: string }).eligible, true);
    assert.equal((quote.body as { netFee: string }).netFee, "0");

    const accounts = Array.from({ length: 5 }, (_, i) => ({
      ownerAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address,
      salt: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
    }));
    const created = await call("create", {
      quoteId: "q-1",
      policy: {
        chainId, accounts: 5, router: counter.address, function: "increment()",
        maxTradeValue: parseEther("1").toString(), perAccountGas: parseEther("0.01").toString(),
        totalGas: parseEther("0.05").toString(), expiry: new Date(Date.now() + 86_400_000).toISOString(),
      },
      accounts,
      recoveryVaultCommitment: commitment,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const campaign = (created.body as { campaign: string }).campaign;
    const key = campaignKey(campaign);
    assert.equal((await escrow.read.ownerOf([key])).toLowerCase(), owner!.account.address.toLowerCase());

    await call("confirmRecovery", { campaign });

    // Funding before the escrow holds anything is refused, not assumed.
    const unfunded = await call("fund", { campaign, fundingReference: "none" });
    assert.equal(unfunded.status, 422);

    await escrow.write.fund([key], { account: owner!.account, value: parseEther("0.1") });
    const funded = await call("fund", { campaign, fundingReference: "escrow" });
    assert.equal(funded.status, 200, JSON.stringify(funded.body));
    assert.equal((funded.body as { budget: { funded: string } }).budget.funded, parseEther("0.1").toString());

    const activated = await call("activate", { campaign });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const fleet = (activated.body as { accounts: Address[] }).accounts;
    assert.equal(fleet.length, 5);
    for (const a of fleet) {
      const code = await publicClient.getCode({ address: a });
      assert.ok(code && code !== "0x", `fleet account has code: ${a}`);
      assert.equal(await policy.read.isEnrolled([key, a]), true);
    }

    // The buy route is its own function: a fresh instance restores the campaign
    // from the chain and still sponsors exactly the enrolled accounts.
    const bought = await elsewhere("buy", {
      campaign, accounts: [fleet[0], fleet[1], "0x00000000000000000000000000000000000000ee"],
      token: "0x0000000000000000000000000000000000000001", value: "0",
    });
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    const results = (bought.body as { results: { account: string; status: string; txHash?: string; budget: { spent: string } }[] }).results;
    assert.equal(results.filter((r) => r.status === "sponsored").length, 2, "both enrolled accounts sponsored");
    assert.equal(results.find((r) => r.account.endsWith("ee"))?.status, "rejected", "unknown account refused off-chain");
    assert.equal(await counter.read.count(), 2n);

    const onChain = await escrow.read.budget([key]);
    assert.equal(results.find((r) => r.status === "sponsored")!.budget.spent, onChain[2].toString());
    assert.ok(onChain[2] > 0n && onChain[1] === 0n, "gas settled, nothing left reserved");

    // Control from yet another instance lands on the policy itself.
    const paused = await elsewhere("pause", { campaign });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal((await policy.read.sessionOf([key])).paused, true, "session paused on-chain");
    const refused = await elsewhere("buy", { campaign, accounts: [fleet[2]], token: "0x0000000000000000000000000000000000000001", value: "0" });
    assert.equal(refused.status, 403, "a paused campaign sponsors nothing, from any instance");
    assert.equal(await counter.read.count(), 2n);
    const resumed = await elsewhere("resume", { campaign });
    assert.equal((resumed.body as { state: string }).state, "Active");
    assert.equal((await policy.read.sessionOf([key])).paused, false);
    const closed = await elsewhere("close", { campaign });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal((await policy.read.sessionOf([key])).revoked, true, "close revokes the session on-chain");
    assert.equal((closed.body as { returnedEth: string }).returnedEth, "0", "the owner reclaims through the escrow, not the service");
  });
});

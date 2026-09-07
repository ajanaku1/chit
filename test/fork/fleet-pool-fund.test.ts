import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CampaignRouter } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { createFleetPool } from "../../src/fleet/chain-pool.js";
import { campaignKey, createFleetChain } from "../../src/fleet/chain-service.js";
import { ledgerKey } from "../../src/fleet/pool-ledger.js";
import { createPoolService } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * The whole Stage 2 claim, end to end on a live EVM: a balance funds a fleet
 * after a wait, a buy takes its principal from the pool only at the moment it
 * is spent, and the charge lands against the depositor later and separately.
 */
describe("Pooled funding and buys", () => {
  const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
  const NONCE_SECRET = "derived-from-operator-key";
  const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;
  const BUY = "buy()";
  const HEADROOM = parseEther("0.0002");
  const PRINCIPAL = parseEther("0.0005");

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
    const chainId = await publicClient.getChainId();

    const policy = await viem.deployContract("FleetSessionPolicy", [operator!.account.address]);
    const factory = await viem.deployContract("FleetAccountFactory", [operator!.account.address]);
    const escrow = await viem.deployContract("FleetCampaignEscrow", [operator!.account.address]);
    const poolContract = await viem.deployContract("FleetPool", [operator!.account.address]);
    const sink = await viem.deployContract("FleetTestSink", []);

    const key = ledgerKey(OPERATOR_KEY);
    const pool = createPoolService(
      operator!,
      publicClient,
      createFleetPool(operator!, publicClient, poolContract.address as Address),
      key,
      { delaySeconds: () => 120 },
    );
    const chain = createFleetChain(operator!, publicClient, {
      escrow: escrow.address as Address,
      factory: factory.address as Address,
      policy: policy.address as Address,
    });

    // Each router is its own serverless instance: separate memory, one chain.
    const instance = () => {
      const service = new CampaignService(serviceConfig, { nonceSecret: NONCE_SECRET });
      return { service, router: new CampaignRouter({ service, pool, chain }) };
    };
    const first = instance();
    const issuer = first.service;

    let calls = 0;
    const signed = async (action: string, body: Record<string, unknown>) => {
      const hash = payloadHash(body);
      const c = issuer.issueChallenge({ primaryWallet: trader!.account.address, action, payloadHash: hash });
      const fields = {
        primaryWallet: trader!.account.address, nonce: c.nonce, issuedAt: c.issuedAt,
        expiresAt: c.expiresAt, action, payloadHash: hash,
      };
      const signature = await trader!.signMessage({ account: trader!.account, message: challengeBytes(serviceConfig, fields) });
      return { action, auth: { ...fields, signature } as AuthEnvelope, body };
    };
    const elsewhere = async (action: string, body: Record<string, unknown>) =>
      instance().router.handle(await signed(action, body), `fleet-${action}-${String(calls++).padStart(16, "0")}`);
    const same = async (action: string, body: Record<string, unknown>) =>
      first.router.handle(await signed(action, body), `fleet-${action}-${String(calls++).padStart(16, "0")}`);

    await poolContract.write.deposit({ account: trader!.account, value: parseEther("0.1") });

    const created = await same("create", {
      quoteId: "q",
      policy: {
        chainId, accounts: 5, router: sink.address, function: BUY,
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
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const campaign = (created.body as { campaign: string }).campaign;
    await same("confirmRecovery", { campaign });

    return { operator, trader, publicClient, policy, poolContract, sink, campaign, elsewhere, same, key: campaignKey(campaign) };
  };

  it("waits, funds the fleet from any instance, then buys with principal moved just in time", async () => {
    const s = await setup();
    const poolAddress = s.poolContract.address as Address;

    const activated = await s.same("activate", { campaign: s.campaign, draw: parseEther("0.02").toString() });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const body = activated.body as { state: string; accounts: Address[]; draw: { state: string; dueAt: string } };
    assert.equal(body.state, "Activating", "the trader is waiting, and is told so");
    assert.equal(body.draw.state, "Pending");
    assert.equal(body.accounts.length, 5);
    for (const account of body.accounts) {
      assert.equal(await s.policy.read.isEnrolled([s.key, account]), true, "enrolled at activation");
      assert.equal(await s.publicClient.getBalance({ address: account }), 0n, "but not funded yet");
    }
    assert.equal(
      await s.publicClient.getBalance({ address: poolAddress }),
      parseEther("0.1"),
      "not a wei has left the pool during the wait",
    );

    // Sweeping early does nothing: the wait is the point.
    const early = await s.elsewhere("read", { campaign: s.campaign });
    assert.equal((early.body as { state: string }).state, "Activating");

    await travel(200);
    const swept = await s.elsewhere("sweep", {});
    assert.equal(swept.status, 200, JSON.stringify(swept.body));
    assert.deepEqual((swept.body as { funded: string[] }).funded, [s.key]);

    for (const account of body.accounts) {
      assert.equal(await s.publicClient.getBalance({ address: account }), HEADROOM, "seeded on the sweep");
    }
    const active = await s.elsewhere("read", { campaign: s.campaign });
    assert.equal((active.body as { state: string }).state, "Active");

    // The buy: principal reaches the account only inside the buy itself.
    const bought = await s.elsewhere("buy", {
      campaign: s.campaign,
      accounts: [body.accounts[0], body.accounts[1]],
      token: s.sink.address,
      value: PRINCIPAL.toString(),
    });
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    const results = (bought.body as { results: { account: string; status: string; txHash?: string }[] }).results;
    assert.equal(results.filter((r) => r.status === "sponsored").length, 2, JSON.stringify(results));
    assert.equal(await s.sink.read.totalBought(), PRINCIPAL * 2n, "both buys reached the venue");

    const draw = await s.poolContract.read.drawOf([s.key]);
    assert.ok(draw.spent > HEADROOM * 5n + PRINCIPAL * 2n, "principal and gas are both charged to the draw");
    assert.ok(draw.spent < parseEther("0.02"), "and stay inside the draw");
    assert.equal(draw.reserved, 0n, "nothing left in flight");

    // The charge against the depositor is queued, not posted beside the buy.
    assert.equal(await s.poolContract.read.queuedSpendCount(), 2n);
    assert.equal((await s.poolContract.read.queuedSpendAt([0n])).posted, false);
    assert.equal((await s.poolContract.read.depositorOf([s.trader!.account.address]))[1], 0n);

    await travel(200);
    const posted = await s.elsewhere("sweep", {});
    assert.deepEqual((posted.body as { posted: string[] }).posted, ["0", "1"]);
    const spent = (await s.poolContract.read.depositorOf([s.trader!.account.address]))[1];
    assert.equal(spent, draw.spent - HEADROOM * 5n, "the trader is charged what their buys cost");
  });

  it("charges nothing and returns the principal when a buy fails", async () => {
    const s = await setup();
    const activated = await s.same("activate", { campaign: s.campaign, draw: parseEther("0.02").toString() });
    const accounts = (activated.body as { accounts: Address[] }).accounts;
    await travel(200);
    await s.elsewhere("sweep", {});

    const held = await s.publicClient.getBalance({ address: s.poolContract.address as Address });
    const spentBefore = (await s.poolContract.read.drawOf([s.key])).spent;

    // The sink refuses a zero-value buy, so this one reverts on execution.
    const failed = await s.elsewhere("buy", {
      campaign: s.campaign, accounts: [accounts[0]], token: s.sink.address, value: "0",
    });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    const results = (failed.body as { results: { status: string }[] }).results;
    assert.equal(results[0]!.status, "rejected");

    assert.equal((await s.poolContract.read.drawOf([s.key])).spent, spentBefore, "a failed buy costs nothing");
    assert.equal(
      await s.publicClient.getBalance({ address: s.poolContract.address as Address }),
      held,
      "and the principal is back in the pool",
    );
    assert.equal((await s.poolContract.read.drawOf([s.key])).reserved, 0n);
  });

  it("refuses a buy the draw cannot cover, without moving principal", async () => {
    const s = await setup();
    // A draw big enough to stay Active, but too small for this buy's principal
    // plus its gas ceiling.
    const activated = await s.same("activate", { campaign: s.campaign, draw: parseEther("0.004").toString() });
    const accounts = (activated.body as { accounts: Address[] }).accounts;
    await travel(200);
    await s.elsewhere("sweep", {});

    const held = await s.publicClient.getBalance({ address: s.poolContract.address as Address });
    const result = await s.elsewhere("buy", {
      campaign: s.campaign, accounts: [accounts[0]], token: s.sink.address, value: parseEther("0.002").toString(),
    });
    const results = (result.body as { results: { status: string }[] }).results;
    assert.equal(results[0]!.status, "rejected", JSON.stringify(result.body));
    assert.equal(await s.publicClient.getBalance({ address: s.poolContract.address as Address }), held);
  });

  it("keeps the approved selector: an unapproved call is refused before any money moves", async () => {
    const s = await setup();
    assert.equal(toFunctionSelector(BUY).length, 10);
    const activated = await s.same("activate", { campaign: s.campaign, draw: parseEther("0.02").toString() });
    const accounts = (activated.body as { accounts: Address[] }).accounts;
    await travel(200);
    await s.elsewhere("sweep", {});

    const stranger = "0x00000000000000000000000000000000000000ee" as Address;
    const result = await s.elsewhere("buy", {
      campaign: s.campaign,
      accounts: [accounts[0], stranger],
      token: s.sink.address,
      value: PRINCIPAL.toString(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const results = (result.body as { results: { account: string; status: string }[] }).results;
    assert.equal(
      results.find((r) => r.account.toLowerCase() === stranger.toLowerCase())?.status,
      "rejected",
      "an account outside the fleet gets nothing",
    );
    assert.equal(
      results.find((r) => r.account.toLowerCase() === accounts[0]!.toLowerCase())?.status,
      "sponsored",
      "and refusing one account does not refuse the rest",
    );
    assert.equal(await s.sink.read.totalBought(), PRINCIPAL, "exactly one buy reached the venue");
  });
});

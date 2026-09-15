import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CampaignRouter } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { createFleetPool } from "../../src/fleet/chain-pool.js";
import { campaignKey, createFleetChain } from "../../src/fleet/chain-service.js";
import { createMarket, type MarketPort } from "../../src/fleet/market.js";
import { ledgerKey } from "../../src/fleet/pool-ledger.js";
import { createPoolService } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * A fleet buy as an order, end to end on a live EVM: the browser holds the
 * order, two separate service instances each execute only the slices that are
 * due and still pending, and every slice is sponsored exactly once. The venue
 * is the test sink (no v4 PoolManager on this network), so the pool-price part
 * of the quote is stubbed; the layout of that read is pinned by unit tests and
 * was checked live against the public RPC.
 */
describe("A seeded fleet order over two polls", () => {
  const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
  const NONCE_SECRET = "derived-from-operator-key";
  const OPERATOR_KEY = `0x${"7".repeat(64)}` as const;
  const BUY = "buy()";
  const SEED = `0x${"ab".repeat(32)}` as const;

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
    // The pool funds and executes a buy in one transaction; the policy names it.
    await policy.write.setPool([poolContract.address]);
    const sink = await viem.deployContract("FleetTestSink", []);

    const pool = createPoolService(
      operator!,
      publicClient,
      createFleetPool(operator!, publicClient, poolContract.address as Address),
      ledgerKey(OPERATOR_KEY),
      { delaySeconds: () => 120 },
    );
    const chain = createFleetChain(operator!, publicClient, {
      escrow: escrow.address as Address,
      factory: factory.address as Address,
      policy: policy.address as Address,
    });
    // Real holdings and fleet list against the local escrow; the price read is
    // stubbed because this network has no v4 PoolManager.
    const market: MarketPort = {
      ...createMarket(publicClient, { poolManager: sink.address as Address, escrow: escrow.address as Address, escrowFromBlock: 0n }),
      tokenQuote: async (token, amountInWei) => ({ token, symbol: "SINK", decimals: 18, hasPool: true, sqrtPriceX96: "1", estimatedOut: amountInWei }),
    };
    /** The chain's clock, so the service and the EVM agree on what is due. */
    const clock = async () => new Date(Number((await publicClient.getBlock()).timestamp) * 1000);

    // Each router is its own serverless instance: separate memory, one chain.
    const instance = () => {
      const service = new CampaignService(serviceConfig, { nonceSecret: NONCE_SECRET });
      return { service, router: new CampaignRouter({ service, pool, chain, market, now: () => nowValue }) };
    };
    let nowValue = await clock();
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
    const key = (action: string) => `fleet-${action}-${String(calls++).padStart(16, "0")}`;
    const elsewhere = async (action: string, body: Record<string, unknown>) => {
      nowValue = await clock();
      return instance().router.handle(await signed(action, body), key(action));
    };
    const same = async (action: string, body: Record<string, unknown>) => {
      nowValue = await clock();
      return first.router.handle(await signed(action, body), key(action));
    };

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

    return { trader, publicClient, sink, campaign, elsewhere, same, clock, key: campaignKey(campaign) };
  };

  it("executes a seeded order over two polls from two instances, every slice exactly once", async () => {
    const s = await setup();
    const activated = await s.same("activate", { campaign: s.campaign, draw: parseEther("0.02").toString() });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const accounts = (activated.body as { accounts: Address[] }).accounts;
    await travel(200);
    const swept = await s.elsewhere("sweep", {});
    assert.deepEqual((swept.body as { funded: string[] }).funded, [s.key], "the fleet is funded before it trades");

    const quote = await s.same("tokenQuote", { campaign: s.campaign, token: s.sink.address, totalWei: parseEther("0.005").toString() });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal((quote.body as { hasPool: boolean }).hasPool, true);

    const createdAt = (await s.clock()).toISOString();
    const placed = await s.same("order", {
      campaign: s.campaign, token: s.sink.address, totalWei: parseEther("0.005").toString(),
      wallets: accounts, entropy: SEED, createdAt,
    });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    const { order, slices } = placed.body as { order: Record<string, unknown>; slices: { index: number; amountWei: string; dueAt: string }[] };
    assert.equal(slices.length, 5);
    const total = slices.reduce((sum, x) => sum + BigInt(x.amountWei), 0n);
    assert.equal(total, parseEther("0.005"));
    const spentBefore = BigInt(((placed.body as { draw?: { spent: string } }).draw?.spent) ?? "0");

    // Past the third due time: the first instance runs what is due, no more.
    const dues = slices.map((x) => Date.parse(x.dueAt)).sort((a, b) => a - b);
    await travel(Math.ceil((dues[2]! - Date.parse(createdAt)) / 1000) + 2);
    const first = await s.same("trade", { campaign: s.campaign, order, pending: slices.map((x) => x.index) });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const done1 = (first.body as { executed: { index: number; status: string }[] }).executed;
    assert.ok(done1.length >= 3 && done1.length < 5, `expected the due slices only, got ${done1.length}`);
    for (const e of done1) assert.equal(e.status, "sponsored");

    // Past the window, from another instance, with the browser's pending list.
    await travel(31 * 60);
    const pending = slices.map((x) => x.index).filter((i) => !done1.some((e) => e.index === i));
    const second = await s.elsewhere("trade", { campaign: s.campaign, order, pending });
    const done2 = (second.body as { executed: { index: number; status: string }[]; nextDueAt: string | null }).executed;
    assert.equal(done1.length + done2.length, 5, "every slice ran once across the two polls");
    for (const e of done2) assert.equal(e.status, "sponsored");
    assert.equal((second.body as { nextDueAt: string | null }).nextDueAt, null);

    // Asking the same instance again for a slice it already ran does nothing.
    // Across instances the browser's pending list is the guard, which the
    // second poll above exercised: it sent only what the first had not run.
    const again = await s.same("trade", { campaign: s.campaign, order, pending: [done1[0]!.index] });
    assert.equal((again.body as { executed: unknown[] }).executed.length, 0);

    // The draw paid for exactly the five slices, and the sink received them.
    const read = await s.same("read", { campaign: s.campaign });
    const spent = BigInt((read.body as { draw: { spent: string } }).draw.spent);
    assert.ok(spent - spentBefore >= total, `draw spent ${spent - spentBefore}, slices total ${total}`);
    assert.equal(await s.publicClient.getBalance({ address: s.sink.address as Address }), total, "the venue received every slice");

    // A cold instance lists the fleet by its chain key, and a third cold
    // instance can act on that id: nothing depends on the friendly id surviving.
    const fleets = await s.elsewhere("list", {});
    assert.equal(fleets.status, 200, JSON.stringify(fleets.body));
    const listed = (fleets.body as { fleets: { campaign: string; accounts: number; state: string }[] }).fleets;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.accounts, 5, "a restored fleet still knows its wallets");
    const held = await s.elsewhere("holdings", { campaign: listed[0]!.campaign, tokens: [] });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.equal((held.body as { holdings: unknown[] }).holdings.length, 5);
  });
});

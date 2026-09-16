import assert from "node:assert/strict";
import test from "node:test";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { OnChainSession } from "../../src/fleet/chain-campaign.js";
import type { FleetChain } from "../../src/fleet/chain-service.js";
import type { BalanceView, DrawSummary, PoolPort, WithdrawInput } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * The guards every money route now has, from the audit: nothing is drawn,
 * bought or paid for a wallet that asked to leave (F7); a buy is refused on
 * what the chain says about the session, not on what this instance remembers
 * (A14); tokens outside the allowlist and malformed account lists are
 * refused before any money moves (A8, A41); a gas ceiling below the floor is
 * refused (A9); a draw below its own headroom is refused (A3); and two
 * withdrawals of the same balance sent together are paid once (A5).
 */

const trader = privateKeyToAccount(`0x${"52".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const POOL = "0x0000000000000000000000000000000000000901" as Address;
const VENUE = "0x0000000000000000000000000000000000000fee" as Address;
const owner = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const policy = (perAccountGas = "200000000000000") => ({
  chainId: 46630, accounts: 5,
  router: "0x8876789976decbfcbbbe364623c63652db8c0904",
  function: "execute(bytes,bytes[],uint256)",
  maxTradeValue: "1000000000000000",
  perAccountGas,
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
});

type Knobs = { exiting?: boolean; live?: Partial<OnChainSession>; allowedTokens?: Address[]; slowWithdraw?: boolean };

const makeRouter = (knobs: Knobs = {}) => {
  let available = parseEther("0.08");
  let draw: DrawSummary = {
    amount: parseEther("0.02").toString(), spent: "0", remaining: parseEther("0.02").toString(),
    dueAt: "2026-09-08T12:05:00.000Z", state: "Funded",
  };
  const paid: WithdrawInput[] = [];
  const bought: string[] = [];
  const service = new CampaignService(serviceConfig);
  const pool: PoolPort = {
    balance: async (): Promise<BalanceView> => ({
      available: available.toString(), deposited: parseEther("0.1").toString(), spent: "0",
      openDraws: "0", headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" },
      exit: knobs.exiting ? { requestedAt: "2026-09-14T10:00:00.000Z", amount: "1", availableAt: "2026-09-15T10:00:00.000Z" } : {},
      pool: { paused: false }, poolAddress: POOL,
    }),
    withdraw: async (input) => {
      if (knobs.slowWithdraw) await new Promise((r) => setTimeout(r, 20));
      paid.push(input);
      available -= BigInt(input.amount);
      return { payoutTx: `0x${"a".repeat(64)}`, chargeId: "owed-1" };
    },
    openDraw: async () => draw,
    topUpDraw: async ({ amount }) => { draw = { ...draw, amount, remaining: amount }; return draw; },
    drawOf: async () => draw,
    ownerOf: async () => trader.address.toLowerCase() as Address,
    closeDraw: async () => { draw = { ...draw, state: "Closed" }; return draw; },
    sweep: async () => ({ funded: [], posted: [] }),
    buy: async ({ buys }) => { bought.push(...buys.map((b) => b.account)); return { results: buys.map((b) => ({ account: b.account, status: "sponsored" as const })), draw }; },
  };
  const session: OnChainSession = {
    chainId: 46630n, router: policy().router as Address, selector: "0x24856bc3", maxTradeValue: 10n ** 15n,
    perAccountGas: 2n * 10n ** 14n, totalGas: 10n ** 15n, expiry: 1_800_000_000n, spentGas: 0n,
    paused: false, revoked: false, exists: true, ...knobs.live,
  } as OnChainSession;
  const chain: FleetChain = {
    registerCampaign: async () => undefined,
    readBudget: async () => ({ funded: "0", reserved: "0", spent: "0", unused: "0" }),
    activate: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)],
    buy: async () => ({ results: [], budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } }),
    loadCampaign: async () => undefined,
    isEnrolled: async () => true,
    accountsOf: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)],
    sessionOf: async () => session,
    control: async () => `0x${"c".repeat(64)}`,
  } as FleetChain;
  // every buy on the real venue needs a quote now; the fake pool has one
  const market = {
    tokenQuote: async () => ({ token: VENUE, symbol: "FLEET", decimals: 18, hasPool: true, sqrtPriceX96: "1", estimatedOut: "1000000" }),
    holdings: async () => [],
    campaignsOf: async () => [],
  };
  const deps: RouterDeps = { service, pool, chain, market, ...(knobs.allowedTokens ? { allowedTokens: knobs.allowedTokens } : {}) };
  return { router: new CampaignRouter(deps), service, paid, bought };
};

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const fields = { primaryWallet: trader.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
  return { action, auth: { ...fields, signature: await trader.signMessage({ message: challengeBytes(serviceConfig, fields) }) } as AuthEnvelope, body };
};

let counter = 0;
const key = () => `fleet-g${String(counter++).padStart(16, "0")}`;

const activeCampaign = async (router: CampaignRouter, service: CampaignService, perAccountGas?: string, draw = parseEther("0.02")) => {
  const created = await router.handle(
    await signed(service, "create", {
      quoteId: "q", policy: policy(perAccountGas),
      accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) })),
      recoveryVaultCommitment: `0x${"3".repeat(64)}`,
    }),
    key(),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const campaign = (created.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign }), key());
  const activated = await router.handle(await signed(service, "activate", { campaign, draw: draw.toString() }), key());
  return { campaign, activated };
};

const buy = (service: CampaignService, campaign: string, extra: Record<string, unknown> = {}) =>
  signed(service, "buy", { campaign, accounts: [owner(11)], token: VENUE, value: "1", ...extra });

test("a wallet that asked to exit is refused a withdrawal, a draw and a buy", async () => {
  const { router, service, paid, bought } = makeRouter({ exiting: true });
  const withdrawal = await router.handle(await signed(service, "withdraw", { amount: "1", destination: owner(99) }), key());
  assert.equal(withdrawal.status, 409, JSON.stringify(withdrawal.body));
  assert.equal(paid.length, 0);

  const { activated } = await activeCampaign(router, service);
  assert.equal(activated.status, 409, "no draw is opened for a leaving wallet");
  assert.equal(bought.length, 0);
});

test("a buy is refused when the chain says the session is paused, whatever this instance remembers", async () => {
  const { router, service, bought } = makeRouter({ live: { paused: true } });
  const { campaign } = await activeCampaign(router, service);
  const result = await router.handle(await buy(service, campaign), key());
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(bought.length, 0, "no principal moved");
});

test("a buy is refused when the chain says the session is revoked", async () => {
  const { router, service, bought } = makeRouter({ live: { revoked: true } });
  const { campaign } = await activeCampaign(router, service);
  const result = await router.handle(await buy(service, campaign), key());
  assert.equal(result.status, 409);
  assert.equal(bought.length, 0);
});

test("a token outside the allowlist is refused before any money moves", async () => {
  const { router, service, bought } = makeRouter({ allowedTokens: [VENUE] });
  const { campaign } = await activeCampaign(router, service);
  const refused = await router.handle(await buy(service, campaign, { token: owner(0xbad) }), key());
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(bought.length, 0);
  const allowed = await router.handle(await buy(service, campaign), key());
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(bought.length, 1);
});

test("account lists are addresses only, deduped, and never larger than the fleet", async () => {
  const { router, service, bought } = makeRouter();
  const { campaign } = await activeCampaign(router, service);
  const junk = await router.handle(await buy(service, campaign, { accounts: ["not-an-address"] }), key());
  assert.equal(junk.status, 422, JSON.stringify(junk.body));
  const many = await router.handle(await buy(service, campaign, { accounts: Array.from({ length: 6 }, (_, i) => owner(20 + i)) }), key());
  assert.equal(many.status, 422, JSON.stringify(many.body));
  const dupes = await router.handle(await buy(service, campaign, { accounts: [owner(11), owner(11), owner(11)] }), key());
  assert.equal(dupes.status, 200, JSON.stringify(dupes.body));
  assert.equal(bought.length, 1, "three names, one account, one buy");
});

test("a gas ceiling below the floor is refused", async () => {
  const { router, service, bought } = makeRouter();
  const { campaign } = await activeCampaign(router, service, "1");
  const result = await router.handle(await buy(service, campaign), key());
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(bought.length, 0);
});

test("a draw that could not fund its own fleet is refused", async () => {
  const { router, service } = makeRouter();
  const { activated } = await activeCampaign(router, service, undefined, parseEther("0.0005"));
  assert.equal(activated.status, 422, JSON.stringify(activated.body));
});

test("two withdrawals of the whole balance sent together pay once", async () => {
  const { router, service, paid } = makeRouter({ slowWithdraw: true });
  const whole = parseEther("0.08").toString();
  const [a, b] = await Promise.all([
    signed(service, "withdraw", { amount: whole, destination: owner(98) }),
    signed(service, "withdraw", { amount: whole, destination: owner(99) }),
  ]);
  const results = await Promise.all([router.handle(a, key()), router.handle(b, key())]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 422], JSON.stringify(results.map((r) => r.body)));
  assert.equal(paid.length, 1, "the second saw the balance the first left");
});

test("a buy on the real venue carries a minimum output from the spot quote, and is refused without a pool", async () => {
  const { encodeV4EthBuy, UNIVERSAL_ROUTER_EXECUTE } = await import("../../src/fleet/v4-swap.js");
  const now = new Date("2026-09-15T12:00:00.000Z");
  let hasPool = true;
  const market = {
    tokenQuote: async () => ({ token: VENUE, symbol: "FLEET", decimals: 18, hasPool, sqrtPriceX96: "1", estimatedOut: "1000000" }),
    holdings: async () => [],
    campaignsOf: async () => [],
  };
  const captured: { callData: string }[] = [];
  // a router of our own so the pool fake can capture calldata
  const service = new CampaignService(serviceConfig);
  const draw: DrawSummary = { amount: parseEther("0.02").toString(), spent: "0", remaining: parseEther("0.02").toString(), dueAt: "2026-09-08T12:05:00.000Z", state: "Funded" };
  const capturing: PoolPort = {
    balance: async () => ({ available: parseEther("0.08").toString(), deposited: parseEther("0.1").toString(), spent: "0", openDraws: "0", headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" }, exit: {}, pool: { paused: false }, poolAddress: POOL }),
    withdraw: async () => ({ payoutTx: `0x${"a".repeat(64)}`, chargeId: "owed-1" }),
    openDraw: async () => draw, topUpDraw: async () => draw, drawOf: async () => draw,
    ownerOf: async () => trader.address.toLowerCase() as Address, closeDraw: async () => draw,
    sweep: async () => ({ funded: [], posted: [] }),
    buy: async ({ buys }) => { captured.push(...buys); return { results: buys.map((b) => ({ account: b.account, status: "sponsored" as const })), draw }; },
  };
  const chain: FleetChain = {
    registerCampaign: async () => undefined, readBudget: async () => ({ funded: "0", reserved: "0", spent: "0", unused: "0" }),
    activate: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)],
    buy: async () => ({ results: [], budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } }),
    loadCampaign: async () => undefined, isEnrolled: async () => true,
    accountsOf: async () => [owner(11)], sessionOf: async () => ({ chainId: 46630n, router: policy().router as Address, selector: "0x24856bc3", maxTradeValue: 10n ** 15n, perAccountGas: 2n * 10n ** 14n, totalGas: 10n ** 15n, expiry: 1_800_000_000n, spentGas: 0n, paused: false, revoked: false, exists: true } as OnChainSession),
    control: async () => `0x${"c".repeat(64)}`,
  } as FleetChain;
  const router = new CampaignRouter({ service, pool: capturing, chain, market, maxSlippageBps: 250, now: () => now });

  const created = await router.handle(await signed(service, "create", {
    quoteId: "q", policy: { ...policy(), function: UNIVERSAL_ROUTER_EXECUTE },
    accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) })),
    recoveryVaultCommitment: `0x${"3".repeat(64)}`,
  }), key());
  const campaign = (created.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign }), key());
  await router.handle(await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }), key());

  const ok = await router.handle(await buy(service, campaign), key());
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const expected = encodeV4EthBuy({ token: VENUE, amountIn: 1n, minOut: 972_075n, deadline: BigInt(Math.floor(now.getTime() / 1000) + 3600) });
  assert.equal(captured[0]?.callData, expected, "amountOutMinimum = estimate less the pool's 0.3% fee, less 2.5%, never zero");

  hasPool = false;
  const refused = await router.handle(await buy(service, campaign), key());
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(captured.length, 1, "no principal moved for a token without a pool");
});

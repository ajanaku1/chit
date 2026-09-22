import assert from "node:assert/strict";
import test from "node:test";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { OnChainSession } from "../../src/fleet/chain-campaign.js";
import type { FleetChain } from "../../src/fleet/chain-service.js";
import type { BalanceView, DrawSummary, PoolPort, PooledBuyOutcome } from "../../src/fleet/pool-buy.js";
import { createMemoryStore } from "../../src/fleet/store.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/** T070: a campaign with three gas-spending failures in the last hour refuses buys, saying why and when it reopens; refusals that spent nothing never count. */

const trader = privateKeyToAccount(`0x${"52".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const VENUE = `0x${"f".repeat(38)}ee` as Address;
const owner = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const policy = { chainId: 46630, accounts: 5, router: "0x8876789976decbfcbbbe364623c63652db8c0904", function: "execute(bytes,bytes[],uint256)", maxTradeValue: "1000000000000000", perAccountGas: "200000000000000", totalGas: "1000000000000000", expiry: "2026-12-31T00:00:00.000Z" };

const makeRouter = () => {
  let now = new Date("2026-09-22T12:00:00.000Z");
  let outcome: PooledBuyOutcome["status"] = "sponsored";
  let spentGas = false;
  const service = new CampaignService(serviceConfig);
  const store = createMemoryStore();
  const draw: DrawSummary = { amount: parseEther("0.02").toString(), spent: "0", remaining: parseEther("0.02").toString(), dueAt: "2026-09-08T12:05:00.000Z", state: "Funded" };
  const pool: PoolPort = {
    balance: async (): Promise<BalanceView> => ({ available: parseEther("0.08").toString(), deposited: parseEther("0.1").toString(), spent: "0", openDraws: "0", headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" }, exit: {}, pool: { paused: false }, poolAddress: owner(0x901) }),
    withdraw: async () => ({ payoutTx: `0x${"a".repeat(64)}`, chargeId: "c" }),
    openDraw: async () => draw, topUpDraw: async () => draw, drawOf: async () => draw, ownerOf: async () => trader.address.toLowerCase() as Address, closeDraw: async () => draw,
    sweep: async () => ({ funded: [], posted: [] }),
    buy: async ({ buys }) => ({ results: buys.map((b) => ({ account: b.account, status: outcome, ...(outcome === "rejected" ? { reason: spentGas ? "CallFailed" : "never-mined", ...(spentGas ? { spentGas: true } : {}) } : {}) })), draw }),
  };
  const session = { chainId: 46630n, router: policy.router as Address, selector: "0x24856bc3", maxTradeValue: 10n ** 15n, perAccountGas: 2n * 10n ** 14n, totalGas: 10n ** 15n, expiry: 1_800_000_000n, spentGas: 0n, paused: false, revoked: false, exists: true } as OnChainSession;
  const chain = { registerCampaign: async () => undefined, readBudget: async () => ({ funded: "0", reserved: "0", spent: "0", unused: "0" }), activate: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)], buy: async () => ({ results: [], budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } }), loadCampaign: async () => undefined, isEnrolled: async () => true, accountsOf: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)], sessionOf: async () => session, control: async () => `0x${"c".repeat(64)}` } as FleetChain;
  const market = { tokenQuote: async () => ({ token: VENUE, symbol: "FLEET", decimals: 18, hasPool: true, sqrtPriceX96: "1", estimatedOut: "1000000" }), holdings: async () => [], campaignsOf: async () => [] };
  const deps: RouterDeps = { service, pool, chain, market, store, now: () => now };
  return {
    router: new CampaignRouter(deps), service,
    fail: (gas: boolean) => { outcome = "rejected"; spentGas = gas; }, succeed: () => { outcome = "sponsored"; },
    tick: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
};
const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const fields = { primaryWallet: trader.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
  return { action, auth: { ...fields, signature: await trader.signMessage({ message: challengeBytes(serviceConfig, fields) }) } as AuthEnvelope, body };
};
let counter = 0;
const key = () => `fleet-cd${String(counter++).padStart(16, "0")}`;

test("three gas-spending failures inside an hour close the campaign, the depositor is told when it reopens, and refusals that spent nothing never count", async () => {
  const { router, service, fail, succeed, tick } = makeRouter();
  const created = await router.handle(await signed(service, "create", { quoteId: "q", policy, accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) })), recoveryVaultCommitment: `0x${"3".repeat(64)}` }), key());
  const campaign = (created.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign }), key());
  await router.handle(await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }), key());
  const buyRequest = (s: CampaignService, c: string) => signed(s, "buy", { campaign: c, accounts: [owner(11)], token: VENUE, value: "1000000000000000" });

  fail(false);
  for (let i = 0; i < 3; i++) assert.equal((await router.handle(await buyRequest(service, campaign), key())).status, 200, "a refusal that spent nothing is answered, not counted");
  fail(true);
  for (let i = 0; i < 2; i++) { assert.equal((await router.handle(await buyRequest(service, campaign), key())).status, 200); tick(60_000); }
  const third = await router.handle(await buyRequest(service, campaign), key());
  assert.equal(third.status, 200, "the third failure is still answered; it is the next buy that is refused");
  tick(1_000);
  const refused = await router.handle(await buyRequest(service, campaign), key());
  assert.equal(refused.status, 403);
  const reason = (refused.body as { reason: string }).reason;
  assert.match(reason, /^campaign_cooling_down:2026-09-22T13:02:00\.000Z$/, "why, and when it reopens");
  succeed();
  tick(3_600_000);
  const again = await router.handle(await buyRequest(service, campaign), key());
  assert.equal(again.status, 200, "an hour later the campaign takes buys again");
});

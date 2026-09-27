/**
 * The sale actions on the router (docs/design-sell.md): sellGas, sell and
 * sales, each signed by the campaign's own depositor. What is pinned: only the
 * owner of a fleet can sell from it; the main wallet is refused as the payout
 * with the reason; a sale starts at once; gas is once an hour per fleet and
 * token; without the sale machinery the actions answer 503, never a guess.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { SellChain, SellDeps } from "../../src/fleet/sell.js";
import { createMemoryStore } from "../../src/fleet/store.js";
import type { Address, AuthEnvelope, Hex } from "../../src/fleet/types.js";

const trader = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const TOKEN = addr(0x77);
const OPERATOR = addr(0x0e);
const PAYOUT = addr(0xef);
const H = salt(0xabc);

const policy = () => ({
  chainId: 46630, accounts: 5, router: addr(0x88), function: "execute(bytes,bytes[],uint256)",
  maxTradeValue: "500000000000000", perAccountGas: "200000000000000", totalGas: "1000000000000000", expiry: "2026-12-31T00:00:00.000Z",
});

const chain: SellChain = {
  async transfersIn(h) { return h === H ? { mined: true, transfers: [{ token: TOKEN, from: addr(0xa1), to: OPERATOR, amount: 5_000n }] } : { mined: false, transfers: [] }; },
  async enrolled() { return true; },
  async sellQuote() { return 1_000n; },
  async send(step) { await step.record(salt(1), 1); return { status: "mined", hash: salt(1) }; },
  async resolve(h) { return { status: "mined", hash: h }; },
  async ethReceived() { return 980n; },
  async balance() { return 0n; },
};

const sellDeps = (): SellDeps => ({
  store: createMemoryStore(), operator: OPERATOR, router: addr(0x88), chain, now: () => 1_000_000, random: () => 0.5,
  registry: { chainId: 4663, tokens: [{ token: TOKEN, symbol: "HEY", decimals: 18, poolId: salt(9), slippageBps: 400, enabled: true, poolKey: { currency0: addr(0), currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: addr(0x44) } }] },
});

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>, who = trader) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: who.address, action, payloadHash: hash });
  const fields = { primaryWallet: who.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
  const auth: AuthEnvelope = { ...fields, signature: await who.signMessage({ message: challengeBytes(serviceConfig, fields) }) };
  return { action, auth, body };
};

const setup = async (withSell = true) => {
  const service = new CampaignService(serviceConfig);
  const sell = sellDeps();
  const deps: RouterDeps = { service, ...(withSell ? { sell } : {}) };
  const router = new CampaignRouter(deps);
  const create = await router.handle(await signed(service, "create", {
    quoteId: "q-1", policy: policy(), recoveryVaultCommitment: `0x${"3".repeat(64)}`,
    accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: addr(0x100 + i), salt: salt(i + 1) })),
  }), "fleet-create0000000000");
  const campaign = (create.body as { campaign: string }).campaign;
  assert.equal(create.status, 201, JSON.stringify(create.body));
  return { router, service, sell, campaign };
};

test("a sale starts at once: the fleet's transfer counted, sold, and owed to the payout wallet", async () => {
  const { router, service, campaign } = await setup();
  const result = await router.handle(await signed(service, "sell", { campaign, token: TOKEN, payout: PAYOUT, transfers: [H] }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const sale = (result.body as { sale: Record<string, unknown> }).sale;
  assert.equal(sale["state"], "sold");
  assert.equal(sale["ethOut"], "980");
  assert.equal(sale["saleNonce"], undefined, "the operator's own bookkeeping stays out of the answer");
  const listed = await router.handle(await signed(service, "sales", {}));
  assert.equal(((listed.body as { sales: unknown[] }).sales).length, 1);
});

test("the main wallet is refused as the payout, with the reason", async () => {
  const { router, service, campaign } = await setup();
  const result = await router.handle(await signed(service, "sell", { campaign, token: TOKEN, payout: trader.address, transfers: [H] }));
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { code: "policy_rejected", retryable: false, reason: "payout_is_main_wallet" });
});

test("nobody sells from a fleet that is not theirs", async () => {
  const { router, service, campaign } = await setup();
  const result = await router.handle(await signed(service, "sell", { campaign, token: TOKEN, payout: PAYOUT, transfers: [H] }, stranger));
  assert.notEqual(result.status, 200);
  assert.match(JSON.stringify(result.body), /campaign_unknown/);
});

test("gas for the owner keys is once an hour per fleet and token, and only for a listed token", async () => {
  const { router, service, campaign } = await setup();
  const first = await router.handle(await signed(service, "sellGas", { campaign, token: TOKEN }));
  assert.equal(first.status, 200);
  assert.equal((first.body as { topped: unknown[] }).topped.length, 5, "every owner key, which held nothing");
  const again = await router.handle(await signed(service, "sellGas", { campaign, token: TOKEN }));
  assert.deepEqual(again.body, { operator: OPERATOR, topped: [] }, "inside the hour: where to send, and no more gas");
  const other = await router.handle(await signed(service, "sellGas", { campaign, token: addr(0x99) }));
  assert.deepEqual(other.body, { code: "policy_rejected", retryable: false, reason: "token_not_listed" });
});

test("without the sale machinery the actions answer 503, never a guess", async () => {
  const { router, service } = await setup(false);
  const result = await router.handle(await signed(service, "sales", {}));
  assert.equal(result.status, 503);
  assert.match(JSON.stringify(result.body), /selling_unconfigured/);
});

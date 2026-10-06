/**
 * `recoverGas` on the router: gas for a finished fleet's owner keys to send
 * home the ETH its accounts were seeded with. What is pinned: a fleet that is
 * still trading is refused, since that ETH is its gas; a closed one gets each
 * owner key topped up, once an hour per key, as a sale does; only the fleet's
 * owner may ask; without the sale machinery the answer is 503.
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
const OPERATOR = addr(0x0e);

const chain: SellChain = {
  async transfersIn() { return { mined: false, transfers: [] }; },
  async enrolled() { return true; },
  async sellQuote() { return 1_000n; },
  async send(step) { await step.record(salt(1), 1); return { status: "mined", hash: salt(1) }; },
  async resolve(h) { return { status: "mined", hash: h }; },
  async ethReceived() { return 0n; },
  async balance() { return 0n; },
};

const sellDeps = (): SellDeps => ({
  store: createMemoryStore(), operator: OPERATOR, router: addr(0x88), chain, now: () => 1_000_000, random: () => 0.5,
  registry: { chainId: 46630, tokens: [] },
});

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>, who = trader) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: who.address, action, payloadHash: hash });
  const fields = { primaryWallet: who.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
  const auth: AuthEnvelope = { ...fields, signature: await who.signMessage({ message: challengeBytes(serviceConfig, fields) }) };
  return { action, auth, body };
};

let sequence = 0;
const key = () => `fleet-${(sequence++).toString().padStart(16, "0")}`;

const setup = async (withSell = true) => {
  const service = new CampaignService(serviceConfig);
  const deps: RouterDeps = {
    service, verifyFunding: async () => "1000000000000000",
    submitter: { async submit() { return { userOpHash: salt(0xef), actualGasCost: "120000000000" }; } },
    ...(withSell ? { sell: sellDeps() } : {}),
  };
  const router = new CampaignRouter(deps);
  const create = await router.handle(await signed(service, "create", {
    quoteId: "q-1",
    policy: { chainId: 46630, accounts: 5, router: addr(0x88), function: "execute(bytes,bytes[],uint256)", maxTradeValue: "500000000000000", perAccountGas: "200000000000000", totalGas: "1000000000000000", expiry: "2026-12-31T00:00:00.000Z" },
    accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: addr(0x100 + i), salt: salt(i + 1) })),
    recoveryVaultCommitment: `0x${"3".repeat(64)}`,
  }), key());
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const campaign = (create.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign, vaultConfirmed: true }), key());
  await router.handle(await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key());
  await router.handle(await signed(service, "activate", { campaign }), key());
  return { router, service, campaign };
};

test("a fleet still trading keeps its gas: recovery is refused until it is finished", async () => {
  const { router, service, campaign } = await setup();
  const result = await router.handle(await signed(service, "recoverGas", { campaign, payout: addr(0xef) }));
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(JSON.stringify(result.body), /fleet_not_finished/);
});

test("a closed fleet's owner keys are topped up once, then not again inside the hour", async () => {
  const { router, service, campaign } = await setup();
  const closed = await router.handle(await signed(service, "close", { campaign }), key());
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const first = await router.handle(await signed(service, "recoverGas", { campaign, payout: addr(0xef) }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((first.body as { topped: unknown[] }).topped.length, 5, "every owner key, which held nothing");
  const again = await router.handle(await signed(service, "recoverGas", { campaign, payout: addr(0xef) }));
  assert.deepEqual(again.body, { topped: [] }, "inside the hour: no more gas");
});

test("nobody gets gas for a fleet that is not theirs", async () => {
  const { router, service, campaign } = await setup();
  const result = await router.handle(await signed(service, "recoverGas", { campaign }, stranger));
  assert.notEqual(result.status, 200);
  assert.match(JSON.stringify(result.body), /campaign_unknown/);
});

test("without the sale machinery the action answers 503, never a guess", async () => {
  const { router, service, campaign } = await setup(false);
  const result = await router.handle(await signed(service, "recoverGas", { campaign }));
  assert.equal(result.status, 503);
});

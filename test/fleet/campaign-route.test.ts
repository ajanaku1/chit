import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { FeeConfig } from "../../src/fleet/eligibility.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

const trader = privateKeyToAccount(`0x${"11".repeat(32)}`);
const pauper = privateKeyToAccount(`0x${"22".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const feeConfig: FeeConfig = {
  threshold: "1000",
  baseFee: "100",
  discount: "25",
  feeAsset: "ETH",
  recipient: "0x00000000000000000000000000000000000000f1",
};

const owner = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const accounts = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) }));
const commitment = `0x${"3".repeat(64)}` as const;

const policy = (count = 5) => ({
  chainId: 46630,
  accounts: count,
  router: "0x8876789976decbfcbbbe364623c63652db8c0904",
  function: "execute(bytes,bytes[],uint256)",
  maxTradeValue: "1000000000000000",
  perAccountGas: "200000000000000",
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
});

const makeRouter = (balances: Record<string, string> = {}) => {
  const service = new CampaignService(serviceConfig);
  const deps: RouterDeps = {
    service,
    feeConfig,
    chitBalanceOf: async (wallet: `0x${string}`) => balances[wallet.toLowerCase()] ?? "0",
    verifyFunding: async () => "1000000000000000",
  };
  return { router: new CampaignRouter(deps), service };
};

const signed = async (
  service: CampaignService,
  action: string,
  body: Record<string, unknown>,
  options: { signer?: typeof trader; outerAction?: string; mangleBody?: Record<string, unknown> } = {},
) => {
  const signer = options.signer ?? trader;
  const hash = payloadHash(body);
  const challenge = service.issueChallenge({ primaryWallet: signer.address, action, payloadHash: hash });
  const auth: AuthEnvelope = {
    primaryWallet: signer.address,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    action,
    payloadHash: hash,
    signature: await signer.signMessage({
      message: challengeBytes(serviceConfig, {
        primaryWallet: signer.address,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        action,
        payloadHash: hash,
      }),
    }),
  };
  return { action: options.outerAction ?? action, auth, body: options.mangleBody ?? body };
};

const key = (suffix: string) => `fleet-${suffix.padEnd(16, "0")}`;

const createCampaign = async (router: CampaignRouter, service: CampaignService, count = 5) => {
  const body = { quoteId: "q-1", policy: policy(count), accounts: accounts(count), recoveryVaultCommitment: commitment };
  const request = await signed(service, "create", body);
  return router.handle(request, key("create"));
};

test("quote and challenge are unsigned and a quote discloses the fee facts", async () => {
  const { router } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const quote = await router.handle({ action: "quote", body: { primaryWallet: trader.address } });
  assert.equal(quote.status, 200);
  const quoteBody = quote.body as { threshold: string; baseFee: string; discount: string; netFee: string; eligible: boolean };
  assert.equal(quoteBody.netFee, "75");
  assert.equal(quoteBody.eligible, true);

  const challenge = await router.handle({
    action: "challenge",
    body: { primaryWallet: trader.address, action: "create", payloadHash: payloadHash({}) },
  });
  assert.equal(challenge.status, 200);
  assert.ok((challenge.body as { nonce: string }).nonce.length > 0);
});

test("an eligible wallet creates a 5-account campaign with its vault commitment", async () => {
  const { router, service } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const created = await createCampaign(router, service);
  assert.equal(created.status, 201);
  const body = created.body as { campaign: string; state: string; fee?: { netFee: string } };
  assert.equal(body.state, "Awaiting recovery confirmation");
  assert.ok(body.campaign.length > 0);
  assert.equal(body.fee?.netFee, "75");
});

test("50 accounts are accepted; 4 and 51 are not; duplicates are not", async () => {
  const balances = { [trader.address.toLowerCase()]: "1000" };
  {
    const { router, service } = makeRouter(balances);
    assert.equal((await createCampaign(router, service, 50)).status, 201);
  }
  for (const count of [4, 51]) {
    const { router, service } = makeRouter(balances);
    const result = await createCampaign(router, service, count);
    assert.equal(result.status, 422);
    assert.equal((result.body as { code: string }).code, "policy_rejected");
  }
  {
    const { router, service } = makeRouter(balances);
    const body = {
      quoteId: "q-1",
      policy: policy(),
      accounts: [...accounts(4), { ownerAddress: owner(1), salt: salt(9) }],
      recoveryVaultCommitment: commitment,
    };
    const result = await router.handle(await signed(service, "create", body), key("dup"));
    assert.equal(result.status, 422);
  }
});

test("an ineligible wallet is blocked before any campaign state exists", async () => {
  const { router, service } = makeRouter({ [pauper.address.toLowerCase()]: "999" });
  const body = { quoteId: "q-1", policy: policy(), accounts: accounts(5), recoveryVaultCommitment: commitment };
  const result = await router.handle(await signed(service, "create", body, { signer: pauper }), key("poor"));
  assert.equal(result.status, 403);
  assert.equal((result.body as { code: string }).code, "ineligible");

  const read = await router.handle(await signed(service, "read", { campaign: "any" }, { signer: pauper }));
  assert.equal(read.status, 409, "no campaign was created for the blocked wallet");
});

test("an outer action that disagrees with the signed envelope is refused", async () => {
  const { router, service } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const body = { campaign: "handle" };
  const result = await router.handle(await signed(service, "read", body, { outerAction: "activate" }), key("confuse"));
  assert.equal(result.status, 401);
  assert.equal((result.body as { code: string }).code, "challenge_invalid");
});

test("a body that no longer matches the signed payload hash is refused", async () => {
  const { router, service } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const body = { quoteId: "q-1", policy: policy(), accounts: accounts(5), recoveryVaultCommitment: commitment };
  const mangled = { ...body, recoveryVaultCommitment: `0x${"4".repeat(64)}` };
  const result = await router.handle(await signed(service, "create", body, { mangleBody: mangled }), key("mangle"));
  assert.equal(result.status, 401);
});

test("a malformed vault commitment is refused before creation", async () => {
  const { router, service } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const body = { quoteId: "q-1", policy: policy(), accounts: accounts(5), recoveryVaultCommitment: "0xshort" };
  const result = await router.handle(await signed(service, "create", body), key("badc"));
  assert.equal(result.status, 422);
});

test("create is idempotent under its key and conflicts on a changed payload", async () => {
  const { router, service } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const body = { quoteId: "q-1", policy: policy(), accounts: accounts(5), recoveryVaultCommitment: commitment };

  const first = await router.handle(await signed(service, "create", body), key("idem"));
  const replay = await router.handle(await signed(service, "create", body), key("idem"));
  assert.equal(first.status, 201);
  assert.deepEqual(replay.body, first.body, "same key and payload returns the original result");

  const changed = { ...body, quoteId: "q-2" };
  const conflict = await router.handle(await signed(service, "create", changed), key("idem"));
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body as { code: string }).code, "idempotency_conflict");
});

test("the journey advances confirmRecovery, fund, activate in order and rejects skips", async () => {
  const { router, service } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const created = await createCampaign(router, service);
  const campaign = (created.body as { campaign: string }).campaign;

  const skip = await router.handle(
    await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key("skip"));
  assert.equal(skip.status, 409, "funding before recovery confirmation is refused");

  const confirm = await router.handle(
    await signed(service, "confirmRecovery", { campaign, vaultConfirmed: true }), key("confirm"));
  assert.equal((confirm.body as { state: string }).state, "Awaiting funding");

  const fund = await router.handle(
    await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key("fund"));
  assert.equal((fund.body as { state: string }).state, "Activating");

  const activate = await router.handle(await signed(service, "activate", { campaign }), key("act"));
  assert.equal((activate.body as { state: string }).state, "Active");
  assert.equal((activate.body as { accounts: string[] }).accounts.length, 5);

  const read = await router.handle(await signed(service, "read", { campaign }));
  assert.equal(read.status, 200);
  assert.equal((read.body as { state: string }).state, "Active");
});

test("a response never carries a secret, a raw signature, or a primary-to-fleet edge", async () => {
  const { router, service } = makeRouter({ [trader.address.toLowerCase()]: "1000" });
  const created = await createCampaign(router, service);
  const serialized = JSON.stringify(created.body);
  assert.equal(serialized.includes("signature"), false);
  assert.equal(serialized.includes(trader.address.toLowerCase()), false, "the response does not echo the primary wallet");
  assert.equal(serialized.includes("privateKey"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { FeeConfig } from "../../src/fleet/eligibility.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";
import type { PackedUserOperation, SubmitResult, UserOperationSubmitter } from "../../src/fleet/user-operation.js";

const trader = privateKeyToAccount(`0x${"11".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const feeConfig: FeeConfig = {
  threshold: "1000", baseFee: "100", discount: "25",
  feeAsset: "ETH", recipient: "0x00000000000000000000000000000000000000f1",
};

const owner = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const TOKEN = owner(0x77);
const ROUTER = owner(0x88);
const FUNDING = "1000000000000000"; // 0.001 ETH of budget
const ACTUAL_COST = "120000000000"; // per sponsored op

const policy = () => ({
  chainId: 46630, accounts: 5, router: ROUTER,
  function: "execute(bytes,bytes[],uint256)",
  maxTradeValue: "500000000000000",
  perAccountGas: "200000000000000",
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
});

/** In-process chain double: tracks token balances and native ETH per account. */
class FakeChain implements UserOperationSubmitter {
  tokenBalances = new Map<string, bigint>();
  nativeCharges = new Map<string, bigint>();
  submissions: PackedUserOperation[] = [];
  failFor = new Set<string>();

  async submit(op: PackedUserOperation): Promise<SubmitResult> {
    if (this.failFor.has(op.sender.toLowerCase())) throw new Error("simulated revert");
    this.submissions.push(op);
    const key = op.sender.toLowerCase();
    this.tokenBalances.set(key, (this.tokenBalances.get(key) ?? 0n) + 1000n);
    // Sponsored: the account's own ETH is never charged.
    this.nativeCharges.set(key, this.nativeCharges.get(key) ?? 0n);
    return { userOpHash: `0x${"ab".repeat(32)}`, actualGasCost: ACTUAL_COST };
  }
}

const makeRouter = (funding = FUNDING) => {
  const service = new CampaignService(serviceConfig);
  const chain = new FakeChain();
  const deps: RouterDeps = {
    service,
    feeConfig,
    chitBalanceOf: async () => "1000",
    verifyFunding: async () => funding,
    submitter: chain,
  };
  return { router: new CampaignRouter(deps), service, chain };
};

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const challenge = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const auth: AuthEnvelope = {
    primaryWallet: trader.address,
    nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
    action, payloadHash: hash,
    signature: await trader.signMessage({
      message: challengeBytes(serviceConfig, {
        primaryWallet: trader.address,
        nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
        action, payloadHash: hash,
      }),
    }),
  };
  return { action, auth, body };
};

const key = (suffix: string) => `fleet-${suffix.padEnd(16, "0")}`;

const activeCampaign = async (router: CampaignRouter, service: CampaignService): Promise<string> => {
  const create = await router.handle(await signed(service, "create", {
    quoteId: "q-1", policy: policy(),
    accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) })),
    recoveryVaultCommitment: `0x${"3".repeat(64)}`,
  }), key("create"));
  const campaign = (create.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign, vaultConfirmed: true }), key("confirm"));
  await router.handle(await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key("fund"));
  await router.handle(await signed(service, "activate", { campaign }), key("activate"));
  return campaign;
};

const buyBody = (campaign: string, accounts: `0x${string}`[], value = "400000000000000") =>
  ({ campaign, accounts, token: TOKEN, value });

test("five permitted buys are sponsored, balances change, and the debit is exact", async () => {
  const { router, service, chain } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const accounts = Array.from({ length: 5 }, (_, i) => owner(i + 1));

  const result = await router.handle(await signed(service, "buy", buyBody(campaign, accounts)), key("buy"));
  assert.equal(result.status, 200);
  const body = result.body as { results: { account: string; status: string; budget: { spent: string } }[] };
  assert.equal(body.results.length, 5);
  for (const entry of body.results) assert.equal(entry.status, "sponsored");

  // SC-003: all five token balances changed, no account paid its own ETH.
  assert.equal(chain.submissions.length, 5);
  for (const account of accounts) {
    assert.equal(chain.tokenBalances.get(account.toLowerCase()), 1000n);
    assert.equal(chain.nativeCharges.get(account.toLowerCase()), 0n);
  }

  // SC-004: the budget debit equals exactly the five attributed costs.
  const spent = body.results[4]!.budget.spent;
  assert.equal(spent, (5n * BigInt(ACTUAL_COST)).toString());
});

test("a request above the trade cap is rejected before any sponsorship", async () => {
  const { router, service, chain } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const result = await router.handle(
    await signed(service, "buy", buyBody(campaign, [owner(1)], "500000000000001")), key("cap"));
  assert.equal(result.status, 403);
  assert.equal((result.body as { code: string }).code, "policy_rejected");
  // The reason travels with the code, so the app can say what was wrong
  // instead of "policy_rejected" alone.
  assert.equal((result.body as { reason?: string }).reason, "trade_value_exceeded");
  assert.equal(chain.submissions.length, 0, "nothing was submitted");
});

test("an unknown account is rejected per-account while the rest are sponsored", async () => {
  const { router, service, chain } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const result = await router.handle(
    await signed(service, "buy", buyBody(campaign, [owner(1), owner(99)])), key("mixed"));
  assert.equal(result.status, 200);
  const body = result.body as { results: { account: string; status: string }[] };
  assert.equal(body.results.find((r) => r.account === owner(1))?.status, "sponsored");
  assert.equal(body.results.find((r) => r.account === owner(99))?.status, "rejected");
  assert.equal(chain.submissions.length, 1);
});

test("a paused campaign sponsors nothing", async () => {
  const { router, service, chain } = makeRouter();
  const campaign = await activeCampaign(router, service);
  await router.handle(await signed(service, "pause", { campaign }), key("pause"));
  const result = await router.handle(await signed(service, "buy", buyBody(campaign, [owner(1)])), key("buyp"));
  assert.equal(result.status, 403);
  assert.equal(chain.submissions.length, 0);
});

test("a submit failure rolls the reservation back and charges nothing", async () => {
  const { router, service, chain } = makeRouter();
  const campaign = await activeCampaign(router, service);
  chain.failFor.add(owner(1).toLowerCase());
  const result = await router.handle(await signed(service, "buy", buyBody(campaign, [owner(1)])), key("fail"));
  const body = result.body as { results: { status: string; budget: { spent: string; reserved: string } }[] };
  assert.equal(body.results[0]!.status, "rejected");
  assert.equal(body.results[0]!.budget.spent, "0");
  assert.equal(body.results[0]!.budget.reserved, "0");
});

test("a replayed buy returns the original result without submitting again", async () => {
  const { router, service, chain } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const body = buyBody(campaign, [owner(1)]);
  const first = await router.handle(await signed(service, "buy", body), key("replay"));
  const again = await router.handle(await signed(service, "buy", body), key("replay"));
  assert.deepEqual(again.body, first.body);
  assert.equal(chain.submissions.length, 1);
});

test("the campaign depletes when the remaining budget cannot fund another request", async () => {
  // Fund exactly one reservation: after that op commits, the remainder is
  // below perAccountGas and the campaign must become Depleted (FR edge case).
  const { router, service, chain } = makeRouter("200000000000000");
  const campaign = await activeCampaign(router, service);

  const first = await router.handle(await signed(service, "buy", buyBody(campaign, [owner(1)])), key("b1"));
  assert.equal((first.body as { results: { status: string }[] }).results[0]!.status, "sponsored");

  const read = await router.handle(await signed(service, "read", { campaign }));
  assert.equal((read.body as { state: string }).state, "Depleted");

  const second = await router.handle(await signed(service, "buy", buyBody(campaign, [owner(2)])), key("b2"));
  assert.equal(second.status, 403, "a depleted campaign sponsors nothing");
  assert.equal(chain.submissions.length, 1);
});

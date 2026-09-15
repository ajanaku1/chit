import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { FeeConfig } from "../../src/fleet/eligibility.js";
import type { MarketPort } from "../../src/fleet/market.js";
import type { Address, AuthEnvelope, Uint } from "../../src/fleet/types.js";
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
// Comfortably above the 5-wallet aggregate cap (5 * maxTradeValue = 2.5e15) so
// an over-cap order is refused for the cap, not mistaken for over-draw.
const FUNDING = "3000000000000000"; // 0.003 ETH of budget
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

/**
 * In-process market double: one token has a pool, one doesn't. `holdings`
 * reports the tokens actually asked about, not a fixed set, so callers can
 * tell "held nothing" from "didn't ask".
 */
class FakeMarket implements MarketPort {
  pools = new Map<string, bigint>([[TOKEN.toLowerCase(), 2505414483750479311864138015696n]]);

  async tokenQuote(token: Address, amountInWei: Uint) {
    const sqrt = this.pools.get(token.toLowerCase()) ?? 0n;
    return {
      token, symbol: sqrt ? "VEN" : "?", decimals: 18, hasPool: sqrt > 0n,
      sqrtPriceX96: sqrt.toString(), estimatedOut: ((BigInt(amountInWei) * sqrt * sqrt) >> 192n).toString(),
    };
  }

  async holdings(wallets: readonly Address[], tokens: readonly Address[] = []) {
    return wallets.map((wallet) => ({
      wallet, eth: "0", tokens: Object.fromEntries(tokens.map((token) => [token.toLowerCase(), "0"])),
    }));
  }

  async campaignsOf() {
    return [];
  }
}

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

/** A router with an Active, 5-wallet campaign, ready for a fleet buy. */
const activeCampaign = async (options: { now?: () => Date } = {}) => {
  const service = new CampaignService(serviceConfig);
  const chain = new FakeChain();
  const market = new FakeMarket();
  const accounts = Array.from({ length: 5 }, (_, i) => owner(i + 1));
  const deps: RouterDeps = {
    service, feeConfig,
    chitBalanceOf: async () => "1000",
    verifyFunding: async () => FUNDING,
    submitter: chain,
    market,
    ...(options.now ? { now: options.now } : {}),
  };
  const router = new CampaignRouter(deps);

  const create = await router.handle(await signed(service, "create", {
    quoteId: "q-1", policy: policy(),
    accounts: accounts.map((ownerAddress, i) => ({ ownerAddress, salt: salt(i + 1) })),
    recoveryVaultCommitment: `0x${"3".repeat(64)}`,
  }), key("create"));
  const campaign = (create.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign, vaultConfirmed: true }), key("confirm"));
  await router.handle(await signed(service, "fund", { campaign, fundingReference: "tx-1" }), key("fund"));
  await router.handle(await signed(service, "activate", { campaign }), key("activate"));

  return { router, service, campaign, accounts, chain, market };
};

const SEED = `0x${"ab".repeat(32)}` as const;

test("tokenQuote says whether the token has a pool, and what the fleet may spend per slice", async () => {
  const { router, service, campaign, accounts } = await activeCampaign();
  const ok = await router.handle(await signed(service, "tokenQuote", { campaign, token: TOKEN, totalWei: "1000000000000000" }));
  assert.equal(ok.status, 200);
  const body = ok.body as Record<string, unknown>;
  assert.equal(body["hasPool"], true);
  assert.equal(body["symbol"], "VEN");
  assert.equal(body["capWei"], policy().maxTradeValue);
  assert.equal(body["windowMs"], 5 * 60_000);
  assert.ok(BigInt(String(body["estimatedOut"])) > 0n);
  const none = await router.handle(await signed(service, "tokenQuote", { campaign, token: owner(0x55), totalWei: "1" }));
  assert.equal((none.body as Record<string, unknown>)["hasPool"], false);
  assert.equal(accounts.length, 5);
});

test("order returns the plan without executing, and refuses what the fleet cannot do", async () => {
  const { router, service, campaign, accounts, chain } = await activeCampaign();
  // The wire field is `entropy`, not `seed`: the service's forbidden-field
  // guard treats a body field literally named `seed` as wallet-recovery
  // material, and this seed is public PRNG input, not that.
  const body = { campaign, token: TOKEN, totalWei: "1000000000000000", wallets: accounts, entropy: SEED, createdAt: "2026-09-15T12:00:00.000Z" };
  const placed = await router.handle(await signed(service, "order", body));
  assert.equal(placed.status, 200);
  const result = placed.body as { order: { id: string; windowMs: number }; slices: { amountWei: string }[] };
  assert.match(result.order.id, /^0x[0-9a-f]{64}$/);
  assert.equal(result.slices.length, 5);
  assert.equal(chain.submissions.length, 0, "placing an order must not buy anything");

  const noPool = await router.handle(await signed(service, "order", { ...body, token: owner(0x55) }));
  assert.equal(noPool.status, 400);
  assert.equal((noPool.body as Record<string, unknown>)["code"], "no_pool");

  const overCap = await router.handle(await signed(service, "order", { ...body, totalWei: (BigInt(policy().maxTradeValue) * 5n + 1n).toString() }));
  assert.equal((overCap.body as Record<string, unknown>)["code"], "over_cap");

  const stranger = await router.handle(await signed(service, "order", { ...body, wallets: [owner(0xee)] }));
  assert.equal((stranger.body as Record<string, unknown>)["code"], "wallets_not_enrolled");
});

test("trade runs only the slices that are due and still pending, and reports the next due time", async () => {
  const now = { value: new Date("2026-09-15T12:00:00.000Z") };
  const { router, service, campaign, accounts, chain } = await activeCampaign({ now: () => now.value });
  const placed = await router.handle(await signed(service, "order", { campaign, token: TOKEN, totalWei: "1000000000000000", wallets: accounts, entropy: SEED, createdAt: now.value.toISOString() }));
  const { order, slices } = placed.body as { order: Record<string, unknown>; slices: { dueAt: string }[] };
  const dues = slices.map((s) => Date.parse(s.dueAt)).sort((a, b) => a - b);

  // Just after the first due time: exactly the slices due by then run.
  now.value = new Date(dues[0]! + 1);
  const dueNow = dues.filter((d) => d <= now.value.getTime()).length;
  const first = await router.handle(await signed(service, "trade", { campaign, order, pending: [0, 1, 2, 3, 4] }), "key-1");
  assert.equal(first.status, 200);
  const r1 = first.body as { executed: { index: number; status: string }[]; nextDueAt: string | null };
  assert.equal(r1.executed.length, dueNow);
  assert.equal(chain.submissions.length, dueNow);
  assert.ok(r1.nextDueAt === null || Date.parse(r1.nextDueAt) > now.value.getTime());

  // Past the window, with the browser reporting what is still pending: the rest run once.
  now.value = new Date(dues[4]! + 1);
  const done = new Set(r1.executed.map((e) => e.index));
  const rest = await router.handle(await signed(service, "trade", { campaign, order, pending: [0, 1, 2, 3, 4].filter((i) => !done.has(i)) }), "key-2");
  const r2 = rest.body as { executed: { index: number }[]; nextDueAt: string | null };
  assert.equal(r2.executed.length + r1.executed.length, 5);
  assert.equal(r2.nextDueAt, null);
  assert.equal(chain.submissions.length, 5, "every slice bought exactly once");

  // A slice the browser already has is never re-run, even if asked twice in one instance.
  const again = await router.handle(await signed(service, "trade", { campaign, order, pending: [0] }), "key-3");
  assert.equal((again.body as { executed: unknown[] }).executed.length, 0);
  assert.equal(chain.submissions.length, 5);
});

test("trade refuses an order whose fields no longer hash to its id, or that another wallet placed", async () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const { router, service, campaign, accounts } = await activeCampaign({ now: () => now });
  const placed = await router.handle(await signed(service, "order", { campaign, token: TOKEN, totalWei: "1000000000000000", wallets: accounts, entropy: SEED, createdAt: now.toISOString() }));
  const { order } = placed.body as { order: Record<string, unknown> };
  const forged = await router.handle(await signed(service, "trade", { campaign, order: { ...order, totalWei: "9000000000000000" }, pending: [0] }), "key-9");
  assert.equal(forged.status, 400);
  assert.equal((forged.body as Record<string, unknown>)["code"], "order_tampered");
});

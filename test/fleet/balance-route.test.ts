import assert from "node:assert/strict";
import test from "node:test";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { BalanceView, PoolPort } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * The balance route is where a trader's money is visible and leaves. It must
 * refuse more than they have, never offer a deposit the contract would reject,
 * and warn when a destination undoes the privacy they deposited for.
 */

const trader = privateKeyToAccount(`0x${"31".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const fresh = "0x00000000000000000000000000000000000f3e58" as Address;
const POOL = "0x0000000000000000000000000000000000000901" as Address;

const view = (over: Partial<BalanceView> = {}): BalanceView => ({
  available: parseEther("0.06").toString(),
  deposited: parseEther("0.1").toString(),
  spent: parseEther("0.02").toString(),
  openDraws: parseEther("0.02").toString(),
  headroom: {
    sizes: [parseEther("0.01").toString(), parseEther("0.05").toString()],
    perTraderRemaining: parseEther("0.4").toString(),
    poolRemaining: parseEther("4.9").toString(),
  },
  exit: {},
  pool: { paused: false },
  poolAddress: POOL,
  ...over,
});

const makeRouter = (over: Partial<BalanceView> = {}) => {
  const calls: { amount: string; destination: string }[] = [];
  const service = new CampaignService(serviceConfig);
  const pool: PoolPort = {
    balance: async () => view(over),
    withdraw: async ({ amount, destination }) => {
      calls.push({ amount, destination });
      return { payoutTx: `0x${"a".repeat(64)}` as Hex, queuedSpendTx: `0x${"b".repeat(64)}` as Hex };
    },
  };
  const deps: RouterDeps = { service, pool };
  return { router: new CampaignRouter(deps), service, calls };
};

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const fields = {
    primaryWallet: trader.address, nonce: c.nonce, issuedAt: c.issuedAt,
    expiresAt: c.expiresAt, action, payloadHash: hash,
  };
  const auth: AuthEnvelope = {
    ...fields,
    signature: await trader.signMessage({ message: challengeBytes(serviceConfig, fields) }),
  };
  return { action, auth, body };
};

const key = (suffix: string) => `fleet-${suffix.padEnd(16, "0")}`;

test("balance reports what the trader holds, what is committed, and what may still be deposited", async () => {
  const { router, service } = makeRouter();
  const result = await router.handle(await signed(service, "balance", {}));
  assert.equal(result.status, 200);
  const body = result.body as BalanceView;
  assert.equal(body.available, parseEther("0.06").toString());
  assert.equal(body.openDraws, parseEther("0.02").toString());
  assert.deepEqual(body.headroom.sizes, [parseEther("0.01").toString(), parseEther("0.05").toString()]);
  assert.equal(body.pool.paused, false);
});

test("balance needs no idempotency key, because reading changes nothing", async () => {
  const { router, service } = makeRouter();
  const result = await router.handle(await signed(service, "balance", {}));
  assert.equal(result.status, 200);
});

test("balance refuses an unsigned request", async () => {
  const { router } = makeRouter();
  const result = await router.handle({ action: "balance", body: {} });
  assert.equal(result.status, 401);
});

test("a withdrawal within the balance is paid and reports both transactions", async () => {
  const { router, service, calls } = makeRouter();
  const body = { amount: parseEther("0.03").toString(), destination: fresh };
  const result = await router.handle(await signed(service, "withdraw", body), key("withdraw1"));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const paid = result.body as { payoutTx: string; queuedSpendTx: string; warning?: string };
  assert.match(paid.payoutTx, /^0xa+$/);
  assert.match(paid.queuedSpendTx, /^0xb+$/);
  assert.equal(paid.warning, undefined);
  assert.deepEqual(calls, [{ amount: parseEther("0.03").toString(), destination: fresh }]);
});

test("a withdrawal beyond the balance is refused before any payout", async () => {
  const { router, service, calls } = makeRouter();
  const body = { amount: parseEther("0.07").toString(), destination: fresh };
  const result = await router.handle(await signed(service, "withdraw", body), key("withdraw2"));
  assert.equal(result.status, 422);
  assert.equal((result.body as { code: string }).code, "budget_exceeded");
  assert.deepEqual(calls, [], "nothing was paid");
});

test("a withdrawal to the depositing wallet is paid, with the warning that it undoes the privacy", async () => {
  const { router, service } = makeRouter();
  const body = { amount: parseEther("0.01").toString(), destination: trader.address };
  const result = await router.handle(await signed(service, "withdraw", body), key("withdraw3"));
  assert.equal(result.status, 200);
  assert.equal((result.body as { warning?: string }).warning, "destination_is_primary");
});

test("a malformed amount or destination is refused", async () => {
  for (const body of [
    { amount: "0", destination: fresh },
    { amount: "-1", destination: fresh },
    { amount: parseEther("0.01").toString(), destination: "not-an-address" },
    { amount: "abc", destination: fresh },
  ]) {
    const { router, service } = makeRouter();
    const result = await router.handle(await signed(service, "withdraw", body), key("withdraw4"));
    assert.ok(result.status >= 400 && result.status < 500, `${JSON.stringify(body)} -> ${result.status}`);
  }
});

test("a paused pool refuses withdrawals and says so", async () => {
  const { router, service, calls } = makeRouter({ pool: { paused: true } });
  const body = { amount: parseEther("0.01").toString(), destination: fresh };
  const result = await router.handle(await signed(service, "withdraw", body), key("withdraw5"));
  assert.equal(result.status, 409);
  assert.deepEqual(calls, []);
});

test("without a pool configured the route answers 503 rather than inventing a balance", async () => {
  const service = new CampaignService(serviceConfig);
  const router = new CampaignRouter({ service });
  const result = await router.handle(await signed(service, "balance", {}));
  assert.equal(result.status, 503);
});

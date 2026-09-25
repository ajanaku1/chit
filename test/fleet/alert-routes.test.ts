import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Alert, AlertSink } from "../../src/fleet/alerts.js";
import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { WithdrawalRefused, type BalanceView, type PoolPort, type SweepReport } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * The two failures an outside reader cannot see (T049).
 *
 * The monitor watches the chain, so it sees a charge ageing and the operator's
 * balance. It cannot see a sweep that threw, because a sweep that threw wrote
 * nothing, and it cannot see a withdrawal that was refused, because a refusal
 * leaves no trace on chain at all. Both are raised here, where they happen.
 */

const trader = privateKeyToAccount(`0x${"31".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const fresh = "0x00000000000000000000000000000000000f3e58" as Address;

const view = (): BalanceView => ({
  available: parseEther("0.06").toString(),
  deposited: parseEther("0.1").toString(),
  spent: "0",
  openDraws: "0",
  headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" },
  exit: {},
  pool: { paused: false },
  poolAddress: `0x${"90".repeat(20)}` as Address,
});

const sink = () => {
  const raised: Alert[] = [];
  let flushed = 0;
  const alerts: AlertSink = {
    raise: async (alert) => { raised.push(alert); },
    flushDaily: async () => { flushed += 1; },
  };
  return { raised, alerts, flushes: () => flushed };
};

const makeRouter = (over: { withdraw?: PoolPort["withdraw"]; sweep?: PoolPort["sweep"]; now?: () => Date } = {}) => {
  const unused = () => { throw new Error("not part of this journey"); };
  const service = new CampaignService(serviceConfig);
  const pool: PoolPort = {
    balance: async () => view(),
    withdraw: over.withdraw ?? (async () => ({ payoutTx: `0x${"a".repeat(64)}` as Hex, chargeId: "owed-1" })),
    sweep: over.sweep ?? (async () => ({ funded: [], posted: [] })),
    openDraw: unused, topUpDraw: unused, closeDraw: async () => undefined,
    drawOf: async () => undefined, ownerOf: async () => undefined, buy: unused,
  };
  const spy = sink();
  const deps: RouterDeps = { service, pool, alerts: spy.alerts, ...(over.now ? { now: over.now } : {}) };
  return { router: new CampaignRouter(deps), service, ...spy };
};

const key = (suffix: string) => `fleet-${suffix.padEnd(16, "0")}`;

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const fields = { primaryWallet: trader.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
  return { action, auth: { ...fields, signature: await trader.signMessage({ message: challengeBytes(serviceConfig, fields) }) } as AuthEnvelope, body };
};

describe("what the service reports that nobody outside can see", () => {
  it("a refused withdrawal is raised at once, with its reason and the money path to act", async () => {
    const { router, service, raised } = makeRouter({
      withdraw: async () => { throw new WithdrawalRefused("operator_float_short"); },
    });
    const result = await router.handle(await signed(service, "withdraw", { amount: parseEther("0.03").toString(), destination: fresh }), key("refused"));

    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(raised.length, 1, JSON.stringify(raised));
    assert.deepEqual({ ...raised[0] }, {
      what: "withdrawal-refused", acts: "money-path", timescale: "immediately",
      summary: "a withdrawal was refused: operator_float_short",
    });
    assert.ok(!JSON.stringify(raised[0]).includes(trader.address), "the depositor is not named in the chat");
    assert.ok(!JSON.stringify(raised[0]).includes(fresh), "and neither is the payee");
  });

  it("a withdrawal that is paid raises nothing", async () => {
    const { router, service, raised } = makeRouter();
    const result = await router.handle(await signed(service, "withdraw", { amount: parseEther("0.03").toString(), destination: fresh }), key("paid"));
    assert.equal(result.status, 200);
    assert.deepEqual(raised, []);
  });

  it("a sweep that threw is raised within four hours: the charges it did not queue still have their deadline", async () => {
    const { router, raised } = makeRouter({ sweep: async () => { throw new Error("HTTP request failed\n  URL: https://rpc.example\n  operator 0xdead"); } });
    const result = await router.handle({ action: "sweep", body: {} }).catch((error: unknown) => error);

    assert.ok(result instanceof Error, "the caller still sees the failure");
    assert.equal(raised.length, 1, JSON.stringify(raised));
    assert.equal(raised[0]!.what, "sweep-failed");
    assert.equal(raised[0]!.acts, "operations");
    assert.equal(raised[0]!.timescale, "four-hours");
    assert.match(raised[0]!.summary, /HTTP request failed/);
    assert.ok(!raised[0]!.summary.includes("0xdead"), "only the first line: the rest of a viem error is the request it was building");
  });

  it("postings that failed go in the day's digest, and a ledger key that cannot open a charge is said sooner", async () => {
    const report: SweepReport = {
      funded: [], posted: ["p1"],
      failed: [{ id: "q1", reason: "execution reverted" }, { id: "q2", reason: "execution reverted" }],
      unreadable: 1,
    };
    const { router, raised, flushes } = makeRouter({ sweep: async () => report });
    const result = await router.handle({ action: "sweep", body: {} });

    assert.equal(result.status, 200);
    const daily = raised.filter((a) => a.timescale === "daily");
    assert.equal(daily.length, 1, JSON.stringify(raised));
    assert.equal(daily[0]!.what, "postings-failed");
    assert.match(daily[0]!.summary, /2 posting/);
    const sooner = raised.filter((a) => a.what === "charges-unreadable");
    assert.equal(sooner.length, 1);
    assert.equal(sooner[0]!.timescale, "four-hours");
    assert.equal(sooner[0]!.acts, "money-path");
    assert.equal(flushes(), 1, "every scheduled sweep offers to send the day's digest");
  });

  it("a charge unposted for over four hours is raised on the clock that ticks, once per charge per window", async () => {
    // SC-010's four-hour promise used to rest on the outside monitor, which
    // GitHub schedules hourly and runs every 4.7 hours in the median. The
    // posting sweep runs every two hours on Vercel's clock, so the promise
    // rests here now; the monitor still says it too when it runs.
    let clock = new Date("2026-09-24T09:00:00Z");
    const report: SweepReport = { funded: [], posted: [], ageing: [{ id: "q1", ageSeconds: 5 * 3_600 }] };
    const { router, raised } = makeRouter({ sweep: async () => report, now: () => clock });

    await router.handle({ action: "sweep", body: {} });
    assert.equal(raised.length, 1, JSON.stringify(raised));
    assert.equal(raised[0]!.what, "charge-ageing");
    assert.equal(raised[0]!.timescale, "four-hours");
    assert.equal(raised[0]!.acts, "money-path");
    assert.match(raised[0]!.summary, /1 charge .*5h/);

    clock = new Date("2026-09-24T11:00:00Z");
    await router.handle({ action: "sweep", body: {} });
    assert.equal(raised.length, 1, "the next sweep two hours later says nothing new about the same charge");

    clock = new Date("2026-09-24T14:00:00Z");
    await router.handle({ action: "sweep", body: {} });
    assert.equal(raised.length, 2, "still unposted a window later, so it is said again");
  });

  it("a charge close to its deadline is raised at once, because after the deadline nobody can be charged at all", async () => {
    const report: SweepReport = { funded: [], posted: [], ageing: [{ id: "q9", ageSeconds: 11 * 3_600 }] };
    const { router, raised } = makeRouter({ sweep: async () => report });
    await router.handle({ action: "sweep", body: {} });

    assert.equal(raised.length, 1, JSON.stringify(raised));
    assert.equal(raised[0]!.what, "charge-at-risk");
    assert.equal(raised[0]!.timescale, "immediately");
    assert.equal(raised[0]!.acts, "both", "it is one of the pause triggers");
  });

  it("a sweep with nothing wrong raises nothing, and still offers the digest", async () => {
    const { router, raised, flushes } = makeRouter();
    await router.handle({ action: "sweep", body: {} });
    assert.deepEqual(raised, []);
    assert.equal(flushes(), 1);
  });
});

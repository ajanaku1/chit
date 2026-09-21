import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";

import { ACTS, alertText, assess, digestText, type Expected, type Finding, type PoolSnapshot, type QueuedCharge } from "../../src/fleet/monitor.js";

/**
 * What the outside monitor concludes from one snapshot of public chain state.
 * Pure: a snapshot and what the deployment record expects go in, findings come
 * out. Every threshold is tested on both sides of its edge.
 */

const ETH = 10n ** 18n;
const T = 1_790_000_000n;
const WINDOW = 43_200n;
const POOL = "0xb29139f3119d490eae473ba29fe8deadfb2c5ca5" as Address;
const OPERATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" as Address;
const ADMIN = "0xCb70EfEfC73f241047262d4FACe6D21d052F6946" as Address;
const GUARDIAN = "0x00000000000000000000000000000000000000aa" as Address;
const ZERO = `0x${"0".repeat(40)}` as Address;
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const charge = (n: number, age: bigint, posted = false, amount = 1_000n): QueuedCharge =>
  ({ id: id(n), amount, dueAt: T - age + 90n, queuedAt: T - age, posted });

const healthy = (over: Partial<PoolSnapshot> = {}): PoolSnapshot => ({
  block: 100n, chainTime: T, pool: POOL,
  balance: 61n * ETH / 1000n, totalDeposited: 70n * ETH / 1000n, totalOutflow: 9n * ETH / 1000n, totalClaimed: 0n,
  postWindow: WINDOW, paused: false, operator: OPERATOR, admin: ADMIN, guardian: ZERO, operatorBalance: ETH / 4n,
  queue: [charge(1, 90_000n, true), charge(2, 600n)],
  draws: [{ campaign: id(7), state: 2, dueAt: T - 5_000n, reserved: 0n }, { campaign: id(8), state: 3, dueAt: T - 9_000n, reserved: 0n }],
  ...over,
});

const expected: Expected = { pool: POOL, operator: OPERATOR, admin: ADMIN };
const run = (snapshot: PoolSnapshot, more: Partial<Parameters<typeof assess>[2]> = {}, expect: Expected = expected): Finding[] =>
  assess(snapshot, expect, { wallClock: T + 5n, ...more });
const checks = (findings: Finding[]): string[] => findings.map((f) => `${f.severity}:${f.check}`);

describe("the outside monitor's findings", () => {
  it("has nothing to say about a healthy pool", () => {
    assert.deepEqual(run(healthy()), []);
  });

  it("holds the pool's balance against what its counters allow", () => {
    const bound = 61n * ETH / 1000n;
    assert.deepEqual(checks(run(healthy({ balance: bound - 1n }))), ["critical:accounting"], "ETH that left uncounted");
    // An exit with spend posted leaves more behind than the bound: normal, and not a finding.
    assert.deepEqual(run(healthy({ balance: bound + 5n })), []);

    const counters = { everDeposited: 90n * ETH / 1000n, exitsPaid: 15n * ETH / 1000n, donated: 0n };
    const exact = 90n * ETH / 1000n - 15n * ETH / 1000n - 9n * ETH / 1000n;
    assert.deepEqual(run(healthy({ counters, balance: exact })), []);
    assert.deepEqual(checks(run(healthy({ counters, balance: exact - 1n }))), ["critical:accounting"]);
    assert.deepEqual(checks(run(healthy({ counters, balance: exact + 1n }))), ["warn:accounting"], "with counters the identity is exact, so a surplus is said too");
    assert.deepEqual(run(healthy({ counters: { ...counters, donated: 7n }, balance: exact + 7n })), []);
  });

  it("says a charge is ageing after four hours, at risk at five sixths of its window, and lost one second after", () => {
    const at = (age: bigint): string[] => checks(run(healthy({ queue: [charge(1, age)] })));
    // Four hours is two posting runs missed (the posting clock is every two hours), whatever the window is.
    assert.deepEqual(at(4n * 3_600n - 1n), []);
    assert.deepEqual(at(4n * 3_600n), ["warn:charge-ageing"]);
    assert.deepEqual(checks(run(healthy({ queue: [charge(1, 3_600n)] }), { thresholds: { chargeAgeingSeconds: 3_600n } })), ["warn:charge-ageing"]);
    assert.deepEqual(at((WINDOW * 5n) / 6n - 1n), ["warn:charge-ageing"]);
    assert.deepEqual(at((WINDOW * 5n) / 6n), ["critical:charge-at-risk"]);
    assert.deepEqual(at(WINDOW), ["critical:charge-at-risk"], "the contract still accepts a posting at the last second");
    assert.deepEqual(at(WINDOW + 1n), ["critical:charge-expired"]);
    assert.deepEqual(checks(run(healthy({ queue: [charge(1, WINDOW * 9n, true)] }))), [], "a posted charge is never a finding");
  });

  it("adds up what expired, and leaves out what has been made whole and written down", () => {
    const queue = [charge(1, WINDOW + 10n, false, 3_000n), charge(2, WINDOW + 20n, false, 4_000n), charge(3, WINDOW * 3n, false, 5_000n)];
    const [all] = run(healthy({ queue }));
    assert.match(all?.summary ?? "", /3 charges/);
    assert.match(all?.summary ?? "", /0\.000000000000012 ETH/);
    const [rest] = run(healthy({ queue }), { acknowledged: [id(3).toUpperCase().replace("0X", "0x") as Hex] });
    assert.match(rest?.summary ?? "", /2 charges/);
    assert.deepEqual(run(healthy({ queue }), { acknowledged: [id(1), id(2), id(3)] }), []);
  });

  it("watches the operator's balance against two thresholds", () => {
    assert.deepEqual(checks(run(healthy({ operatorBalance: ETH / 20n }))), []);
    assert.deepEqual(checks(run(healthy({ operatorBalance: ETH / 20n - 1n }))), ["warn:operator-balance"]);
    assert.deepEqual(checks(run(healthy({ operatorBalance: ETH / 100n - 1n }))), ["critical:operator-balance"]);
    assert.deepEqual(checks(run(healthy(), { thresholds: { operatorWarn: ETH, operatorCritical: ETH / 2n } })), ["critical:operator-balance"]);
  });

  it("notices work the sweep owes: a fleet not funded an hour after it was due, a reservation left open", () => {
    const pending = (late: bigint) => healthy({ draws: [{ campaign: id(9), state: 1, dueAt: T - late, reserved: 0n }] });
    assert.deepEqual(checks(run(pending(3_599n))), []);
    assert.deepEqual(checks(run(pending(3_600n))), ["warn:draw-overdue"]);
    assert.deepEqual(checks(run(healthy({ draws: [{ campaign: id(9), state: 2, dueAt: T - 50n, reserved: 5n }] }))), ["warn:reservation-open"]);
  });

  it("says when the pool is paused, and when the chain it read is not moving", () => {
    assert.deepEqual(checks(run(healthy({ paused: true }))), ["warn:paused"]);
    assert.deepEqual(checks(run(healthy(), { wallClock: T + 900n })), []);
    assert.deepEqual(checks(run(healthy(), { wallClock: T + 901n })), ["warn:chain-stale"]);
  });

  it("compares the roles on chain with the deployment record, where the record names them", () => {
    assert.deepEqual(checks(run(healthy({ operator: OPERATOR.toLowerCase() as Address }))), [], "case is not a difference");
    assert.deepEqual(checks(run(healthy({ operator: GUARDIAN }))), ["critical:roles"]);
    assert.deepEqual(checks(run(healthy({ admin: GUARDIAN }))), ["critical:roles"]);
    assert.deepEqual(checks(run(healthy(), {}, { pool: POOL })), [], "a record that names no role expects none");
    assert.deepEqual(checks(run(healthy(), {}, { ...expected, guardian: GUARDIAN })), ["critical:roles"], "a guardian the record expects, and the chain does not have");
    assert.deepEqual(checks(run(healthy({ guardian: GUARDIAN }), {}, { ...expected, guardian: GUARDIAN })), []);
  });

  it("checks that the hosted service answers, and answers for the recorded pool", () => {
    assert.deepEqual(checks(run(healthy(), { site: { ok: true, poolAddress: POOL.toUpperCase().replace("0X", "0x") } })), []);
    assert.deepEqual(checks(run(healthy(), { site: { ok: false, reason: "503" } })), ["critical:site-down"]);
    assert.deepEqual(checks(run(healthy(), { site: { ok: true, poolAddress: OPERATOR } })), ["critical:site-pool"]);
    assert.deepEqual(checks(run(healthy(), { site: { ok: true } })), ["critical:site-pool"], "a service that names no pool has none configured");
  });

  it("puts what is critical first, and keeps ids and keys out of what it sends", () => {
    const findings = run(healthy({ paused: true, queue: [charge(1, WINDOW + 1n), charge(2, WINDOW / 2n)], balance: 1n }));
    assert.match(alertText(findings, { chainId: 46630, block: 100n }), /^CRITICAL accounting \(both\): /m, "every line says who is expected to act");
    assert.deepEqual(checks(findings), ["critical:accounting", "critical:charge-expired", "warn:charge-ageing", "warn:paused"]);
    assert.ok(findings.some((f) => f.detail?.some((line) => line.includes(id(1)))), "the log can name the charge: its id is public");
    const text = alertText(findings, { chainId: 46630, block: 100n });
    assert.doesNotMatch(text, /0x[0-9a-f]{64}/i, "the alert is aggregate: counts, totals and ages");
    assert.match(text, /46630/);
    assert.equal(text.split("\n").filter((line) => /^(CRITICAL|warn)/.test(line)).length, 4);
    assert.equal(alertText([], { chainId: 46630, block: 100n }), "");
  });

  it("names who is expected to act on every finding it can make", () => {
    // Settled on 21 September: one chat, split by who acts. Roles here, names in the readiness evidence.
    assert.deepEqual(ACTS, {
      "accounting": "both", "charge-expired": "both", "charge-at-risk": "both", "roles": "both", "site-pool": "both", "paused": "both",
      "charge-ageing": "money-path", "operator-balance": "money-path", "reservation-open": "money-path",
      "site-down": "operations", "draw-overdue": "operations", "chain-stale": "operations", "monitor-blind": "operations",
    });
    const all = run(
      healthy({ balance: 1n, paused: true, operator: GUARDIAN, operatorBalance: 1n, queue: [charge(1, WINDOW + 1n), charge(2, WINDOW - 5n), charge(3, WINDOW / 2n)],
        draws: [{ campaign: id(9), state: 1, dueAt: T - 4_000n, reserved: 0n }, { campaign: id(10), state: 2, dueAt: T, reserved: 5n }] }),
      { wallClock: T + 5_000n, site: { ok: true, poolAddress: OPERATOR } },
    );
    assert.deepEqual([...new Set(all.map((f) => f.check))].sort(), Object.keys(ACTS).filter((check) => !["site-down", "monitor-blind"].includes(check)).sort());
    for (const finding of all) assert.equal(finding.acts, ACTS[finding.check], finding.check);
  });

  it("writes a daily digest that shows it is alive: aggregates, and the findings if there are any", () => {
    const quiet = digestText(healthy(), [], { chainId: 46630, block: 100n });
    assert.match(quiet, /daily digest · chain 46630 · block 100/);
    assert.match(quiet, /pool 0\.061 ETH/);
    assert.match(quiet, /2 charges, 1 unposted, the oldest 10 min old/);
    assert.match(quiet, /2 draws/);
    assert.match(quiet, /operator 0\.25 ETH/);
    assert.match(digestText(healthy({ operatorBalance: 248_685_572_669_137_600n }), [], { chainId: 46630, block: 100n }), /operator 0\.2486 ETH ·/, "four decimals in a digest; findings keep the exact figure");
    assert.match(quiet, /nothing to report/);
    assert.doesNotMatch(quiet, /0x[0-9a-f]{40}/i, "aggregates only: no id, no key, no address");

    const findings = run(healthy({ paused: true }));
    const loud = digestText(healthy({ paused: true }), findings, { chainId: 46630, block: 100n });
    assert.match(loud, /^warn paused \(both\): /m);
    assert.doesNotMatch(loud, /nothing to report/);
  });
});

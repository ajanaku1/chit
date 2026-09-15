import assert from "node:assert/strict";
import test from "node:test";

import { orderId, PlanError, planSlices, windowFor, type Order } from "../../src/fleet/order-plan.js";

const wallet = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const base: Omit<Order, "id"> = {
  campaign: "c-1",
  token: wallet(0x77),
  totalWei: "5000000000000000", // 0.005 ETH
  wallets: [1, 2, 3, 4, 5].map(wallet),
  seed: `0x${"ab".repeat(32)}`,
  windowMs: 5 * 60_000,
  createdAt: "2026-09-15T12:00:00.000Z",
  owner: wallet(0x99),
};
const CAP = "2000000000000000"; // 0.002 ETH per slice

test("slices sum to the total, one per wallet, each within the cap", () => {
  const slices = planSlices(base, CAP);
  assert.equal(slices.length, 5);
  assert.deepEqual(slices.map((s) => s.wallet), base.wallets);
  assert.equal(slices.reduce((sum, s) => sum + BigInt(s.amountWei), 0n).toString(), base.totalWei);
  for (const s of slices) assert.ok(BigInt(s.amountWei) <= BigInt(CAP), `slice ${s.index} over the cap`);
});

test("sizes vary around the average but never by more than 35%", () => {
  const average = BigInt(base.totalWei) / 5n;
  const sizes = planSlices(base, CAP).map((s) => BigInt(s.amountWei));
  assert.ok(new Set(sizes.map(String)).size > 1, "every slice is the same size");
  for (const size of sizes) {
    const diff = size > average ? size - average : average - size;
    assert.ok(diff * 100n <= average * 36n, `a slice drifts ${diff} from the average ${average}`);
  }
});

test("due times fall inside the window, in order", () => {
  const start = Date.parse(base.createdAt);
  const dues = planSlices(base, CAP).map((s) => Date.parse(s.dueAt));
  for (const due of dues) assert.ok(due >= start && due <= start + base.windowMs);
  assert.deepEqual(dues, [...dues].sort((a, b) => a - b));
});

test("the same order always plans the same slices; a different seed differs", () => {
  assert.deepEqual(planSlices(base, CAP), planSlices(base, CAP));
  const other = planSlices({ ...base, seed: `0x${"cd".repeat(32)}` }, CAP);
  assert.notDeepEqual(other.map((s) => s.amountWei), planSlices(base, CAP).map((s) => s.amountWei));
});

test("a total the cap cannot hold is refused, not silently shrunk", () => {
  assert.throws(() => planSlices({ ...base, totalWei: "20000000000000000" }, CAP), (e: unknown) => e instanceof PlanError && e.code === "over_cap");
  assert.throws(() => planSlices({ ...base, wallets: [] }, CAP), (e: unknown) => e instanceof PlanError && e.code === "no_wallets");
  assert.throws(() => planSlices({ ...base, totalWei: "0" }, CAP), (e: unknown) => e instanceof PlanError && e.code === "zero_total");
});

test("the window grows with the fleet, from five minutes to thirty", () => {
  assert.equal(windowFor(5), 5 * 60_000);
  assert.equal(windowFor(50), 30 * 60_000);
  assert.equal(windowFor(1), 5 * 60_000);
  assert.equal(windowFor(500), 30 * 60_000);
  assert.ok(windowFor(27) > 5 * 60_000 && windowFor(27) < 30 * 60_000);
});

test("the order id is a keccak of its fields, so a changed field is a different order", () => {
  const id = orderId(base);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.equal(orderId(base), id);
  assert.notEqual(orderId({ ...base, totalWei: "5000000000000001" }), id);
});

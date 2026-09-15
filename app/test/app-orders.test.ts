import assert from "node:assert/strict";
import test from "node:test";

import { applyResults, createOrderStore, markSent, markUnconfirmed, MAX_ATTEMPTS, pendingIndices, progress, reconcile, type OrderRecord } from "../src/fleet/orders.js";

const wallet = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const record = (): OrderRecord => ({
  order: {
    id: `0x${"aa".repeat(32)}`, campaign: "c-1", token: wallet(0x77), totalWei: "3000", wallets: [1, 2, 3].map(wallet),
    entropy: `0x${"ab".repeat(32)}`, windowMs: 300_000, createdAt: "2026-09-15T12:00:00.000Z", owner: wallet(0x99),
  },
  symbol: "FLEET",
  cancelled: false,
  placedAt: "2026-09-15T12:00:00.000Z",
  slices: [
    { index: 0, wallet: wallet(1), amountWei: "1000", dueAt: "2026-09-15T12:01:00.000Z", state: "pending", attempts: 0 },
    { index: 1, wallet: wallet(2), amountWei: "1200", dueAt: "2026-09-15T12:03:00.000Z", state: "pending", attempts: 0 },
    { index: 2, wallet: wallet(3), amountWei: "800", dueAt: "2026-09-15T12:05:00.000Z", state: "pending", attempts: 0 },
  ],
});

class MemoryStorage implements Storage {
  #m = new Map<string, string>();
  get length(): number { return this.#m.size; }
  clear(): void { this.#m.clear(); }
  getItem(k: string): string | null { return this.#m.get(k) ?? null; }
  key(i: number): string | null { return [...this.#m.keys()][i] ?? null; }
  removeItem(k: string): void { this.#m.delete(k); }
  setItem(k: string, v: string): void { this.#m.set(k, v); }
}

test("a slice is marked sent before any response, so a lost reply can never re-send it", () => {
  const sent = markSent(record(), [0, 1]);
  assert.deepEqual(sent.slices.map((s) => s.state), ["sent", "sent", "pending"]);
  assert.deepEqual(pendingIndices(sent), [2]);
  const lost = markUnconfirmed(sent, [0, 1]);
  assert.deepEqual(lost.slices.map((s) => s.state), ["unconfirmed", "unconfirmed", "pending"]);
  assert.deepEqual(pendingIndices(lost), [2], "unconfirmed slices are never pending again");
});

test("results settle sent slices; a rejected slice may retry twice, then fails", () => {
  let r = markSent(record(), [0, 1, 2]);
  r = applyResults(r, [{ index: 0, status: "sponsored", txHash: "0x01" }, { index: 1, status: "rejected", reason: "swap_reverted" }]);
  assert.equal(r.slices[0]!.state, "sponsored");
  assert.equal(r.slices[0]!.txHash, "0x01");
  assert.equal(r.slices[1]!.state, "rejected");
  assert.equal(r.slices[2]!.state, "pending", "a sent slice the service did not run (not due yet) goes back to pending");
  assert.deepEqual(pendingIndices(r), [1, 2]);
  for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) r = applyResults(markSent(r, [1]), [{ index: 1, status: "rejected" }]);
  assert.equal(r.slices[1]!.state, "failed");
  assert.deepEqual(pendingIndices(r), [2]);
});

test("reconcile settles unconfirmed slices against what the draw actually spent", () => {
  const lost = markUnconfirmed(markSent(record(), [0, 1]), [0, 1]);
  const settled = reconcile(lost, "1000");
  assert.deepEqual(settled.slices.map((s) => s.state), ["sponsored", "failed", "pending"], "only the spend that happened is credited, smallest slice first");
  assert.equal(reconcile(lost, "5000").slices.filter((s) => s.state === "sponsored").length, 2);
});

test("progress counts done slices and finds the next due pending one; a cancelled order is finished", () => {
  const r = applyResults(markSent(record(), [0]), [{ index: 0, status: "sponsored", txHash: "0x01" }]);
  assert.deepEqual(progress(r), { done: 1, total: 3, nextDueAt: "2026-09-15T12:03:00.000Z", finished: false });
  assert.equal(progress({ ...r, cancelled: true }).finished, true);
  assert.deepEqual(pendingIndices({ ...r, cancelled: true }), []);
});

test("the store keeps orders per owner and survives a reload", () => {
  const storage = new MemoryStorage();
  const store = createOrderStore(storage, wallet(0x99));
  store.add(record());
  store.update(record().order.id, (r) => markSent(r, [0]));
  assert.equal(createOrderStore(storage, wallet(0x99)).get(record().order.id)?.slices[0]?.state, "sent");
  assert.equal(createOrderStore(storage, wallet(0x98)).list().length, 0, "another owner sees nothing");
});

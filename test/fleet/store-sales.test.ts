/**
 * Sales in the store (docs/design-sell.md): the record a sale is resumed from,
 * and the one figure the operator's float checks subtract, the proceeds owed.
 * What is pinned: a sale is written whole and read back whole, the work still
 * to do is findable without scanning every sale ever made, and proceeds count
 * as owed from the moment a sale fills until its payout lands, not a moment
 * longer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStore, type Sale } from "../../src/fleet/store.js";
import { createNeonStore, type StoreSql } from "../../src/fleet/store-neon.js";

const OWNER = `0x${"ab".repeat(20)}` as const;
const TOKEN = `0x${"cd".repeat(20)}` as const;
const PAYOUT = `0x${"ef".repeat(20)}` as const;

const sale = (over: Partial<Sale> = {}): Sale => ({
  id: "sale-1", campaign: `0x${"01".repeat(32)}`, owner: OWNER, token: TOKEN, payout: PAYOUT,
  amountIn: "5000", transfers: [`0x${"11".repeat(32)}`], state: "awaiting", attempts: 0, createdAt: 1_000, ...over,
});

describe("sales in the memory store", () => {
  it("reads a sale back whole, and a later write replaces it", async () => {
    const store = createMemoryStore();
    await store.sales.put(sale());
    assert.deepEqual(await store.sales.get("sale-1"), sale());
    await store.sales.put(sale({ state: "sold", ethOut: "700", saleTx: `0x${"22".repeat(32)}`, payoutDueAt: 9_000 }));
    assert.equal((await store.sales.get("sale-1"))?.state, "sold");
    assert.equal(await store.sales.get("nope"), undefined);
  });

  it("lists an owner's sales, newest first, and nobody else's", async () => {
    const store = createMemoryStore();
    await store.sales.put(sale({ id: "a", createdAt: 1 }));
    await store.sales.put(sale({ id: "b", createdAt: 2 }));
    await store.sales.put(sale({ id: "c", owner: PAYOUT }));
    assert.deepEqual((await store.sales.forOwner(OWNER)).map((s) => s.id), ["b", "a"]);
    assert.deepEqual((await store.sales.forOwner(OWNER.toUpperCase().replace("0X", "0x") as typeof OWNER)).map((s) => s.id), ["b", "a"], "the owner matches whatever its case");
  });

  it("offers only sales with work left: awaiting a sale or a payout", async () => {
    const store = createMemoryStore();
    for (const state of ["awaiting", "sold", "paid", "returned", "failed"] as const) await store.sales.put(sale({ id: state, state }));
    assert.deepEqual((await store.sales.pending()).map((s) => s.id).sort(), ["awaiting", "sold"]);
  });

  it("owes proceeds from the sale until the payout: sold counts, paid and everything else does not", async () => {
    const store = createMemoryStore();
    assert.equal(await store.sales.proceedsOwed(), "0");
    await store.sales.put(sale({ id: "x", state: "sold", ethOut: "700" }));
    await store.sales.put(sale({ id: "y", state: "sold", ethOut: "300" }));
    await store.sales.put(sale({ id: "z", state: "paid", ethOut: "999" }));
    await store.sales.put(sale({ id: "w", state: "awaiting" }));
    assert.equal(await store.sales.proceedsOwed(), "1000");
  });
});

describe("sales in the Neon store", () => {
  it("writes one row per sale, upserted, with the columns its queries read", async () => {
    const calls: { query: string; params: unknown[] }[] = [];
    const sql: StoreSql = {
      async query(query, params = []) {
        calls.push({ query, params });
        if (query.includes("SUM(eth_out")) return [{ owed: "1000" }];
        return [];
      },
    };
    const store = createNeonStore(sql);
    await store.initialize();
    assert.ok(calls.some((c) => /CREATE TABLE IF NOT EXISTS fleet_sales/.test(c.query)), "the table is created with the rest");
    await store.sales.put(sale({ state: "sold", ethOut: "700" }));
    const write = calls.find((c) => c.query.includes("INSERT INTO fleet_sales"))!;
    assert.match(write.query, /ON CONFLICT \(id\) DO UPDATE/);
    assert.deepEqual(write.params.slice(0, 4), ["sale-1", OWNER, "sold", "700"]);
    assert.deepEqual(JSON.parse(String(write.params[4])), sale({ state: "sold", ethOut: "700" }));
    assert.equal(await store.sales.proceedsOwed(), "1000");
    assert.match(calls.at(-1)!.query, /WHERE state = 'sold'/);
  });

  it("maps rows back to sales", async () => {
    const stored = sale({ state: "sold", ethOut: "700" });
    const sql: StoreSql = { async query(query) { return query.includes("SELECT record") ? [{ record: stored }] : []; } };
    const store = createNeonStore(sql);
    assert.deepEqual(await store.sales.get("sale-1"), stored);
    assert.deepEqual(await store.sales.pending(), [stored]);
    assert.deepEqual(await store.sales.forOwner(OWNER), [stored]);
  });
});

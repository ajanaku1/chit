/**
 * The shared store: the state that used to live in per-instance Maps, behind
 * one port so a second serverless instance sees what the first did. The
 * memory adapter is the contract every adapter must meet; the Neon adapter is
 * tested against a fake `sql` in store-neon.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStore, type StorePort } from "../../src/fleet/store.js";

const DEPOSITOR = `0x${"ab".repeat(20)}` as const;
const OTHER = `0x${"cd".repeat(20)}` as const;
const TX = `0x${"11".repeat(32)}` as const;
const owed = (id: string, depositor = DEPOSITOR, amount = "1000") => ({ id, depositor, amount, incurredAt: "2026-09-15T00:00:00.000Z" });

const contract = (name: string, make: () => StorePort): void => {
  describe(name, () => {
    it("claims a slice exactly once under fifty concurrent claims, and again after release", async () => {
      const store = make();
      const claims = await Promise.all(Array.from({ length: 50 }, () => store.claimSlice("order|3")));
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await store.claimSlice("order|4"), true, "a different slice is its own claim");
      await store.releaseSlice("order|3");
      assert.equal(await store.claimSlice("order|3"), true, "a released slice can be claimed again");
    });

    it("burns a nonce once, and forgets it once it has expired", async () => {
      let now = 1_000_000;
      const store = make();
      assert.equal(await store.burnNonce("n1", now + 60_000, now), true);
      assert.equal(await store.burnNonce("n1", now + 60_000, now), false, "a second presentation is a replay");
      now += 120_000;
      assert.equal(await store.burnNonce("n1", now + 60_000, now), true, "an expired burn no longer blocks; the TTL bounds it");
    });

    it("keeps one idempotency record per scoped key", async () => {
      const store = make();
      assert.equal(await store.idempotency.get("k|w|a|c"), undefined);
      await store.idempotency.put("k|w|a|c", { payloadHash: TX, result: { status: 200 } });
      assert.deepEqual(await store.idempotency.get("k|w|a|c"), { payloadHash: TX, result: { status: 200 } });
    });

    it("runs work under one named lock at a time, in arrival order", async () => {
      const store = make();
      const log: string[] = [];
      const work = (tag: string, wait: number) => store.withLock("operator", async () => {
        log.push(`${tag}:start`);
        await new Promise((r) => setTimeout(r, wait));
        log.push(`${tag}:end`);
        return tag;
      });
      const results = await Promise.all([work("a", 20), work("b", 5)]);
      assert.deepEqual(results, ["a", "b"]);
      assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end"]);
    });

    it("releases the lock when the work throws", async () => {
      const store = make();
      await assert.rejects(store.withLock("operator", async () => { throw new Error("boom"); }), /boom/);
      assert.equal(await store.withLock("operator", async () => "free"), "free");
    });

    it("holds owed spend until a batch takes it, and sums what a depositor still owes", async () => {
      const store = make();
      await store.recordOwed(owed("o1"));
      await store.recordOwed(owed("o2", DEPOSITOR, "2500"));
      await store.recordOwed(owed("o3", OTHER, "7"));
      assert.equal(await store.owedFor(DEPOSITOR), "3500");
      assert.equal(await store.owedFor(OTHER), "7");

      const taken = await store.takeOwed(2);
      assert.equal(taken.length, 2);
      assert.deepEqual((await store.takeOwed(5)).map((o) => o.id), ["o3"], "a taken row is leased, not offered twice");
      assert.equal(await store.owedFor(DEPOSITOR), "3500", "leased spend is still owed until the tx lands");

      await store.confirmOwed(taken.map((o) => o.id), TX);
      assert.equal(await store.owedFor(DEPOSITOR), "0", "confirmed spend is the chain's now, not the store's");
      await store.releaseOwed(["o3"]);
      assert.deepEqual((await store.takeOwed(5)).map((o) => o.id), ["o3"], "a released row goes back to the next batch");
    });
  });
};

contract("memory store", () => createMemoryStore());

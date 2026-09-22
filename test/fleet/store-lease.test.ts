import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStore, type Lease } from "../../src/fleet/store.js";
import { createNeonStore } from "../../src/fleet/store-neon.js";

/**
 * The operator lock as a lease (T027).
 *
 * The lock is a row with an expiry, so a dead instance cannot keep it. That
 * cuts both ways: a live instance whose step outlasts the TTL loses it too,
 * silently, and the next instance signs beside it. Two things close that.
 * The holder renews the lease while its work runs, and asks, right before a
 * broadcast, whether it still holds it; a lease that was lost answers no,
 * and the signed step's `record` refuses, so nothing is broadcast (the
 * adapter's rule 1). Held here against a real Postgres, since expiry is SQL.
 */

describe("the lease on a lock", () => {
  // The clock is the test's: it stands still unless a test says it runs (`tick` per reading).
  const pglite = async (ttlMs: number, clock: { now: number; tick?: number }) => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    const sql = { query: async (q: string, params?: unknown[]) => (await db.query(q, params)).rows as Record<string, unknown>[] };
    const store = createNeonStore(sql, { ttlMs, pollMs: 5, now: () => (clock.now += clock.tick ?? 0), renew: false });
    await store.initialize();
    return { store, sql, close: () => db.close() };
  };

  it("is held for the whole of an ordinary step, and says so", async () => {
    const clock = { now: 1_000_000 };
    const { store, close } = await pglite(1_000, clock);
    try {
      const seen: boolean[] = [];
      await store.withLock("operator", async (lease) => {
        seen.push(await lease.held());
        clock.now += 400;
        seen.push(await lease.held());
      });
      assert.deepEqual(seen, [true, true]);
    } finally {
      await close();
    }
  });

  it("is lost when the TTL passes and another holder takes it, and the loser is told before it broadcasts", async () => {
    const clock = { now: 1_000_000 };
    const { store, close } = await pglite(1_000, clock);
    try {
      let stolen: Lease | undefined;
      await store.withLock("operator", async (lease) => {
        clock.now += 1_001; // the step ran past its lease
        await store.withLock("operator", async (other) => { stolen = other; }); // another instance takes it
        assert.equal(await lease.held(), false, "the first holder is not the holder any more");
        assert.equal(stolen !== undefined, true);
      });
    } finally {
      await close();
    }
  });

  it("renews: a holder that keeps renewing keeps the lock past the TTL, and nobody else gets in", async () => {
    const clock: { now: number; tick?: number } = { now: 1_000_000 };
    const { store, close } = await pglite(1_000, clock);
    try {
      await store.withLock("operator", async (lease) => {
        for (let i = 0; i < 5; i += 1) {
          clock.now += 600;
          await lease.renew();
        }
        assert.equal(await lease.held(), true, "three seconds in, renewed every 600 ms, still the holder");
        clock.tick = 50; // time runs for the second taker, which polls until its own TTL is up
        await assert.rejects(store.withLock("operator", async () => undefined), /lock_timeout/, "a second taker waits its TTL and gives up");
        clock.tick = 0;
      });
    } finally {
      await close();
    }
  });

  it("renewing a lost lease does not take it back", async () => {
    const clock = { now: 1_000_000 };
    const { store, close } = await pglite(1_000, clock);
    try {
      await store.withLock("operator", async (lease) => {
        clock.now += 1_001;
        await store.withLock("operator", async () => undefined);
        // released by the other holder, so the row is gone; renewing must not resurrect it as ours
        await lease.renew();
        assert.equal(await lease.held(), false);
      });
    } finally {
      await close();
    }
  });

  it("releases only its own lease: a lock taken over by another holder is not deleted by the loser's finally", async () => {
    const clock = { now: 1_000_000 };
    const { store, sql, close } = await pglite(1_000, clock);
    try {
      let inner: Promise<void> | undefined;
      await store.withLock("operator", async () => {
        clock.now += 1_001;
        inner = store.withLock("operator", async () => { await new Promise((r) => setTimeout(r, 30)); });
        await new Promise((r) => setTimeout(r, 10)); // the other holder has the row now
      });
      // the outer finally ran while the inner still held: the row must still be there
      const rows = await sql.query("SELECT holder FROM fleet_locks WHERE name = 'operator'");
      assert.equal(rows.length, 1, "the new holder's row survived the old holder's release");
      await inner;
    } finally {
      await close();
    }
  });

  it("in memory the lease is the promise chain: always held, and renewing is a no-op", async () => {
    const store = createMemoryStore();
    await store.withLock("operator", async (lease) => {
      await lease.renew();
      assert.equal(await lease.held(), true);
    });
  });
});

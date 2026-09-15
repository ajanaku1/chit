/**
 * The Neon adapter, against a fake `sql`. What is pinned: every claim is one
 * atomic statement (no read-then-write), the lock is a lease that a dead holder
 * cannot keep past its TTL, and rows map back to the port's shapes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNeonStore, type StoreSql } from "../../src/fleet/store-neon.js";

const DEPOSITOR = `0x${"ab".repeat(20)}` as const;
const TX = `0x${"11".repeat(32)}` as const;

type Call = { query: string; params: unknown[] };

/** A scripted `sql`: each matcher answers the statements it recognises, in order. */
const fakeSql = (answer: (call: Call) => readonly Record<string, unknown>[] | undefined): StoreSql & { calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    async query(query, params = []) {
      const call = { query, params };
      calls.push(call);
      if (query.includes("CREATE TABLE")) return [];
      const rows = answer(call);
      if (rows === undefined) throw new Error(`Unexpected SQL: ${query}`);
      return rows;
    },
  };
};

describe("Neon store", () => {
  it("creates its tables once and claims a slice with one INSERT that fails silently on conflict", async () => {
    const claimed = new Set<string>();
    const sql = fakeSql(({ query, params }) => {
      if (query.includes("INSERT INTO fleet_slices")) {
        if (claimed.has(String(params[0]))) return [];
        claimed.add(String(params[0]));
        return [{ key: params[0] }];
      }
      if (query.includes("DELETE FROM fleet_slices")) { claimed.delete(String(params[0])); return []; }
      return undefined;
    });
    const store = createNeonStore(sql);
    await store.initialize();
    assert.equal(sql.calls.filter((c) => c.query.includes("CREATE TABLE")).length, 5, "one statement per table");

    assert.equal(await store.claimSlice("o|1"), true);
    assert.equal(await store.claimSlice("o|1"), false);
    await store.releaseSlice("o|1");
    assert.equal(await store.claimSlice("o|1"), true);
    const claim = sql.calls.find((c) => c.query.includes("INSERT INTO fleet_slices"))!;
    assert.match(claim.query, /ON CONFLICT .* DO NOTHING/s);
    assert.match(claim.query, /RETURNING/);
  });

  it("burns a nonce with an insert that returns nothing on replay, and prunes expired burns first", async () => {
    const burned = new Map<string, number>();
    const sql = fakeSql(({ query, params }) => {
      if (query.includes("DELETE FROM fleet_nonces")) {
        for (const [n, exp] of burned) if (exp <= Number(params[0])) burned.delete(n);
        return [];
      }
      if (query.includes("INSERT INTO fleet_nonces")) {
        if (burned.has(String(params[0]))) return [];
        burned.set(String(params[0]), Number(params[1]));
        return [{ nonce: params[0] }];
      }
      return undefined;
    });
    const store = createNeonStore(sql);
    assert.equal(await store.burnNonce("n", 2_000, 1_000), true);
    assert.equal(await store.burnNonce("n", 2_000, 1_000), false);
    assert.equal(await store.burnNonce("n", 5_000, 3_000), true, "expired, so pruned, so burnable again");
  });

  it("reads and writes idempotency records as JSON", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const sql = fakeSql(({ query, params }) => {
      if (query.includes("SELECT payload_hash, result FROM fleet_idempotency")) {
        const row = rows.get(String(params[0]));
        return row ? [row] : [];
      }
      if (query.includes("INSERT INTO fleet_idempotency")) {
        rows.set(String(params[0]), { payload_hash: params[1], result: JSON.parse(String(params[2])) });
        return [];
      }
      return undefined;
    });
    const store = createNeonStore(sql);
    assert.equal(await store.idempotency.get("k"), undefined);
    await store.idempotency.put("k", { payloadHash: TX, result: { status: 200, body: { ok: true } } });
    assert.deepEqual(await store.idempotency.get("k"), { payloadHash: TX, result: { status: 200, body: { ok: true } } });
  });

  it("takes the lock as a lease, waits while another holder has it, and deletes only its own row", async () => {
    let holder: string | undefined;
    let attempts = 0;
    const sql = fakeSql(({ query, params }) => {
      if (query.includes("INSERT INTO fleet_locks")) {
        attempts += 1;
        // Held by someone else for the first two attempts, then free.
        if (attempts <= 2) return [];
        holder = String(params[1]);
        return [{ holder }];
      }
      if (query.includes("DELETE FROM fleet_locks")) {
        assert.equal(params[1], holder, "releases with its own holder id");
        holder = undefined;
        return [];
      }
      return undefined;
    });
    const store = createNeonStore(sql, { pollMs: 1 });
    assert.equal(await store.withLock("operator", async () => "ran"), "ran");
    assert.equal(attempts, 3);
    assert.equal(holder, undefined);
    const acquire = sql.calls.find((c) => c.query.includes("INSERT INTO fleet_locks"))!;
    assert.match(acquire.query, /ON CONFLICT \(name\) DO UPDATE/);
    assert.match(acquire.query, /WHERE fleet_locks\.expires_at <\s*\$/, "a live lease is never overwritten");
  });

  it("gives up on a lock that never frees, after the TTL", async () => {
    const sql = fakeSql(({ query }) => (query.includes("INSERT INTO fleet_locks") ? [] : undefined));
    const store = createNeonStore(sql, { pollMs: 1, ttlMs: 10 });
    await assert.rejects(store.withLock("operator", async () => "never"), /lock_timeout/);
  });

  it("records, leases, confirms and releases owed spend, and sums the unconfirmed", async () => {
    const owed = new Map<string, Record<string, unknown>>();
    const sql = fakeSql(({ query, params }) => {
      if (query.includes("INSERT INTO fleet_owed_spend")) {
        owed.set(String(params[0]), { id: params[0], depositor: params[1], amount: params[2], incurred_at: params[3], leased_until: 0, queued_tx: null });
        return [];
      }
      if (query.includes("SET leased_until = 0")) { for (const id of params[0] as string[]) owed.get(id)!["leased_until"] = 0; return []; }
      if (query.includes("UPDATE fleet_owed_spend SET leased_until")) {
        const rows = [...owed.values()].filter((r) => r["queued_tx"] === null && Number(r["leased_until"]) < Number(params[1])).slice(0, Number(params[2]));
        for (const r of rows) r["leased_until"] = params[0];
        return rows;
      }
      if (query.includes("SET queued_tx")) { for (const id of params[1] as string[]) owed.get(id)!["queued_tx"] = params[0]; return []; }
      if (query.includes("SUM(amount::numeric)")) {
        const sum = [...owed.values()].filter((r) => r["queued_tx"] === null && r["depositor"] === String(params[0]).toLowerCase())
          .reduce((n, r) => n + BigInt(String(r["amount"])), 0n);
        return [{ owed: sum.toString() }];
      }
      return undefined;
    });
    const store = createNeonStore(sql);
    await store.recordOwed({ id: "o1", depositor: DEPOSITOR, amount: "1000", incurredAt: "2026-09-15T00:00:00.000Z" });
    await store.recordOwed({ id: "o2", depositor: DEPOSITOR, amount: "500", incurredAt: "2026-09-15T00:00:01.000Z" });
    assert.equal(await store.owedFor(DEPOSITOR), "1500");
    const taken = await store.takeOwed(1);
    assert.deepEqual(taken, [{ id: "o1", depositor: DEPOSITOR, amount: "1000", incurredAt: "2026-09-15T00:00:00.000Z" }]);
    assert.deepEqual((await store.takeOwed(5)).map((o) => o.id), ["o2"]);
    await store.confirmOwed(["o1"], TX);
    await store.releaseOwed(["o2"]);
    assert.equal(await store.owedFor(DEPOSITOR), "500");
    assert.deepEqual((await store.takeOwed(5)).map((o) => o.id), ["o2"]);
  });
});

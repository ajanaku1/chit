import assert from "node:assert/strict";
import test from "node:test";
import { parseEther } from "viem";

import { MemoryBotWalletStore, NeonBotWalletStore, RefCodeTaken, withDefaults, type BotSql, type BotWallet, type BotWalletStore } from "../../src/fleet/bot-wallets.js";
import type { Address } from "../../src/fleet/types.js";

/**
 * The store's contract, the same for both stores: create is insert-if-absent
 * and hands back what exists; patches touch one column; the faucet stamp,
 * the day's budget, an update id and a lock are claimed atomically; meta
 * keeps the first value. Memory always; the Neon store against PGlite (a
 * real Postgres in-process, which like Neon's HTTP driver takes one
 * statement per query) always; and against Neon itself when
 * BOT_TEST_DATABASE_URL names a scratch database.
 */

const wallet = (tgId: string, refCode = `code${tgId}`): BotWallet => withDefaults({
  tgId, address: `0x${tgId.padStart(40, "0")}` as Address, sealedKey: `v2.sealed-${tgId}`, createdAt: "2026-09-16T10:00:00.000Z", refCode,
});
const T0 = new Date("2026-09-16T10:00:00Z");
const later = (ms: number): Date => new Date(T0.getTime() + ms);

const contract = (name: string, make: () => Promise<{ store: BotWalletStore; done: () => Promise<void> }>) => {
  test(`${name}: create is insert-if-absent and returns what is stored`, async () => {
    const { store, done } = await make();
    try {
      const first = await store.create(wallet("1"));
      assert.equal(first.tgId, "1");
      const again = await store.create({ ...wallet("1"), sealedKey: "v2.other", refCode: "code1b" });
      assert.equal(again.sealedKey, first.sealedKey, "the first writer's row comes back");
      assert.equal((await store.get("1"))!.sealedKey, first.sealedKey);
      await assert.rejects(store.create(wallet("2", "code1")), RefCodeTaken, "a taken referral code is refused");
      assert.equal(await store.get("2"), undefined);
      assert.equal(await store.count(), 1);
    } finally { await done(); }
  });

  test(`${name}: patches touch one column and never the others`, async () => {
    const { store, done } = await make();
    try {
      await store.create(wallet("1"));
      await store.patch("1", { fleet: "v2.fleet-blob" });
      await store.patch("1", { settings: { ...wallet("1").settings, confirmTrades: true } });
      await store.patch("1", { tokens: ["0x00000000000000000000000000000000000000ce" as Address] });
      const w = (await store.get("1"))!;
      assert.equal(w.fleet, "v2.fleet-blob", "the fleet survived the settings and tokens writes");
      assert.equal(w.settings.confirmTrades, true);
      assert.equal(w.tokens.length, 1);
      await store.patch("1", { fleet: null });
      assert.equal((await store.get("1"))!.fleet, undefined);
      assert.equal((await store.get("1"))!.settings.confirmTrades, true, "clearing the fleet left the settings");
      await store.patch("1", {});
      await store.patch("nobody", { tokens: [] });
    } finally { await done(); }
  });

  test(`${name}: the faucet stamp is claimed once per window and can be given back`, async () => {
    const { store, done } = await make();
    try {
      await store.create(wallet("1"));
      const day = 24 * 3600 * 1000;
      const first = await store.claimFaucet("1", T0, day);
      assert.deepEqual(first, { claimed: true, previous: null });
      const second = await store.claimFaucet("1", later(1000), day);
      assert.equal(second.claimed, false);
      assert.equal(second.previous, T0.toISOString());
      const burst = await Promise.all([store.claimFaucet("1", later(day + 1), day), store.claimFaucet("1", later(day + 1), day), store.claimFaucet("1", later(day + 1), day)]);
      assert.equal(burst.filter((c) => c.claimed).length, 1, "a burst wins once");
      await store.restoreFaucet("1", T0.toISOString());
      assert.equal((await store.get("1"))!.faucetAt, T0.toISOString());
      assert.equal((await store.claimFaucet("1", later(day + 2), day)).claimed, true, "given back, it can be claimed again");
      assert.equal((await store.claimFaucet("nobody", T0, day)).claimed, false);
    } finally { await done(); }
  });

  test(`${name}: the day's faucet budget is a cap across everyone`, async () => {
    const { store, done } = await make();
    try {
      const cap = parseEther("0.05");
      assert.equal(await store.spendFaucetBudget("2026-09-16", parseEther("0.02"), cap), true);
      assert.equal(await store.spendFaucetBudget("2026-09-16", parseEther("0.02"), cap), true);
      assert.equal(await store.spendFaucetBudget("2026-09-16", parseEther("0.02"), cap), false, "0.06 is over 0.05");
      await store.refundFaucetBudget("2026-09-16", parseEther("0.02"));
      assert.equal(await store.spendFaucetBudget("2026-09-16", parseEther("0.02"), cap), true, "a refund makes room");
      assert.equal(await store.spendFaucetBudget("2026-09-17", parseEther("0.02"), cap), true, "a new day starts at zero");
      assert.equal(await store.spendFaucetBudget("2026-09-18", parseEther("0.06"), cap), false, "one payout over the cap is refused on a fresh day too");
    } finally { await done(); }
  });

  test(`${name}: an update id is claimed once; a lock is held until released or expired; meta keeps the first value`, async () => {
    const { store, done } = await make();
    try {
      assert.equal(await store.claimUpdate(1001, T0), true);
      assert.equal(await store.claimUpdate(1001, later(5)), false);
      assert.equal(await store.claimUpdate(1002, T0), true);

      assert.equal(await store.lock("wallet:1", T0, 1000), true);
      assert.equal(await store.lock("wallet:1", later(500), 1000), false, "held");
      assert.equal(await store.lock("wallet:2", later(500), 1000), true, "another key is free");
      assert.equal(await store.lock("wallet:1", later(1001), 1000), true, "expired leases are taken over");
      await store.unlock("wallet:1");
      assert.equal(await store.lock("wallet:1", later(1002), 1000), true, "released");
      await store.unlock("wallet:1");
      await store.unlock("wallet:2");

      assert.equal(await store.getMeta("canary"), undefined);
      await store.setMeta("canary", "first");
      await store.setMeta("canary", "second");
      assert.equal(await store.getMeta("canary"), "first");
    } finally { await done(); }
  });

  test(`${name}: trades are kept per wallet and token, once per tx hash, oldest first`, async () => {
    const { store, done } = await make();
    try {
      const token = "0x00000000000000000000000000000000000000ce" as Address;
      const other = "0x0000000000000000000000000000000000000fee" as Address;
      const trade = (n: number, side: "buy" | "sell", at: string, tgId = "1", t: Address = token) => ({ tgId, token: t, side, ethWei: parseEther("0.002").toString(), tokenUnits: "1980000000000000000", txHash: `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`, at });
      await store.recordTrade(trade(2, "sell", "2026-09-16T11:00:00.000Z"));
      await store.recordTrade(trade(1, "buy", "2026-09-16T10:00:00.000Z"));
      await store.recordTrade(trade(1, "buy", "2026-09-16T10:00:00.000Z"));
      await store.recordTrade(trade(3, "buy", "2026-09-16T10:30:00.000Z", "2"));
      await store.recordTrade(trade(4, "buy", "2026-09-16T10:30:00.000Z", "1", other));
      const mine = await store.tradesOf("1", token);
      assert.deepEqual(mine.map((t) => t.side), ["buy", "sell"], "oldest first, the duplicate hash dropped");
      assert.equal(mine[0]!.ethWei, parseEther("0.002").toString());
      assert.equal(mine[0]!.tokenUnits, "1980000000000000000");
      assert.equal(mine[0]!.at, "2026-09-16T10:00:00.000Z");
      assert.equal(mine[0]!.token.toLowerCase(), token);
      assert.equal((await store.tradesOf("1", other)).length, 1);
      assert.equal((await store.tradesOf("2", token)).length, 1);
      assert.equal((await store.tradesOf("3", token)).length, 0);
      assert.equal((await store.tradesOf("1", token.toUpperCase().replace("0X", "0x") as Address)).length, 2, "the token is matched whatever its case");
    } finally { await done(); }
  });

  test(`${name}: referral codes look wallets up and count referrals`, async () => {
    const { store, done } = await make();
    try {
      await store.create(wallet("1", "abc"));
      await store.create({ ...wallet("2"), referredBy: "abc" });
      await store.create({ ...wallet("3"), referredBy: "abc" });
      assert.equal((await store.byRefCode("abc"))!.tgId, "1");
      assert.equal(await store.byRefCode("nope"), undefined);
      assert.equal(await store.referralsOf("abc"), 2);
      assert.equal(await store.count(), 3);
    } finally { await done(); }
  });
};

contract("memory", async () => ({ store: new MemoryBotWalletStore(), done: async () => undefined }));

contract("neon store on pglite", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const port: BotSql = { query: async (q, params) => (await db.query(q, params)).rows as Record<string, unknown>[] };
  return { store: new NeonBotWalletStore(port), done: () => db.close() };
});

const url = process.env.BOT_TEST_DATABASE_URL;
if (url) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  const port: BotSql = { query: (q, params) => sql.query(q, params) as Promise<readonly Record<string, unknown>[]> };
  const wipe = async (): Promise<void> => {
    for (const t of ["bot_wallets", "bot_faucet_days", "bot_updates", "bot_locks", "bot_meta", "bot_trades"]) await port.query(`DELETE FROM ${t}`).catch(() => undefined);
  };
  contract("neon", async () => { await wipe(); return { store: new NeonBotWalletStore(port), done: wipe }; });
} else {
  test("neon store contract (skipped: set BOT_TEST_DATABASE_URL to a scratch Neon database)", { skip: true }, () => undefined);
}

/** The Neon store's SQL, checked without a database: one statement per query, and the shapes the contract above relies on. */
test("the Neon store sends its schema one statement at a time and its claims as single atomic statements", async () => {
  const seen: Array<{ q: string; params?: unknown[] }> = [];
  const fake: BotSql = {
    async query(q, params) {
      seen.push({ q, ...(params ? { params } : {}) });
      if (/^INSERT INTO bot_wallets/.test(q)) return [{ tg_id: "1", address: "0x1", sealed_key: "v2.x", created_at: "2026-09-16T10:00:00.000Z", faucet_at: null, settings: {}, tokens: [], ref_code: "c", referred_by: null, fleet: null }];
      if (/WITH before AS/.test(q)) return [{ previous: null, claimed: true }];
      return [];
    },
  };
  const store = new NeonBotWalletStore(fake);
  await store.create(wallet("1"));
  const schema = seen.slice(0, -1);
  assert.ok(schema.length >= 7, "the schema was applied first");
  for (const s of schema) assert.ok(!/;\s*\S/.test(s.q), `one statement per query: ${s.q.slice(0, 40)}`);
  assert.match(seen.at(-1)!.q, /ON CONFLICT \(tg_id\) DO NOTHING\s+RETURNING \*/);

  seen.length = 0;
  await store.claimFaucet("1", T0, 1000);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.q, /UPDATE bot_wallets SET faucet_at = \$2 WHERE tg_id = \$1 AND \(faucet_at IS NULL OR faucet_at <= \$3\)/);
  await store.lock("k", T0, 1000);
  assert.match(seen.at(-1)!.q, /ON CONFLICT \(key\) DO UPDATE SET until = EXCLUDED.until WHERE bot_locks.until <= \$3/);
  await store.spendFaucetBudget("d", 1n, 2n);
  assert.match(seen.at(-1)!.q, /WHERE bot_faucet_days.spent \+ EXCLUDED.spent <= \$3::numeric/);
  await store.patch("1", { fleet: null, tokens: [] });
  assert.match(seen.at(-1)!.q, /^UPDATE bot_wallets SET tokens = \$2::jsonb, fleet = \$3 WHERE tg_id = \$1$/);
  assert.deepEqual(seen.at(-1)!.params, ["1", "[]", null]);

  // A schema that fails is not remembered as ready.
  let fail = true;
  const flaky: BotSql = { async query(q) { if (fail && /CREATE TABLE/.test(q)) { fail = false; throw new Error("connection reset"); } return []; } };
  const retrying = new NeonBotWalletStore(flaky);
  await assert.rejects(retrying.count(), /connection reset/);
  assert.equal(await retrying.count(), 0, "the next call runs the schema again");
});

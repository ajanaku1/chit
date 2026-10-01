/**
 * The competition's entries: a nickname is one entrant's in any case, a
 * second /join renames and keeps the first join's time, the @username is
 * whatever Telegram sent last (none is fine). The same contract for memory
 * and for the Neon store on PGlite. /join answers how to enter, refuses a
 * nickname outside the rule, and says /link when no account is linked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCompStore, NeonCompStore, joinReply, type CompSql, type CompStore } from "../../src/fleet/bot-comp.js";

const t0 = new Date("2026-10-01T10:00:00Z"), t1 = new Date("2026-10-01T11:00:00Z");
const entry = (tgId: string, nickname: string, at: Date, username: string | null = null) => ({ tgId, username, nickname, joinedAt: at.toISOString() });

const contract = (name: string, make: () => Promise<{ store: CompStore; done: () => Promise<void> }>): void => {
  test(`${name}: a nickname is one entrant's in any case; a second join renames and keeps the first time`, async () => {
    const { store, done } = await make();
    try {
      assert.equal(await store.join(entry("1", "MoonBoy", t0, "moon")), "joined");
      assert.equal(await store.join(entry("2", "moonboy", t0)), "taken", "the same nickname in another case");
      assert.equal(await store.join(entry("2", "sunboy", t0)), "joined");
      assert.equal(await store.join(entry("1", "MOONBOY", t1, "moon2")), "renamed", "an entrant may change their own nickname's case");
      assert.equal(await store.join(entry("1", "sunboy", t1)), "taken");
      assert.deepEqual(await store.all(), [entry("1", "MOONBOY", t0, "moon2"), entry("2", "sunboy", t0)]);
    } finally { await done(); }
  });
};

contract("memory", async () => ({ store: new MemoryCompStore(), done: async () => undefined }));

contract("neon store on pglite", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const port: CompSql = { query: async (q, params) => (await db.query(q, params)).rows as Record<string, unknown>[] };
  return { store: new NeonCompStore(port), done: () => db.close() };
});

test("/join: how to enter with no nickname, the rule for a bad one, /link when nothing is linked, and a taken one named", async () => {
  const store = new MemoryCompStore();
  const me = { tgId: "7", username: "ogle" };
  assert.match(await joinReply(store, me, "", false, t0), /send \/join and the nickname.*your wallet is never shown/);
  assert.match(await joinReply(store, me, " a b ", false, t0), /won't work.*3 to 20/);
  assert.match(await joinReply(store, me, " <b>x</b>", false, t0), /won't work/, "markup is not a nickname");
  assert.match(await joinReply(store, me, " @moonboy", false, t0), /you're in as <b>moonboy<\/b>.*\/link first/);
  assert.equal((await store.all())[0]!.username, "ogle");
  assert.match(await joinReply(store, me, " moonboy2", true, t1), /nickname is now <b>moonboy2<\/b>\. only trades you make in this bot/);
  assert.match(await joinReply(store, { tgId: "8" }, " MoonBoy2", true, t1), /<b>MoonBoy2<\/b> is taken/);
});

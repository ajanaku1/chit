/**
 * The signed link: only the account's owner can link it, once per nonce,
 * within the nonce's life; every refusal names its reason; a bad signature
 * leaves the nonce unspent so the owner can try again. The store claims a
 * Telegram update id once, in memory and as one atomic statement on Neon.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { issueNonce, LinkError, linkMessage, MemoryBotLinkStore, NeonBotLinkStore, NONCE_TTL_MS, verifyLink, type BotLinkStore, type LinkSql } from "../../src/fleet/bot-link.js";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const CHAIN = 4663;
const t0 = new Date("2026-09-20T12:00:00Z");
const ownerOf = async (a: Address) => (getAddress(a) === getAddress(ACCOUNT) ? OWNER.address : undefined);

const signed = async (nonce: string, by = OWNER, chainId = CHAIN, account: Address = ACCOUNT) =>
  ({ nonce, account, signature: await by.signMessage({ message: linkMessage(chainId, account, nonce) }) });

test("the owner links their account with one signature; the link carries the proof; re-linking replaces it", async () => {
  const store = new MemoryBotLinkStore();
  const nonce = await issueNonce(store, "7", t0);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const link = await verifyLink(store, CHAIN, await signed(nonce), ownerOf, new Date(t0.getTime() + 60_000));
  assert.equal(link.tgId, "7");
  assert.equal(link.account, getAddress(ACCOUNT));
  assert.equal(link.owner, OWNER.address);
  assert.equal(link.chainId, CHAIN);
  assert.deepEqual(await store.getLink("7"), link);
  assert.equal((await store.linksTo(ACCOUNT)).length, 1);
  // A second link from the same telegram replaces the first.
  const n2 = await issueNonce(store, "7", t0);
  const again = await verifyLink(store, CHAIN, await signed(n2), ownerOf, t0);
  assert.equal((await store.getLink("7"))!.nonce, again.nonce);
});

test("a stranger's signature, a wrong chain, a used nonce, an expired nonce and an unknown account are each refused by name", async () => {
  const store = new MemoryBotLinkStore();
  const nonce = await issueNonce(store, "7", t0);
  const refused = async (req: Parameters<typeof verifyLink>[2], status: number, why: RegExp, at = t0) =>
    assert.rejects(verifyLink(store, CHAIN, req, ownerOf, at), (e: unknown) => e instanceof LinkError && e.status === status && why.test(e.message), `${status} ${why}`);
  await refused(await signed(nonce, STRANGER), 403, /not the account owner/);
  await refused(await signed(nonce, OWNER, 46630), 403, /not the account owner/);
  await refused(await signed(nonce, OWNER, CHAIN, "0x00000000000000000000000000000000000000bb"), 404, /no session account/);
  assert.equal((await store.getNonce(nonce))!.usedAt, null, "refusals did not spend the nonce");
  await refused({ nonce: "zz", account: ACCOUNT, signature: "0x00" }, 400, /nonce/);
  await refused({ nonce, account: "nope", signature: "0x00" }, 400, /account/);
  await refused({ nonce, account: ACCOUNT, signature: "0x1234" }, 400, /signature/);
  await refused(await signed("0".repeat(32)), 404, /unknown/);
  await refused(await signed(nonce), 410, /expired/, new Date(t0.getTime() + NONCE_TTL_MS + 1));
  // The good link spends the nonce; the same proof again is a replay.
  const req = await signed(nonce);
  await verifyLink(store, CHAIN, req, ownerOf, t0);
  await refused(req, 409, /already used/);
});

test("the message is exact: chain id, checksummed account, nonce, pipe-separated", () => {
  assert.equal(linkMessage(4663, "0x00000000000000000000000000000000000000aa", "ab".repeat(16)), `chit-bot-link|4663|0x00000000000000000000000000000000000000AA|${"ab".repeat(16)}`);
});

test("an update id is claimed once: the first claim is true, a repeat false, another id true", async () => {
  const store: BotLinkStore = new MemoryBotLinkStore();
  assert.equal(await store.claimUpdate(1001, t0), true);
  assert.equal(await store.claimUpdate(1001, t0), false, "a redelivery");
  assert.equal(await store.claimUpdate(1002, t0), true);
});

test("the Neon store's claim is one INSERT ... ON CONFLICT DO NOTHING RETURNING, its answer the row count; the table is in the schema", async () => {
  const sent: { q: string; params: unknown[] | undefined }[] = [];
  let taken = false;
  const fake: LinkSql = {
    async query(q, params) {
      sent.push({ q, params });
      if (!/INSERT INTO bot_link_updates/.test(q)) return [];
      if (taken) return [];
      taken = true;
      return [{ update_id: params![0] }];
    },
  };
  const store = new NeonBotLinkStore(fake);
  assert.equal(await store.claimUpdate(1001, t0), true);
  assert.equal(await store.claimUpdate(1001, t0), false);
  assert.ok(sent.some((s) => /CREATE TABLE IF NOT EXISTS bot_link_updates \(update_id BIGINT PRIMARY KEY/.test(s.q)), "the table is created with the schema");
  const claims = sent.filter((s) => /INSERT INTO bot_link_updates/.test(s.q));
  assert.equal(claims.length, 2);
  assert.match(claims[0]!.q, /ON CONFLICT \(update_id\) DO NOTHING RETURNING update_id/);
  assert.deepEqual(claims[0]!.params, [1001, t0.toISOString()]);
  for (const s of sent) assert.ok(!/;\s*\S/.test(s.q), `one statement per query: ${s.q.slice(0, 40)}`);
});

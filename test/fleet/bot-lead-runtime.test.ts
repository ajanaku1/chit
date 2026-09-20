/** The lead route: session mode only, the wallet's own signature makes a wallet leader, a stale nonce is said before a signature is asked, a stranger and a replay are refused like the link route refuses. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryCopyStore, leadMessage } from "../../src/fleet/bot-copy.js";
import { issueNonce, MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { handleLeadRequest, setLeadDepsForTests } from "../../src/fleet/bot-lead-runtime.js";

const WHALE = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const t0 = new Date("2026-09-20T12:00:00Z");

const post = (body: unknown) => new Request("https://chit.tools/api/bot/lead", { method: "POST", headers: { "content-type": "application/json", origin: "https://chit.tools" }, body: JSON.stringify(body) });

test("outside session mode the route is 404; in session mode the wallet's signature makes a wallet leader for the nonce's telegram, a used nonce is said, a stranger is 403, a replay is 409, junk is 400, and cors answers the site", async () => {
  const links = new MemoryBotLinkStore();
  const leaders = new MemoryCopyStore();
  setLeadDepsForTests({ links, leaders });
  delete process.env.BOT_MODE;
  assert.equal((await handleLeadRequest(post({}), t0)).status, 404);
  process.env.BOT_MODE = "session";
  process.env.FLEET_CHAIN_ID = "4663";
  try {
    const preflight = await handleLeadRequest(new Request("https://chit.tools/api/bot/lead", { method: "OPTIONS", headers: { origin: "https://chit.tools" } }), t0);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://chit.tools");
    const nonce = await issueNonce(links, "9", t0);
    const fresh = await handleLeadRequest(new Request(`https://chit.tools/api/bot/lead?nonce=${nonce}`, { headers: { origin: "https://chit.tools" } }), t0);
    assert.deepEqual(await fresh.json(), { ok: true });
    const stale = await handleLeadRequest(new Request(`https://chit.tools/api/bot/lead?nonce=${nonce}`), new Date(t0.getTime() + 16 * 60_000));
    assert.deepEqual(await stale.json(), { ok: false, why: "expired" });
    const stranger = await handleLeadRequest(post({ nonce, wallet: WHALE.address, signature: await STRANGER.signMessage({ message: leadMessage(4663, WHALE.address, nonce) }), handle: "whale" }), t0);
    assert.equal(stranger.status, 403);
    assert.match(((await stranger.json()) as { error: string }).error, /not this wallet's: sign with the wallet you named/);
    const at = await handleLeadRequest(post({ nonce, wallet: WHALE.address, signature: await WHALE.signMessage({ message: leadMessage(4663, WHALE.address, nonce) }), handle: "@whale" }), t0);
    assert.equal(at.status, 400, "a page cannot prove a Telegram username");
    assert.equal((await links.getNonce(nonce))!.usedAt, null, "the refusals did not spend the nonce");
    const signature = await WHALE.signMessage({ message: leadMessage(4663, WHALE.address, nonce) });
    const r = await handleLeadRequest(post({ nonce, wallet: WHALE.address.toLowerCase(), signature, handle: " whale " }), t0);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://chit.tools");
    assert.deepEqual(await r.json(), { ok: true, wallet: WHALE.address, handle: "whale", chainId: 4663, since: t0.toISOString() });
    const leader = await leaders.getLeader("9");
    assert.equal(leader!.kind, "wallet");
    assert.equal(leader!.wallet, WHALE.address);
    assert.equal(leader!.account, WHALE.address);
    assert.ok(leader!.open);
    const used = await handleLeadRequest(new Request(`https://chit.tools/api/bot/lead?nonce=${nonce}`), t0);
    assert.deepEqual(await used.json(), { ok: false, why: "used" });
    const again = await handleLeadRequest(post({ nonce, wallet: WHALE.address, signature, handle: "whale" }), t0);
    assert.equal(again.status, 409);
    assert.equal((await handleLeadRequest(post("nope"), t0)).status, 400);
    assert.equal((await handleLeadRequest(new Request("https://chit.tools/api/bot/lead", { method: "PUT" }), t0)).status, 405);
    // Another telegram's nonce cannot claim the same wallet.
    const other = await issueNonce(links, "8", t0);
    const taken = await handleLeadRequest(post({ nonce: other, wallet: WHALE.address, signature: await WHALE.signMessage({ message: leadMessage(4663, WHALE.address, other) }), handle: "other" }), t0);
    assert.equal(taken.status, 409);
    assert.match(((await taken.json()) as { error: string }).error, /already leads for another telegram/);
    assert.equal(await leaders.getLeader("8"), undefined);
  } finally {
    delete process.env.BOT_MODE;
    delete process.env.FLEET_CHAIN_ID;
    setLeadDepsForTests({});
  }
});

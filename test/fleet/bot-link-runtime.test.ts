/** The link route: session mode only, the owner's signature links, a stale nonce is said before a signature is asked. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { issueNonce, linkMessage, MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { handleLinkRequest, setLinkDepsForTests } from "../../src/fleet/bot-link-runtime.js";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const t0 = new Date("2026-09-20T12:00:00Z");

const post = (body: unknown) => new Request("https://chit.tools/api/bot/link", { method: "POST", headers: { "content-type": "application/json", origin: "https://chit.tools" }, body: JSON.stringify(body) });

test("outside session mode the route is 404; in session mode the owner's signature links, a used nonce is said, a replay is 409, junk is 400", async () => {
  const links = new MemoryBotLinkStore();
  setLinkDepsForTests({ links, ownerOf: async (a) => (getAddress(a) === getAddress(ACCOUNT) ? OWNER.address : undefined) });
  delete process.env.BOT_MODE;
  assert.equal((await handleLinkRequest(post({}), t0)).status, 404);
  process.env.BOT_MODE = "session";
  process.env.FLEET_CHAIN_ID = "4663";
  try {
    const nonce = await issueNonce(links, "7", t0);
    const fresh = await handleLinkRequest(new Request(`https://chit.tools/api/bot/link?nonce=${nonce}`, { headers: { origin: "https://chit.tools" } }), t0);
    assert.deepEqual(await fresh.json(), { ok: true });
    const r = await handleLinkRequest(post({ nonce, account: ACCOUNT, signature: await OWNER.signMessage({ message: linkMessage(4663, ACCOUNT, nonce) }) }), t0);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://chit.tools");
    const j = (await r.json()) as { account: string; owner: string };
    assert.equal(j.account, getAddress(ACCOUNT));
    assert.equal(j.owner, OWNER.address);
    assert.equal((await links.getLink("7"))!.account, getAddress(ACCOUNT));
    const used = await handleLinkRequest(new Request(`https://chit.tools/api/bot/link?nonce=${nonce}`), t0);
    assert.deepEqual(await used.json(), { ok: false, why: "used" });
    const again = await handleLinkRequest(post({ nonce, account: ACCOUNT, signature: "0x" + "11".repeat(65) }), t0);
    assert.equal(again.status, 409);
    const bad = await handleLinkRequest(post("nope"), t0);
    assert.equal(bad.status, 400);
  } finally {
    delete process.env.BOT_MODE;
    delete process.env.FLEET_CHAIN_ID;
    setLinkDepsForTests({});
  }
});

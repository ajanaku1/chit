import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The Sessions page's two promises about keys, pinned: what it says a key
 * can do is what the contract lets it do, and the list of sessions (with
 * Pause, Resume and Revoke on it) survives an account from before the sell
 * flag existed.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): Promise<string> => readFile(join(appRoot, path), "utf8");

test("the page does not say a key without the sell flag can only buy: execute lets it call what its rules name, and a blank selector is any function of that contract", async () => {
  const html = await read("sessions.html");
  assert.doesNotMatch(html, /can only buy/, "the flag gates sell(); it does not make execute buy-only");
  assert.match(html, /What a key can do is what its rules name, with the account's ETH inside the caps/);
  assert.match(html, /any function of any contract you name if you leave the selector blank, a token's own transfer included/, "the risk of a blank selector is named where the flag is explained");
  assert.match(html, /without it the key cannot call sell, so the tokens the account holds go back to ETH only by your hand/);
  assert.match(html, /blank lets the key call any function of that contract/, "the grant form's own label says what blank means");
  const page = await read("src/sessions-page.ts");
  assert.match(page, /selectorRaw === "" \? ANY_FUNCTION : selectorRaw/, "blank is still any: the copy follows the code, not the other way round");
});

test("the session list reads the sell flag with a fallback: an account from before the flag has no sellAllowed, and its Pause, Resume and Revoke must still draw", async () => {
  const page = await read("src/sessions-page.ts");
  const guarded = /functionName: "sellAllowed", args: \[key\] \}\)\.then\(\(v\) => v as boolean, \(\) => undefined\)/;
  assert.match(page, guarded, "the read of sellAllowed answers undefined instead of rejecting, as the bot's own read (bot-session-chain.ts) does");
  assert.match(page, /state === "revoked" \|\| sells === undefined \? "disabled" : ""/, "on such an account the box is disabled: there is no setSellAllowed to send");
  assert.match(page, /let it sell: not on this account\. it was created before the flag existed, so no key can sell from it/, "and it says why");
  // The other reads on the card are of functions every account has, so no fallback hides a real failure there.
  const rules = page.indexOf('functionName: "rulesOf"');
  const sells = page.indexOf('functionName: "sellAllowed"');
  assert.ok(rules > 0 && sells > rules, "rulesOf is read first, unguarded, then sellAllowed guarded");
});

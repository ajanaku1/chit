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

test("the lead section: shown for ?lead=, it asks for a plain name and one signature over the lead message with the checksummed wallet, needs no account, posts to /api/bot/lead, and says what is copied from the wallet and what never is", async () => {
  const html = await read("sessions.html");
  assert.match(html, /id="lead-section" hidden/, "hidden until the bot's link opens it");
  assert.match(html, /No account, no session, no key handed over: connect that wallet and sign one message/);
  assert.match(html, /every ETH buy it makes on the venue is read from the chain within a few minutes, posted to the leaders' feed with its hash, and mirrored into your followers' own session accounts/);
  assert.match(html, /Your sells are never mirrored\. Close leader in the bot stops it any time; the wallet's own trades are never touched\./);
  assert.match(html, /letters, digits, spaces, _ \. - and up to 32; no @/, "the name's rule is on the label");
  assert.match(html, /a signature moves nothing/);
  assert.match(html, /<button id="lead-submit" type="submit" class="primary" disabled>Lead from this wallet<\/button>/, "capitalised like Link to the bot");
  const page = await read("src/sessions-page.ts");
  assert.match(page, /const leadNonce = linkParams\.get\("lead"\)/);
  assert.match(page, /`chit-bot-lead\|\$\{chainId\}\|\$\{getAddress\(walletAddress\)\}\|\$\{nonce\}`/, "the same text the desk recovers: chain id, checksummed wallet, nonce, pipe-separated");
  assert.match(page, /fetch\(`\$\{LEAD_API\}\?nonce=\$\{leadNonce\}`\)/, "freshness is asked before a signature");
  assert.match(page, /method: "personal_sign", params: \[message, wallet\]/);
  assert.match(page, /body: JSON\.stringify\(\{ nonce: leadNonce, wallet: getAddress\(wallet\), signature, handle \}\)/);
  assert.doesNotMatch(page.slice(page.indexOf("const leadNonce")), /if \(!deployed\)/, "leading needs no account: the wallet is the proof");
  assert.match(page, /if \(handle\.startsWith\("@"\)\) \{ note\.textContent = "No @ here/);
  assert.match(page, /Ask the bot for a new one \(⭐ Become a leader, from my own wallet\)/, "a stale link says how to get another");
});

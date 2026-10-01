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

/**
 * Found 2026-10-01 when the founder revoked the bot's key: the contract never
 * grants a key twice on one account (SessionExists), after a revoke or an
 * expiry alike, and the page gave each wallet one account. So a wallet whose
 * first session ended could never let the bot back in. A wallet now keeps any
 * number of accounts, the first at the address it always had.
 */
test("a wallet keeps several accounts: the first at its old address, each next one its own salt; the page lists them, picks one, and starts a new one", async () => {
  const html = await read("sessions.html");
  assert.match(html, /<select id="account-pick"/, "the accounts, to pick from");
  assert.match(html, /<button id="account-new" type="button" class="ghost"[^>]*>Start a new account<\/button>/);
  const page = await read("src/sessions-page.ts");
  assert.match(page, /functionName: "accountOf", args: \[wallet!?, accountSalt\(/, "every account's address from its own salt");
  assert.match(page, /encodeCreateAccount\(wallet, accountSalt\(index\)\)/, "the picked account is the one created");
  assert.match(page, /This key can't be granted on this account again/, "a spent key says why and what to do");
  assert.match(page, /start a new account to let it back in/i);
});

test("a grant for a key that already had a session on this account is refused before any transaction, in words; the default session is 30 days", async () => {
  const page = await read("src/sessions-page.ts");
  assert.match(page, /functionName: "sessionOf", args: \[key as Hex\] \}\)[\s\S]{0,200}already had a session on this account/);
  assert.match(page, /const BETA_GRANT = \{ perCall: "0\.05", cap: "0\.5", days: "30" \}/);
  assert.match(await read("sessions.html"), /<label for="grant-days">Valid for \(days\)<\/label>\s*<input id="grant-days"[^>]*value="30"/, "30 days however the page is opened");
});

/**
 * Tokens the bot bought sit in the account, and an account whose bot key is
 * spent can no longer sell through the bot; the owner's own way out for them
 * is withdrawToken, which the page now offers beside the ETH withdraw.
 */
test("a token withdraw: the token's address, what the account holds of it, an amount or all of it, to the connected wallet through withdrawToken", async () => {
  const html = await read("sessions.html");
  assert.match(html, /<form id="wtoken-form" class="withdraw-form">/);
  assert.match(html, /<input id="wtoken-address"[^>]*placeholder="0x…"/);
  assert.match(html, /<input id="wtoken-amount"[^>]*placeholder="all"/, "blank is all of it");
  assert.match(html, /<button id="wtoken-submit" type="submit" class="ghost" disabled>Withdraw token to my wallet<\/button>/);
  const page = await read("src/sessions-page.ts");
  assert.match(page, /const owner = wallet, from = account;[\s\S]{0,900}encodeWithdrawToken\(token as Hex, owner, units\)/, "to the connected wallet, the owner's");
  assert.match(page, /functionName: "balanceOf", args: \[account!?\]/, "what the account holds is read from the token");
  assert.match(page, /button\("wtoken-submit"\)\.disabled = !deployed/, "enabled with the account, like the ETH withdraw");
});

/**
 * The founder, 2026-10-01: "why is it asking for token ca, I should be able to
 * withdraw all tokens at once". The page finds what the account holds from the
 * chain itself and offers each, and all of them; the contract moves one token a
 * call, so "all" is one transaction per token, sent in a row and counted.
 */
test("the account's tokens are found on chain and listed with a withdraw each and a withdraw all; the address field stays for one the scan missed", async () => {
  const html = await read("sessions.html");
  assert.match(html, /<div id="wtoken-list"/, "the tokens the account holds");
  assert.match(html, /<button id="wtoken-all" type="button" class="ghost" disabled>Withdraw all tokens to my wallet<\/button>/);
  assert.match(html, /<details[^>]*>\s*<summary>A token not listed\?<\/summary>/, "the address field, folded");
  const page = await read("src/sessions-page.ts");
  assert.match(page, /event: TRANSFER, args: \{ to: acct \}/, "every token sent to the account, from the chain's own logs");
  assert.match(page, /const SPAN = 30_000n;/, "in pieces the public RPC takes without a token filter");
  assert.match(page, /event: ACCOUNT_CREATED, args: \{ account: acct \}/, "from the account's creation, not the chain's start");
  assert.match(page, /localStorage\.setItem\(scanStorage\(acct\)/, "and only the blocks since, next time");
  assert.match(page, /for \(const \[n, t\] of held\.entries\(\)\)[\s\S]{0,400}encodeWithdrawToken\(t\.token, owner, t\.units\)/, "all: one withdrawToken per token, in a row");
  assert.match(page, /`\$\{n \+ 1\} of \$\{held\.length\}/, "and the count as it goes");
});

/**
 * The founder, 2026-10-01: why are the contract and the function editable
 * boxes when they are filled in for you? For the Chit bot they are always the
 * router and its execute, and a typo or a blank selector is a risk, not a
 * choice. They are read-only; the bot's key is too once the bot's link fills
 * it; the caps and the days stay the user's.
 */
test("the contract and the function are not fields at all: one plain line says what the key can do, the exact values are folded under Details; the bot's key is fixed once the bot's link fills it; the caps and the days stay editable", async () => {
  const html = await read("sessions.html");
  assert.match(html, /<input id="grant-target" name="target" type="hidden" \/>/, "the contract cannot be changed, nor seen as a box");
  assert.match(html, /<input id="grant-selector" name="selector" type="hidden" \/>/, "nor the function");
  assert.match(html, /The bot can only swap, through the Uniswap router, within the limits below\./);
  assert.match(html, /<summary>Details<\/summary>[\s\S]{0,300}0x8876789976decbfcbbbe364623c63652db8c0904/, "the exact contract, for whoever checks");
  for (const id of ["grant-per-call", "grant-cap", "grant-days"]) assert.doesNotMatch(html, new RegExp(`<input id="${id}"[^>]*readonly`), `${id} stays the user's`);
  const page = await read("src/sessions-page.ts");
  assert.match(page, /input\("grant-key"\)\.value \|\|= linkKey;\s*input\("grant-key"\)\.readOnly = true;/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * One wallet button, one owner.
 *
 * `initHeaderWallet` owns `#hdr-wallet` on every page. A page that also binds a
 * click to it fires two `eth_requestAccounts` at once, which wallets refuse
 * ("already processing"), so connecting appears to fail for no visible reason.
 * Pages react to the wallet through the `chit-wallet-changed` event instead.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGES = ["balance-page.ts", "fleet-page.ts", "fleet-dashboard.ts"];
/** Every page that sends actions, including the trade page, which has its own wallet flow. */
const ROUTED_PAGES = [...PAGES, "trade-page.ts"];

const source = (name: string): Promise<string> => readFile(join(appRoot, "src", name), "utf8");

test("no page binds its own click to the shared header wallet button", async () => {
  for (const page of PAGES) {
    const text = await source(page);
    assert.doesNotMatch(
      text,
      /el\(\s*["']hdr-wallet["']\s*\)\s*\.addEventListener|getElementById\(\s*["']hdr-wallet["']\s*\)\s*\.addEventListener/,
      `${page} binds #hdr-wallet, which initHeaderWallet already owns`,
    );
  }
});

test("every page that needs a wallet reacts when one connects", async () => {
  for (const page of PAGES) {
    const text = await source(page);
    assert.match(
      text,
      /addEventListener\(\s*["']chit-wallet-changed["']/,
      `${page} never notices the wallet connecting, so it stays empty`,
    );
  }
});

test("reacting to a wallet never asks for one again", async () => {
  // Only the wizard initiates a connection, from its own step button. The other
  // pages follow the header, so a reference to connectWallet there would mean a
  // second prompt for a wallet the trader has already granted.
  for (const page of ["balance-page.ts", "fleet-dashboard.ts"]) {
    const text = await source(page);
    assert.doesNotMatch(text, /connectWallet/, `${page} initiates its own connection`);
  }

  const wizard = await source("fleet-page.ts");
  const at = wizard.indexOf('"chit-wallet-changed"');
  assert.ok(at > 0, "the wizard does not react to wallet changes");
  assert.doesNotMatch(
    wizard.slice(at, at + 400),
    /connectWallet\s*\(/,
    "the wizard asks for a wallet while reacting to one that just connected",
  );
});

test("the header wallet control is on every page that listens for it", async () => {
  for (const html of ["balance.html", "fleet.html", "fleet-dashboard.html"]) {
    const text = await readFile(join(appRoot, html), "utf8");
    assert.match(text, /id="hdr-wallet"/, `${html} has no wallet control`);
  }
});

/**
 * One wallet for every call. Signing a challenge, sending a deposit and signing
 * the backup must reach the same wallet that connected; a module that reads
 * window.ethereum itself talks to whichever wallet won the injection race.
 */
test("no page talks to window.ethereum behind the chosen wallet's back", async () => {
  const shared = await source("fleet/page-shared.ts");
  assert.match(shared, /addEventListener\(\s*["']eip6963:announceProvider["']/, "wallets are never discovered");
  assert.match(shared, /dispatchEvent\(new Event\(\s*["']eip6963:requestProvider["']/, "installed wallets are never asked to announce");
  for (const name of ["fleet/signed-request.ts", "balance-page.ts", "fleet-page.ts"]) {
    const text = await source(name);
    assert.doesNotMatch(text, /\.ethereum\b/, `${name} reads window.ethereum itself`);
    assert.match(text, /walletProvider\(\)/, `${name} does not go through walletProvider()`);
  }
});

test("with more than one wallet installed, connecting asks which one", async () => {
  const shared = await source("fleet/page-shared.ts");
  const connect = /export const connectWallet[\s\S]*?\n\};/.exec(shared);
  assert.ok(connect, "no connectWallet to inspect");
  assert.match(connect![0], /chooseWallet\(/, "connectWallet picks for the trader when several wallets are installed");
});

/**
 * Closing the chooser while a wallet popup is still open must not throw away
 * an approval the trader then gives in the wallet: the wallet would be
 * connected while the page still says Connect.
 */
test("closing the chooser mid-connect still honours a later wallet approval", async () => {
  const shared = await source("fleet/page-shared.ts");
  const chooser = /const chooseWallet[\s\S]*?\n  \}\);/.exec(shared);
  assert.ok(chooser, "no chooseWallet to inspect");
  assert.match(chooser![0], /finish\(\s*inFlight/, "cancelling mid-connect discards the attempt still in flight");
});

/**
 * The pool exists only on 46630. A wallet switched to another network after
 * connecting would send the deposit there, to an address with no pool behind it.
 */
test("no transaction is sent before the wallet is confirmed on Robinhood testnet", async () => {
  const text = await source("balance-page.ts");
  const send = /const sendToPool[\s\S]*?\n\};/.exec(text);
  assert.ok(send, "no sendToPool to inspect");
  const guard = send![0].indexOf("ensureRobinhoodTestnet(");
  assert.ok(
    guard > 0 && guard < send![0].indexOf("eth_sendTransaction"),
    "sendToPool sends on whatever network the wallet happens to be on",
  );
});

/**
 * A failed connect from the header must be visible. `connectWallet` dispatches
 * `chit-wallet-error` when no wallet is installed, and throws when the trader
 * rejects the account prompt or the network switch — a header click that only
 * does `.catch(() => undefined)` discards every one of those with no trace, so
 * the button looks broken instead of telling the trader why.
 */
test("the header button surfaces a failed connect instead of discarding it", async () => {
  const text = await source("fleet/page-shared.ts");
  assert.doesNotMatch(
    text,
    /connectWallet\(\)\.catch\(\(\)\s*=>\s*undefined\)/,
    "the header click handler still swallows a failed connect silently",
  );
  assert.match(
    text,
    /addEventListener\(\s*["']chit-wallet-error["']/,
    "initHeaderWallet never listens for chit-wallet-error, so no failure reaches the trader",
  );
});

/**
 * A connected trader reaches for the header button to see or copy their
 * address. Disconnecting on that click drops the wallet they meant to use.
 */
test("clicking the connected header button opens a menu instead of disconnecting", async () => {
  const header = /export const initHeaderWallet[\s\S]*?\n\};/.exec(await source("fleet/page-shared.ts"));
  assert.ok(header, "no initHeaderWallet to inspect");
  const click = /button\.addEventListener\("click", \(\) => \{[\s\S]*?\n {2}\}\);/.exec(header[0]);
  assert.ok(click, "no header click handler to inspect");
  assert.doesNotMatch(click[0], /disconnectWallet\(/, "a click on the connected button still disconnects straight away");
  assert.match(header[0], /"Copy address"/, "the wallet menu offers no way to copy the address");
  assert.match(header[0], /clipboard\.writeText\(address\)/, "copying does not copy the connected address");
  assert.match(
    header[0],
    /disconnect\.addEventListener\("click"[\s\S]{0,120}disconnectWallet\(\)/,
    "disconnecting is not its own choice in the menu",
  );
});

test("the disconnected header button says Connect wallet", async () => {
  for (const html of ["balance.html", "fleet.html", "trade.html", "fleet-dashboard.html", "fleet-privacy.html"]) {
    const text = await readFile(join(appRoot, html), "utf8");
    assert.match(text, /id="hdr-wallet"[^>]*>Connect wallet</, `${html} labels the wallet button something else`);
  }
  assert.match(
    await source("fleet/page-shared.ts"),
    /button\.textContent = "Connect wallet"/,
    "after a disconnect the button goes back to a different label",
  );
});

/**
 * Every action the pages can send must be allowed by the route they send it to.
 * A mismatch answers 409 with no clue which side is wrong, and only shows up
 * when a trader clicks the one button nobody tried.
 */

const repoRoot = dirname(appRoot);

/**
 * Read from the app, not restated: a mapping copied here agreed with a wrong
 * app for a whole afternoon while "trade" went to the campaign function.
 */
const routeFor = async (action: string): Promise<string> => {
  const shared = await source("fleet/page-shared.ts");
  const start = shared.indexOf("const route = ");
  const mapping = shared.slice(start, shared.indexOf(";", start));
  for (const [, list, route] of mapping.matchAll(/\[([^\]]+)\]\.includes\(action\)\s*\?\s*"([a-z]+)"/g)) {
    if ([...list!.matchAll(/"([a-z]+)"/gi)].some((m) => m[1] === action)) return route!;
  }
  for (const [, single, route] of mapping.matchAll(/action === "([a-z]+)"\s*\?\s*"([a-z]+)"/gi)) {
    if (single === action) return route!;
  }
  return "campaign";
};

test("each action the app sends is allowed by the route it goes to", async () => {
  const allowed = new Map<string, string[]>();
  for (const route of ["campaign", "balance", "buy", "control", "trade"]) {
    const text = await readFile(join(repoRoot, "api/fleet", `${route}.js`), "utf8");
    const list = /handleFleetRequest\(request,\s*\[([^\]]*)\]/.exec(text);
    assert.ok(list, `${route}.js does not declare its allowed actions`);
    allowed.set(route, [...list![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
  }

  const sources = await Promise.all(ROUTED_PAGES.map((page) => source(page)));
  const sent = new Set<string>(["challenge"]);
  for (const text of sources) {
    for (const match of text.matchAll(/(?:signedFleetApi|readSigned)\([^,]+,\s*"([a-zA-Z]+)"/g)) sent.add(match[1]!);
    for (const match of text.matchAll(/next\[action\]|data-action="([a-zA-Z]+)"/g)) {
      if (match[1]) sent.add(match[1]);
    }
  }
  for (const action of ["pause", "resume", "revoke", "close", "topUp"]) sent.add(action);

  for (const action of sent) {
    const route = await routeFor(action);
    assert.ok(
      allowed.get(route)!.includes(action),
      `the app sends "${action}" to /api/fleet/${route}, which allows only ${allowed.get(route)!.join(", ")}`,
    );
  }
});

/**
 * A wallet connected from the header must leave the wizard in the same state as
 * one connected from its own button. Two routes that prepare different amounts
 * of state is how a connected trader still gets asked to connect.
 */
test("the wizard prepares the same state however the wallet arrived", async () => {
  const wizard = await source("fleet-page.ts");
  const connect = /async #connect\(\)[\s\S]*?\n  \}/.exec(wizard);
  assert.ok(connect, "no #connect to inspect");
  assert.match(connect![0], /#adopt\(/, "#connect does not go through the shared route");

  const adopt = /async #adopt\([\s\S]*?\n  \}/.exec(wizard);
  assert.ok(adopt, "no #adopt to inspect");
  for (const step of ["wallet-line", "#setup.connect", '#go("size")']) {
    assert.ok(adopt![0].includes(step), `adopting a wallet skips ${step}`);
  }
});

/**
 * Somewhere to go. A page that tells a trader to add ETH "on the Balance page"
 * has to offer a way there, or the instruction is a dead end.
 */
test("every fleet page can reach the Balance page", async () => {
  for (const page of ["fleet.html", "fleet-dashboard.html", "fleet-privacy.html", "balance.html"]) {
    const html = await readFile(join(appRoot, page), "utf8");
    assert.match(html, /href="\.\/balance\.html"/, `${page} has no way to reach the Balance page`);
  }
});

test("a blocked launch links to the page that unblocks it", async () => {
  const html = await readFile(join(appRoot, "fleet.html"), "utf8");
  const step = /data-wstep="launch"[\s\S]*?<\/section>/.exec(html);
  assert.ok(step, "no launch step to inspect");
  assert.match(step![0], /href="\.\/balance\.html"/, "the launch step names the Balance page but does not link it");
});

/**
 * A remembered wallet fires no connect event on load, so a page that only
 * listens for the event keeps asking. Every page must also look at start-up.
 */
test("every page takes up a remembered wallet on load, not only on the event", async () => {
  for (const page of PAGES) {
    const text = await source(page);
    // Either the load path reads the wallet and hands it on, or it calls a
    // refresh that reads the wallet itself. Both take the wallet up on load.
    const direct = /getConnectedWallet\(\)[\s\S]{0,120}(#adopt|onWalletChanged)\(/.test(text);
    const viaRefresh =
      /start\(\): void \{[\s\S]*?void this\.#refresh\(\)/.test(text) &&
      /async #refresh\([^)]*\)[\s\S]{0,200}getConnectedWallet\(\)/.test(text);
    assert.ok(direct || viaRefresh, `${page} does not take up an already-connected wallet when it loads`);
  }
});

/**
 * Reading the balance costs a wallet signature. Three pages each signing on
 * every load is what a trader experiences as "connect again on every tab". One
 * cached read serves them all; only an explicit refresh signs again.
 */
test("no page signs for a balance directly; they share one cached read", async () => {
  for (const page of PAGES) {
    const text = await source(page);
    assert.doesNotMatch(
      text,
      /signedFleetApi\([^)]*"balance"/,
      `${page} signs for the balance itself instead of using the shared cached read`,
    );
    if (/readBalance\(/.test(text)) continue;
    assert.fail(`${page} never reads the balance at all`);
  }
});

/**
 * The Trade page reads the trader's fleets and holdings every time it opens.
 * Signed afresh, that is a wallet prompt on every visit to the tab.
 */
test("the Trade page's load reads come from the shared cached signed read", async () => {
  const text = await source("trade-page.ts");
  for (const action of ["list", "holdings"]) {
    assert.match(text, new RegExp(`readSigned\\(wallet, "${action}"`), `the Trade page does not read "${action}" through the cache`);
  }
  const onWallet = /async #onWallet\(\)[\s\S]*?\n  \}/.exec(text);
  const holdings = /async #holdings\([^)]*\)[\s\S]*?\n  \}/.exec(text);
  assert.ok(onWallet && holdings, "no load path to inspect");
  for (const body of [onWallet[0], holdings[0]]) {
    assert.doesNotMatch(body, /signedFleetApi\(/, "the Trade page signs on load, so every visit prompts");
  }
  const poll = /async #pollOnce\([^)]*\)[\s\S]*?\n  \}/.exec(text);
  assert.ok(poll && /forgetSignedReads\(wallet\)/.test(poll[0]), "a trade leaves the cached fleets and holdings stale");
  for (const page of ["fleet-page.ts", "fleet-dashboard.ts"]) {
    assert.match(await source(page), /forgetSignedReads\(/, `${page} changes a fleet but leaves the cached list stale`);
  }
});

/** The Control Room reads each wallet's holdings on every load and every funding poll. */
test("the Control Room's holdings come from the shared cached signed read", async () => {
  const portfolio = /async #portfolio\([\s\S]*?\n  \}/.exec(await source("fleet-dashboard.ts"));
  assert.ok(portfolio, "no holdings read to inspect");
  assert.match(portfolio[0], /readSigned\(wallet, "holdings"/, "the Control Room does not read holdings through the cache");
  assert.doesNotMatch(portfolio[0], /signedFleetApi\(/, "the Control Room signs on every load and every poll");
});

/**
 * A fleet created but never activated exists only in the memory of the service
 * instance that made it. Once that instance is gone the campaign cannot be
 * read, and a dashboard that keeps a stale snapshot signs for it on every load
 * and fails: a wallet prompt every time the trader opens the tab, for nothing.
 */
test("the dashboard forgets a campaign the service can no longer find", async () => {
  const text = await source("fleet-dashboard.ts");
  assert.match(text, /clearFleetSnapshot\(/, "a campaign that cannot be read is never cleared");
  assert.match(
    text,
    /RequestFailed/,
    "the dashboard swallows every failure alike, so it cannot tell a lost campaign from a hiccup",
  );
});

/**
 * Watching a fleet must be free. Polling with a signed read means a wallet
 * prompt every few seconds, which is what a trader experiences as being asked
 * to sign the same thing over and over.
 */
test("pages watch a campaign with the unsigned status read, not a signed one", async () => {
  for (const page of ["fleet-page.ts", "fleet-dashboard.ts"]) {
    const text = await source(page);
    assert.doesNotMatch(
      text,
      /signedFleetApi\([^)]*"read"/,
      `${page} signs to watch a campaign; polling would prompt on every tick`,
    );
    assert.match(text, /readStatus\(/, `${page} never reads the campaign's status`);
  }
});

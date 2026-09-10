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
 * Every action the pages can send must be allowed by the route they send it to.
 * A mismatch answers 409 with no clue which side is wrong, and only shows up
 * when a trader clicks the one button nobody tried.
 */

const repoRoot = dirname(appRoot);

const routeFor = (action: string): string => {
  if (["pause", "resume", "revoke", "close"].includes(action)) return "control";
  if (["balance", "withdraw"].includes(action)) return "balance";
  if (action === "buy") return "buy";
  return "campaign";
};

test("each action the app sends is allowed by the route it goes to", async () => {
  const allowed = new Map<string, string[]>();
  for (const route of ["campaign", "balance", "buy", "control"]) {
    const text = await readFile(join(repoRoot, "api/fleet", `${route}.js`), "utf8");
    const list = /handleFleetRequest\(request,\s*\[([^\]]*)\]/.exec(text);
    assert.ok(list, `${route}.js does not declare its allowed actions`);
    allowed.set(route, [...list![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
  }

  const sources = await Promise.all(PAGES.map((page) => source(page)));
  const sent = new Set<string>(["challenge"]);
  for (const text of sources) {
    for (const match of text.matchAll(/signedFleetApi\([^,]+,\s*"([a-zA-Z]+)"/g)) sent.add(match[1]!);
    for (const match of text.matchAll(/next\[action\]|data-action="([a-zA-Z]+)"/g)) {
      if (match[1]) sent.add(match[1]);
    }
  }
  for (const action of ["pause", "resume", "revoke", "close", "topUp"]) sent.add(action);

  for (const action of sent) {
    const route = routeFor(action);
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
      /async #refresh\(\)[\s\S]{0,200}getConnectedWallet\(\)/.test(text);
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

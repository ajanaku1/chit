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

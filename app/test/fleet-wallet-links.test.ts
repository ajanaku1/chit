import assert from "node:assert/strict";
import test from "node:test";

import { isPhone, walletAppLinks } from "../src/fleet/wallet-links.js";

/**
 * A phone with no wallet in its browser is offered the wallet apps, not an
 * install hint for an extension it cannot run. Each link has to carry the page
 * the trader was on, so the wallet's browser opens it and not the home page.
 */

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const PAGE = "https://app.chit.tools/app/trade?fleet=3";

test("a phone is a phone; a desktop is not", () => {
  assert.equal(isPhone(IPHONE), true);
  assert.equal(isPhone(ANDROID), true);
  assert.equal(isPhone(MAC), false);
});

test("an iPad that calls itself a Mac is still a phone when it has a touch screen", () => {
  assert.equal(isPhone(MAC, 5), true);
  assert.equal(isPhone(MAC, 0), false);
});

test("every wallet app link carries the page the trader was on", () => {
  const links = walletAppLinks(PAGE);
  assert.deepEqual(links.map((link) => link.name), ["MetaMask", "Coinbase Wallet", "Trust Wallet", "Phantom"]);
  for (const link of links) {
    assert.ok(decodeURIComponent(link.href).includes("app.chit.tools/app/trade?fleet=3"), `${link.name} loses the page: ${link.href}`);
    assert.match(link.href, /^https:\/\//, `${link.name} is not a universal link`);
  }
});

test("MetaMask takes the page without its scheme, the others take it whole and encoded", () => {
  const [metamask, coinbase] = walletAppLinks(PAGE);
  assert.equal(metamask?.href, "https://metamask.app.link/dapp/app.chit.tools/app/trade?fleet=3");
  assert.equal(coinbase?.href, `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(PAGE)}`);
});

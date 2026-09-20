/**
 * The token plate: the partners' reads in words and colours, the marks in
 * their tiles, and the real renderer drawing a PNG of the plate's size in
 * the shipped fonts. A partner that did not answer is drawn as unknown, never
 * as a clean bill; a partner that is not configured is not on the plate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTokenPlateRenderer, heyPlateLine, orusPlateLine, PLATE_HEIGHT, PLATE_WIDTH, tokenPlateSvg, type TokenPlate } from "../../src/fleet/bot-token-card.js";

const base: TokenPlate = { symbol: "PEPE", address: "0x1111111111111111111111111111111111111111", perEth: "1000000", poolEth: "5", hooked: false, chainLabel: "robinhood chain", testnet: true };

test("orus: a clean scan reads green, a honeypot reads coral, a null read is unknown and says so", () => {
  const scan = { symbol: "PEPE", honeypot: false, buyTaxPct: 0, sellTaxPct: 0, bundlersPct: 3.5, top10Pct: 22, holders: 1234, liquidityUsd: null, lpBurnedPct: null, marketCapUsd: null, deployerLaunches: null, checkedAt: "2026-09-20T00:00:00Z" };
  const clean = orusPlateLine(scan);
  assert.equal(clean.verdict, "no honeypot");
  assert.equal(clean.colour, "#4BD37B");
  assert.equal(clean.detail, "tax 0/0 · bundled 3.5% · top 10 hold 22% · 1,234 holders");
  const trap = orusPlateLine({ ...scan, symbol: null, honeypot: true, buyTaxPct: 10, sellTaxPct: 99, bundlersPct: null, top10Pct: null, holders: null });
  assert.equal(trap.verdict, "honeypot");
  assert.equal(trap.colour, "#FF5A3C");
  const none = orusPlateLine(null);
  assert.equal(none.verdict, "no read right now");
  assert.match(none.detail, /unknown is not safe/);
  assert.equal(orusPlateLine(undefined).verdict, "not configured");
});

test("hey: shipping reads green with the thirty-day counts, a missing field is left out, no record is unknown", () => {
  const ship = heyPlateLine({ statusLabel: "Shipping", verifiedBuilder: true, commits30d: 204, releases30d: 1, ships30d: null, lastShip: null, projectName: "x", url: "https://heyresearch.xyz/p/x" });
  assert.equal(ship.verdict, "shipping");
  assert.equal(ship.colour, "#4BD37B");
  assert.equal(ship.detail, "204 commits · 1 release · verified builder · last 30 days");
  const quiet = heyPlateLine({ statusLabel: "Still Building", verifiedBuilder: null, commits30d: null, releases30d: null, ships30d: null, lastShip: null, projectName: null, url: "u" });
  assert.equal(quiet.verdict, "still building");
  assert.equal(quiet.detail, "", "nothing is zeroed");
  assert.equal(heyPlateLine(null).verdict, "no record");
});

test("the svg names the chain and the mode, carries both partner rows with their marks, and escapes what it prints", () => {
  const svg = tokenPlateSvg({ ...base, symbol: "A<B", orus: null, hey: null }, { orus: "data:image/png;base64,AAAA", hey: "data:image/png;base64,BBBB" });
  assert.match(svg, /CHIT BOT<\/tspan><tspan[^>]*> · ROBINHOOD CHAIN · TESTNET/);
  assert.match(svg, /\$A&lt;B/, "the symbol is escaped");
  assert.match(svg, /href="data:image\/png;base64,AAAA"/, "orus's mark");
  assert.match(svg, /href="data:image\/png;base64,BBBB"/, "hey's mark");
  assert.match(svg, /CHECKED BY.*orus.*no read right now/s);
  assert.match(svg, /BUILDER RECORD.*hey research lab.*no record/s);
  const mainnet = tokenPlateSvg({ ...base, testnet: false, hooked: true });
  assert.match(mainnet, /YOUR KEYS STAY WITH YOU/);
  assert.match(mainnet, /hooked pool/);
  assert.doesNotMatch(mainnet, /<image/, "no marks given, plain tiles");
});

test("the real renderer draws a PNG of the plate's size with the shipped marks; a missing mark draws a tile, a missing font is an error", async () => {
  const render = createTokenPlateRenderer();
  const png = await render({ ...base, orus: null, hey: null });
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(view.getUint32(16), PLATE_WIDTH);
  assert.equal(view.getUint32(20), PLATE_HEIGHT);
  assert.ok(png.byteLength > 20_000, "the marks are in it");
  const missing = createTokenPlateRenderer("landing/public/nowhere");
  await assert.rejects(missing(base), /ENOENT/, "no fonts, no card");
});

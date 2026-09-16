import assert from "node:assert/strict";
import test from "node:test";

import { decodeSlot0, estimateOut, poolIdFor, quoteExactIn, slot0Slot } from "../../src/fleet/market.js";
import { NATIVE_ETH, VENUE_POOL, venuePoolKey } from "../../src/fleet/v4-swap.js";

/** The seeded venue pool on 46630, from deployments/fleet-46630.json. */
const VENUE_TOKEN = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554";
const VENUE_SQRT = 2505414483750479311864138015696n;

test("the pool id is the keccak of the venue key, with ETH as currency0", () => {
  const key = venuePoolKey(VENUE_TOKEN);
  assert.equal(key.currency0, NATIVE_ETH);
  assert.equal(key.fee, VENUE_POOL.fee);
  const id = poolIdFor(VENUE_TOKEN);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.notEqual(poolIdFor("0x0000000000000000000000000000000000000001"), id);
});

test("slot0 lives at keccak(poolId, 6), the StateLibrary layout", () => {
  const id = poolIdFor(VENUE_TOKEN);
  assert.match(slot0Slot(id), /^0x[0-9a-f]{64}$/);
  assert.notEqual(slot0Slot(id), id);
});

test("slot0 decodes the price from the low 160 bits and the tick above it", () => {
  const tick = 100n;
  const word = `0x${((tick << 160n) | VENUE_SQRT).toString(16).padStart(64, "0")}` as const;
  const decoded = decodeSlot0(word);
  assert.equal(decoded.sqrtPriceX96, VENUE_SQRT);
  assert.equal(decoded.tick, 100);
  const negative = `0x${((((1n << 24n) - 5n) << 160n) | VENUE_SQRT).toString(16).padStart(64, "0")}` as const;
  assert.equal(decodeSlot0(negative).tick, -5);
});

test("an empty slot0 means no pool, and an estimate follows the square of the price", () => {
  assert.equal(decodeSlot0(`0x${"0".repeat(64)}`).sqrtPriceX96, 0n);
  const out = estimateOut(10n ** 15n, VENUE_SQRT);
  assert.ok(out > 0n);
  const doubled = estimateOut(2n * 10n ** 15n, VENUE_SQRT);
  assert.ok(doubled - out * 2n <= 1n && out * 2n - doubled <= 1n, "doubling the input doubles the estimate, to a wei of truncation");
  assert.equal(estimateOut(10n ** 15n, 0n), 0n);
});

test("a quote with liquidity follows the pool's curve: more in, less out per wei, and never above the spot estimate", () => {
  // The venue pool on 46630 as read on 2026-09-16: ~0.006 ETH of depth. A
  // 0.0002 ETH buy moves it about 3%; the spot estimate ignores that and
  // every buy came back V4TooLittleReceived. The quote must include it.
  const L = 158113883008418966n;
  const sqrtP = 2088889848049424137305055772769n;
  const small = quoteExactIn(2n * 10n ** 14n, sqrtP, L);
  const spot = estimateOut(2n * 10n ** 14n, sqrtP);
  assert.ok(small < spot, "impact makes the real output lower than spot");
  const impact = Number(spot - small) / Number(spot);
  assert.ok(impact > 0.03 && impact < 0.035, `about 3.2% impact on this pool, got ${(impact * 100).toFixed(2)}%`);
  const big = quoteExactIn(10n ** 15n, sqrtP, L);
  assert.ok(big < 5n * small, "five times the input buys less than five times the output");
  assert.equal(quoteExactIn(2n * 10n ** 14n, sqrtP, 0n), spot, "without a liquidity reading the spot estimate stands");
});

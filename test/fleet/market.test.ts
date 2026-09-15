import assert from "node:assert/strict";
import test from "node:test";

import { decodeSlot0, estimateOut, poolIdFor, slot0Slot } from "../../src/fleet/market.js";
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

test("an exact-in quote includes the fee and the price impact, and shrinks toward spot as the trade shrinks", async () => {
  const { quoteExactIn, liquiditySlot } = await import("../../src/fleet/market.js");
  const { parseEther } = await import("viem");
  // A pool priced at 1000 tokens per ETH with 0.02 ETH of full-range liquidity, as the fork tests seed it.
  const isqrt = (n: bigint): bigint => { let x = n, y = (n + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
  const sqrtP = isqrt(1000n * 2n ** 192n);
  const liquidity = isqrt(parseEther("0.02") * parseEther("20"));
  const spot = estimateOut(parseEther("0.001"), sqrtP);
  const fill = quoteExactIn(parseEther("0.001"), sqrtP, liquidity, true, 3000);
  assert.ok(fill < spot, "the fill is below spot: fee plus impact");
  assert.ok(fill > (spot * 90n) / 100n, "a 5% trade on the pool costs under 10%");
  const tiny = quoteExactIn(parseEther("0.000001"), sqrtP, liquidity, true, 3000);
  const tinySpot = estimateOut(parseEther("0.000001"), sqrtP);
  assert.ok(tiny > (tinySpot * 996n) / 1000n && tiny < tinySpot, "a tiny trade pays only the 0.3% fee");
  // The other way round, at the same pool state: tokens in, ETH out, paying fee and impact a second time.
  const back = quoteExactIn(fill, sqrtP, liquidity, false, 3000);
  assert.ok(back < parseEther("0.001") && back > parseEther("0.0008"), `a round trip at one state loses fee and impact twice: ${back}`);
  assert.equal(quoteExactIn(1n, sqrtP, 0n, true, 3000), 0n, "no liquidity, no fill");
  assert.notEqual(liquiditySlot(`0x${"11".repeat(32)}`), slot0Slot(`0x${"11".repeat(32)}`));
});

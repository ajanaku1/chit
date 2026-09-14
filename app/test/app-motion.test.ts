import assert from "node:assert/strict";
import test from "node:test";

import { countTo, easeOut } from "../src/fleet/motion.js";

test("easing starts at rest, lands exactly, and never goes backwards", () => {
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  let last = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const value = easeOut(t);
    assert.ok(value >= last);
    last = value;
  }
});

test("with reduced motion a figure goes straight to its value", () => {
  const seen: number[] = [];
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
  countTo((value) => seen.push(value), 0, 0.05);
  assert.deepEqual(seen, [0.05]);
});

test("a figure that has not changed is drawn once, not animated", () => {
  const seen: number[] = [];
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false });
  countTo((value) => seen.push(value), 0.05, 0.05);
  assert.deepEqual(seen, [0.05]);
});

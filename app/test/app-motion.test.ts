import assert from "node:assert/strict";
import test from "node:test";

import { countTo, easeOut, revealOnEnter } from "../src/fleet/motion.js";

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

/** Counts frame requests instead of running them, so a test can see whether countTo animated at all. */
const stubFrames = (): { count: () => number; restore: () => void } => {
  const g = globalThis as { requestAnimationFrame?: unknown };
  const previous = g.requestAnimationFrame;
  let requested = 0;
  g.requestAnimationFrame = () => {
    requested += 1;
    return requested;
  };
  return { count: () => requested, restore: () => { g.requestAnimationFrame = previous; } };
};

test("with reduced motion a figure goes straight to its value and never asks for a frame", () => {
  const seen: number[] = [];
  const frames = stubFrames();
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
  countTo((value) => seen.push(value), 0, 0.05);
  assert.deepEqual(seen, [0.05]);
  assert.equal(frames.count(), 0);
  frames.restore();
});

test("a figure that has not changed is drawn once, not animated", () => {
  const seen: number[] = [];
  const frames = stubFrames();
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false });
  countTo((value) => seen.push(value), 0.05, 0.05);
  assert.deepEqual(seen, [0.05]);
  assert.equal(frames.count(), 0);
  frames.restore();
});

test("a changed figure asks for a frame before drawing anything", () => {
  const seen: number[] = [];
  const frames = stubFrames();
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false });
  countTo((value) => seen.push(value), 0, 0.05);
  assert.equal(frames.count(), 1);
  assert.deepEqual(seen, []);
  frames.restore();
});

test("reveals watch for the very edge of the viewport, not some margin into it", () => {
  const g = globalThis as { document?: unknown; matchMedia?: unknown; IntersectionObserver?: unknown };
  const previous = { document: g.document, matchMedia: g.matchMedia, IntersectionObserver: g.IntersectionObserver };
  g.document = { documentElement: { classList: { add() {} } } };
  g.matchMedia = () => ({ matches: false });
  let threshold: number | undefined;
  g.IntersectionObserver = class {
    constructor(_callback: unknown, options: { threshold: number }) {
      threshold = options.threshold;
    }
    observe(): void {}
    unobserve(): void {}
  };
  revealOnEnter({ querySelectorAll: () => [] } as unknown as ParentNode);
  assert.equal(threshold, 0);
  g.document = previous.document;
  g.matchMedia = previous.matchMedia;
  g.IntersectionObserver = previous.IntersectionObserver;
});

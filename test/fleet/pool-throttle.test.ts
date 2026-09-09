import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSweepGate } from "../../src/fleet/pool-buy.js";

/**
 * Every request sweeping is what makes a fleet fund itself without a cron, but
 * a sweep re-reads every draw and every queued charge. Doing that on each of
 * several page loads a second is what exhausts a public RPC, and a failed read
 * takes the whole request down with it.
 */
describe("Sweep throttle", () => {
  it("lets the first sweep through and holds the rest for the interval", () => {
    let clock = 1_000_000;
    const gate = createSweepGate(10_000, () => clock);

    assert.equal(gate(), true, "the first caller sweeps");
    assert.equal(gate(), false, "a second caller in the same instant does not");
    clock += 9_000;
    assert.equal(gate(), false, "still inside the interval");
    clock += 1_001;
    assert.equal(gate(), true, "and again once the interval has passed");
    assert.equal(gate(), false);
  });

  it("gives each gate its own clock, so one route cannot starve another", () => {
    let clock = 0;
    const a = createSweepGate(5_000, () => clock);
    const b = createSweepGate(5_000, () => clock);
    assert.equal(a(), true);
    assert.equal(b(), true, "an independent gate is not blocked by another's sweep");
  });
});

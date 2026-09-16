/**
 * The scheduled sweep's trigger. With CRON_SECRET set, only a caller carrying
 * it can start a sweep from outside; without it, the endpoint is open as it
 * was. The scheduled sweep is now the one place charges are queued, so who
 * gets to pick its moment matters.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sweepTriggerAllowed } from "../../src/fleet/sweep-trigger.js";

const req = (auth?: string) => new Request("https://chit.tools/api/fleet/sweep", { headers: auth ? { authorization: auth } : {} });

describe("sweep trigger", () => {
  it("is open when no secret is configured", () => {
    assert.equal(sweepTriggerAllowed(req(), undefined), true);
    assert.equal(sweepTriggerAllowed(req("Bearer anything"), undefined), true);
  });

  it("requires the bearer when a secret is configured, compared in constant time", () => {
    assert.equal(sweepTriggerAllowed(req("Bearer s3cret-s3cret-s3cret"), "s3cret-s3cret-s3cret"), true);
    assert.equal(sweepTriggerAllowed(req("Bearer wrong"), "s3cret-s3cret-s3cret"), false);
    assert.equal(sweepTriggerAllowed(req(), "s3cret-s3cret-s3cret"), false);
    assert.equal(sweepTriggerAllowed(req("s3cret-s3cret-s3cret"), "s3cret-s3cret-s3cret"), false, "the scheme is part of the header");
  });
});

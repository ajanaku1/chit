import assert from "node:assert/strict";
import test from "node:test";

import { adminFromEnv, guardianFromEnv } from "../../src/fleet/deploy-guards.js";

/** T012: deployment refuses without a guardian on mainnet, and without a cold admin anywhere, as a test rather than a rehearsal note. */

const OPERATOR = "0x34b0Ba20669f3ec4F1056853780c381e5e35F724" as const;
const GUARDIAN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ADMIN = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

test("a mainnet deploy refuses without a guardian, with the variable named; testnet goes on without one", () => {
  assert.throws(() => guardianFromEnv({}, OPERATOR, true), /set FLEET_GUARDIAN_ADDRESS/);
  assert.throws(() => guardianFromEnv({ FLEET_GUARDIAN_ADDRESS: "" }, OPERATOR, true), /set FLEET_GUARDIAN_ADDRESS/);
  assert.equal(guardianFromEnv({}, OPERATOR, false), undefined);
});

test("a guardian that is the operator, or not an address, is refused on either chain", () => {
  for (const mainnet of [true, false]) {
    assert.throws(() => guardianFromEnv({ FLEET_GUARDIAN_ADDRESS: OPERATOR.toLowerCase() }, OPERATOR, mainnet), /must not be the operator/);
    assert.throws(() => guardianFromEnv({ FLEET_GUARDIAN_ADDRESS: "0x1234" }, OPERATOR, mainnet), /not an address/);
  }
  assert.equal(guardianFromEnv({ FLEET_GUARDIAN_ADDRESS: GUARDIAN }, OPERATOR, true), GUARDIAN);
});

test("the cold admin is required, an address, and never the deployer", () => {
  assert.throws(() => adminFromEnv({}, OPERATOR), /Set FLEET_ADMIN_ADDRESS/);
  assert.throws(() => adminFromEnv({ FLEET_ADMIN_ADDRESS: "nope" }, OPERATOR), /Set FLEET_ADMIN_ADDRESS/);
  assert.throws(() => adminFromEnv({ FLEET_ADMIN_ADDRESS: OPERATOR.toLowerCase() }, OPERATOR), /must not be the deployer/);
  assert.equal(adminFromEnv({ FLEET_ADMIN_ADDRESS: ADMIN }, OPERATOR), ADMIN);
});

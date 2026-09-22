import assert from "node:assert/strict";
import test from "node:test";

import { mainnetPreflight } from "../../src/fleet/service-preflight.js";

/** T047: on 4663 the service refuses to start without its three variables, naming the first one missing; testnet is unchanged. */

const complete = { DATABASE_URL: "postgres://x", CRON_SECRET: "s3cret-s3cret-s3cret", FLEET_TOKEN_ALLOWLIST: "0xd523a627030509021cc39b6d7c8543417d3e50d8", FLEET_POOL_MANAGER_ADDRESS: "0x8366a39cc670b4001a1121b8f6a443a643e40951" };

test("mainnet needs the store, the sweep's bearer and the allowlist, and says which is missing first", () => {
  assert.equal(mainnetPreflight(4663, complete), undefined);
  assert.match(mainnetPreflight(4663, {})!, /^FLEET_CHAIN_ID=4663 needs DATABASE_URL: /);
  assert.match(mainnetPreflight(4663, { ...complete, CRON_SECRET: " " })!, /needs CRON_SECRET: .*sign/);
  assert.match(mainnetPreflight(4663, { ...complete, FLEET_TOKEN_ALLOWLIST: "" })!, /needs FLEET_TOKEN_ALLOWLIST: .*any token/);
  assert.match(mainnetPreflight(4663, { ...complete, FLEET_POOL_MANAGER_ADDRESS: "" })!, /needs FLEET_POOL_MANAGER_ADDRESS: .*no quote and no buy/);
});

test("testnet starts with none of them, as before", () => {
  assert.equal(mainnetPreflight(46630, {}), undefined);
});

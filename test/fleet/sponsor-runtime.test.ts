import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sponsorSignerFrom } from "../../src/fleet/sponsor-runtime.js";

/**
 * Which key the sponsor route signs with (T028).
 *
 * The route signs sponsorships and sends bundles. It used to do that with the
 * pool operator's key, from the same variable, so two services shared one
 * account and one nonce sequence with no lock between them, and whoever could
 * reach the sponsor function's environment held the key that moves the pool.
 * It has a variable of its own now, and a key that is the operator's under
 * another name is refused: the point is another account, not another name.
 *
 * On mainnet sponsorship is off for the beta (FR-021), whatever is configured.
 */

const OPERATOR = `0x${"1".repeat(64)}`;
const SPONSOR = `0x${"2".repeat(64)}`;
const DEPLOYER = `0x${"3".repeat(64)}`;

describe("the sponsor route's signer", () => {
  it("signs with its own key", () => {
    assert.deepEqual(sponsorSignerFrom({ FLEET_SPONSOR_PRIVATE_KEY: SPONSOR, FLEET_OPERATOR_PRIVATE_KEY: OPERATOR }), { key: SPONSOR, shared: false });
    assert.deepEqual(sponsorSignerFrom({ FLEET_SPONSOR_PRIVATE_KEY: SPONSOR }), { key: SPONSOR, shared: false });
  });

  it("refuses the operator's key under its own name: the point is another account, not another variable", () => {
    const same = sponsorSignerFrom({ FLEET_SPONSOR_PRIVATE_KEY: OPERATOR.toUpperCase().replace("0X", "0x"), FLEET_OPERATOR_PRIVATE_KEY: OPERATOR });
    assert.ok("fault" in same && /operator's key/.test(same.fault), JSON.stringify(same));
    const deployer = sponsorSignerFrom({ FLEET_SPONSOR_PRIVATE_KEY: DEPLOYER, DEPLOYER_PRIVATE_KEY: DEPLOYER });
    assert.ok("fault" in deployer && /operator's key/.test(deployer.fault), "the deployer's key is the operator's where no operator key is set");
    // Where an operator key is set, the deployer's is not the operator's, and may sign sponsorships.
    assert.deepEqual(sponsorSignerFrom({ FLEET_SPONSOR_PRIVATE_KEY: DEPLOYER, FLEET_OPERATOR_PRIVATE_KEY: OPERATOR, DEPLOYER_PRIVATE_KEY: DEPLOYER }), { key: DEPLOYER, shared: false });
  });

  it("does not quietly fall back when its own key is set and malformed", () => {
    const bad = sponsorSignerFrom({ FLEET_SPONSOR_PRIVATE_KEY: "0x1234", FLEET_OPERATOR_PRIVATE_KEY: OPERATOR });
    assert.ok("fault" in bad && /FLEET_SPONSOR_PRIVATE_KEY/.test(bad.fault), JSON.stringify(bad));
  });

  it("on testnet, without a key of its own, still signs with the operator's and says it is shared", () => {
    // The sponsor set deployed on 46630 names the pool operator as its operator, so until that set is
    // redeployed for a sponsor account the route has no other key it could sign with.
    assert.deepEqual(sponsorSignerFrom({ FLEET_OPERATOR_PRIVATE_KEY: OPERATOR }), { key: OPERATOR, shared: true });
    assert.deepEqual(sponsorSignerFrom({ DEPLOYER_PRIVATE_KEY: DEPLOYER, FLEET_CHAIN_ID: "46630" }), { key: DEPLOYER, shared: true });
    const none = sponsorSignerFrom({});
    assert.ok("fault" in none && /no key/.test(none.fault));
  });

  it("is off on mainnet, whatever is configured", () => {
    for (const env of [{ FLEET_SPONSOR_PRIVATE_KEY: SPONSOR }, { FLEET_OPERATOR_PRIVATE_KEY: OPERATOR }, {}]) {
      const off = sponsorSignerFrom({ ...env, FLEET_CHAIN_ID: "4663" });
      assert.ok("fault" in off && off.off === true, JSON.stringify(off));
    }
  });

  it("answers a mainnet request with a reason that says off, not misconfigured", async () => {
    const before = { ...process.env };
    Object.assign(process.env, { FLEET_CHAIN_ID: "4663", FLEET_SPONSOR_PRIVATE_KEY: SPONSOR, FLEET_SPONSOR_PAYMASTER_ADDRESS: `0x${"a".repeat(40)}`, FLEET_SPONSOR_ESCROW_ADDRESS: `0x${"b".repeat(40)}` });
    const silenced = console.error;
    console.error = () => undefined;
    try {
      // A fresh copy of the module: it keeps the router it built, or the reason it could not.
      const fresh = "../../src/fleet/sponsor-runtime.js?mainnet";
      const { handleSponsorRequest } = (await import(fresh)) as typeof import("../../src/fleet/sponsor-runtime.js");
      const response = await handleSponsorRequest(new Request("https://chit.tools/api/fleet/sponsor", { method: "POST", body: JSON.stringify({ action: "info" }) }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "dependency_evidence_invalid", retryable: false, reason: "sponsorship_off" });
    } finally {
      console.error = silenced;
      for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
      Object.assign(process.env, before);
    }
  });
});

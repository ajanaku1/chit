import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { LIVE_PROFILE, PROVEN_ROUND } from "../src/live-profile.js";

describe("live Sepolia profile", () => {
  it("uses checksummed deployment addresses", () => {
    for (const address of [
      LIVE_PROFILE.factory,
      LIVE_PROFILE.operator,
      LIVE_PROFILE.entryPoint,
      PROVEN_ROUND.vault,
      PROVEN_ROUND.settlement,
      PROVEN_ROUND.paymaster,
    ]) {
      assert.equal(getAddress(address), address);
    }
  });

  it("discloses the exact activation value", () => {
    assert.equal(
      LIVE_PROFILE.activationValue,
      LIVE_PROFILE.minimumStake +
        LIVE_PROFILE.paymasterDeposit +
        LIVE_PROFILE.operatorGas,
    );
    assert.equal(LIVE_PROFILE.activationValue, 111_000_000_000_000_000n);
  });

  it("links the proven round to its real activation transaction", () => {
    assert.match(PROVEN_ROUND.explorerUrl, new RegExp(PROVEN_ROUND.activationTx.slice(2), "i"));
    assert.equal(PROVEN_ROUND.sponsorCount, 1);
  });
});

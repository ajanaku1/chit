import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundaryViolationError,
  FLEET_EXCLUDED_CAPABILITIES,
  FLEET_PRIVACY_CLAIM,
  FLEET_PRIVATE_FACT,
  FLEET_PUBLIC_FACTS,
  SERVICE_FORBIDDEN_FIELDS,
  assertServiceSafe,
} from "../src/fleet/index.js";

const violates = (value: unknown): string => {
  try {
    assertServiceSafe(value);
  } catch (error) {
    assert.ok(error instanceof BoundaryViolationError);
    assert.equal(error.code, "boundary_violation");
    return error.reason;
  }
  return assert.fail("expected boundary_violation");
};

test("the browser boundary names every capability the product excludes", () => {
  for (const excluded of [
    "imported keys",
    "custody",
    "sells",
    "limit trading",
    "copy trading",
    "P&L",
    "charts",
    "Telegram",
    "mobile",
    "arbitrary calls",
    "hidden trades",
    "operator-blind attribution",
    "mainnet sponsorship",
    "Robinhood Nox",
    "staking",
    "revenue",
    "buybacks",
    "a new token",
    "manufactured volume",
    "market manipulation",
  ]) {
    assert.ok(
      (FLEET_EXCLUDED_CAPABILITIES as readonly string[]).includes(excluded),
      `FR-017 exclusion missing: ${excluded}`,
    );
  }
});

test("the published privacy claim stays narrow", () => {
  assert.deepEqual(FLEET_PUBLIC_FACTS, [
    "fleet accounts",
    "trades",
    "amounts",
    "timing",
    "gas",
    "shared paymaster activity",
  ]);
  assert.match(FLEET_PRIVATE_FACT, /primary-wallet-to-fleet relationship/);
  assert.match(FLEET_PRIVACY_CLAIM, /operator knows/i);
  for (const overclaim of ["unlinkab", "anonymous", "untraceable", "hidden trade", "mainnet"]) {
    assert.equal(
      FLEET_PRIVACY_CLAIM.toLowerCase().includes(overclaim),
      false,
      `privacy claim must not promise: ${overclaim}`,
    );
  }
});

test("a service payload carrying local credential material is rejected before it leaves the browser", () => {
  const safe = {
    campaign: "handle",
    accounts: [{ ownerAddress: `0x${"1".repeat(40)}`, salt: `0x${"2".repeat(64)}` }],
    recoveryVaultCommitment: `0x${"3".repeat(64)}`,
  };
  assert.doesNotThrow(() => assertServiceSafe(safe));

  for (const field of SERVICE_FORBIDDEN_FIELDS) {
    assert.equal(violates({ ...safe, [field]: "0x00" }), `forbidden_field:${field}`);
  }
  assert.equal(
    violates({ ...safe, accounts: [{ ownerAddress: `0x${"1".repeat(40)}`, privateKey: `0x${"4".repeat(64)}` }] }),
    "forbidden_field:privateKey",
  );
  assert.equal(violates({ ...safe, nested: { deep: { mnemonic: "a b c" } } }), "forbidden_field:mnemonic");
});

test("the boundary rejects unencoded 32-byte secrets under unexpected names", () => {
  assert.equal(
    violates({ campaign: "handle", note: `0x${"5".repeat(64)}`, ownerSecretFor: `0x${"6".repeat(64)}` }),
    "forbidden_field:ownerSecretFor",
  );
  assert.doesNotThrow(() => assertServiceSafe({ campaign: "handle", payloadHash: `0x${"5".repeat(64)}` }));
});

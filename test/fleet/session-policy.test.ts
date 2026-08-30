import assert from "node:assert/strict";
import test from "node:test";

import {
  PolicyRejection,
  SPONSORABLE_OPERATION,
  authorize,
  type SessionKey,
  type SponsorRequest,
} from "../../src/fleet/session-policy.js";

const address = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const ROUTER = address(0x11);
const ACCOUNTS = [address(1), address(2), address(3), address(4), address(5)];
const now = new Date("2026-09-01T00:00:00.000Z");

const session = (overrides: Partial<SessionKey> = {}): SessionKey => ({
  campaign: "campaign-handle",
  chainId: 46630,
  accounts: ACCOUNTS,
  router: ROUTER,
  function: "buy(address,uint256)",
  maxTradeValue: "1000000000000000",
  perAccountGas: "200000000000000",
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
  revoked: false,
  ...overrides,
});

const request = (overrides: Partial<SponsorRequest> = {}): SponsorRequest => ({
  campaign: "campaign-handle",
  chainId: 46630,
  account: ACCOUNTS[0] as `0x${string}`,
  operation: SPONSORABLE_OPERATION,
  target: ROUTER,
  function: "buy(address,uint256)",
  value: "500000000000000",
  gas: "100000000000000",
  ...overrides,
});

const rejects = (input: Partial<SponsorRequest>, over: Partial<SessionKey> = {}, state: "Active" | "Paused" | "Revoked" | "Depleted" | "Expired" | "Closed" = "Active"): string => {
  try {
    authorize({ session: session(over), request: request(input), state, spentGas: "0", now });
  } catch (error) {
    assert.ok(error instanceof PolicyRejection);
    assert.equal(error.code, "policy_rejected");
    return error.reason;
  }
  return assert.fail("expected policy_rejected");
};

test("a bounded request from a fleet account on an Active campaign is authorized", () => {
  const decision = authorize({ session: session(), request: request(), state: "Active", spentGas: "0", now });
  assert.equal(decision.account, ACCOUNTS[0]);
  assert.equal(decision.gas, "100000000000000");
});

test("the session key authorizes only the one approved buy operation", () => {
  assert.equal(SPONSORABLE_OPERATION, "buy");
  for (const operation of ["transfer", "transferOwnership", "withdrawGas", "authorizeKey", "sell"]) {
    assert.equal(rejects({ operation: operation as SponsorRequest["operation"] }), `forbidden_operation:${operation}`);
  }
});

test("bindings to campaign, chain, account, router, and function are all enforced", () => {
  assert.equal(rejects({ campaign: "other-handle" }), "campaign_mismatch");
  assert.equal(rejects({ chainId: 1 }), "chain_mismatch");
  assert.equal(rejects({ account: address(99) }), "unknown_account");
  assert.equal(rejects({ target: address(0x22) }), "unapproved_target");
  assert.equal(rejects({ function: "swap(address,uint256)" }), "unapproved_function");
});

test("trade value, per-account gas, total budget, and expiry are all bounded", () => {
  assert.equal(rejects({ value: "1000000000000001" }), "trade_value_exceeded");
  assert.equal(rejects({ gas: "200000000000001" }), "per_account_gas_exceeded");
  assert.doesNotThrow(() =>
    authorize({ session: session(), request: request({ gas: "200000000000000" }), state: "Active", spentGas: "0", now }),
  );
  assert.doesNotThrow(() =>
    authorize({ session: session(), request: request({ value: "1000000000000000" }), state: "Active", spentGas: "0", now }),
  );
});

test("the total gas budget is never exceeded across the fleet", () => {
  const decision = authorize({
    session: session(),
    request: request({ gas: "200000000000000" }),
    state: "Active",
    spentGas: "800000000000000",
    now,
  });
  assert.equal(decision.gas, "200000000000000");

  try {
    authorize({
      session: session(),
      request: request({ gas: "200000000000000" }),
      state: "Active",
      spentGas: "800000000000001",
      now,
    });
    assert.fail("expected policy_rejected");
  } catch (error) {
    assert.ok(error instanceof PolicyRejection);
    assert.equal(error.reason, "total_gas_exceeded");
  }
});

test("an expired, revoked, paused, or terminal campaign sponsors nothing", () => {
  assert.equal(rejects({}, { expiry: "2026-08-01T00:00:00.000Z" }), "campaign_expired");
  assert.equal(rejects({}, { revoked: true }), "session_revoked");
  for (const state of ["Paused", "Revoked", "Depleted", "Expired", "Closed"] as const) {
    assert.equal(rejects({}, {}, state), `state_not_sponsorable:${state}`);
  }
});

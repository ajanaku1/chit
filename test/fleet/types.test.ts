import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_STATES,
  DEMO_FLEET_ACCOUNTS,
  MAX_FLEET_ACCOUNTS,
  MIN_FLEET_ACCOUNTS,
  FleetValidationError,
  isAddress,
  isCampaignState,
  isHex32,
  isUint,
  normalizeAddress,
  parseFleetAccounts,
  parsePolicy,
} from "../../src/fleet/types.js";

const owner = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const accounts = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => ({ ownerAddress: owner(from + index), salt: salt(from + index) }));

const policy = () => ({
  chainId: 46630,
  accounts: DEMO_FLEET_ACCOUNTS,
  router: owner(0x11),
  function: "buy(address,uint256)",
  maxTradeValue: "1000000000000000",
  perAccountGas: "200000000000000",
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
});

const rejects = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof FleetValidationError);
    return error.reason;
  }
  return assert.fail("expected FleetValidationError");
};

test("the campaign state vocabulary is exactly the ten specified states", () => {
  assert.deepEqual(CAMPAIGN_STATES, [
    "Draft",
    "Awaiting recovery confirmation",
    "Awaiting funding",
    "Activating",
    "Active",
    "Paused",
    "Revoked",
    "Depleted",
    "Expired",
    "Closed",
  ]);
  assert.ok(isCampaignState("Revoked"));
  assert.equal(isCampaignState("revoked"), false);
  assert.equal(isCampaignState("Cancelled"), false);
});

test("primitive guards accept canonical values and reject near misses", () => {
  assert.ok(isAddress(owner(1)));
  assert.equal(isAddress("0x1"), false);
  assert.equal(isAddress(`0x${"g".repeat(40)}`), false);
  assert.equal(normalizeAddress("0xABCDEF0000000000000000000000000000000001"), "0xabcdef0000000000000000000000000000000001");

  assert.ok(isHex32(salt(1)));
  assert.equal(isHex32(owner(1)), false);

  assert.ok(isUint("0"));
  assert.ok(isUint("1000000000000000000"));
  assert.equal(isUint("01"), false);
  assert.equal(isUint("-1"), false);
  assert.equal(isUint("1.5"), false);
  assert.equal(isUint(""), false);
});

test("a fleet is 5 to 50 accounts with distinct owner addresses and salts", () => {
  assert.equal(MIN_FLEET_ACCOUNTS, 5);
  assert.equal(MAX_FLEET_ACCOUNTS, 50);
  assert.equal(DEMO_FLEET_ACCOUNTS, 5);

  const parsed = parseFleetAccounts(accounts(MIN_FLEET_ACCOUNTS));
  assert.equal(parsed.length, MIN_FLEET_ACCOUNTS);
  assert.equal(parseFleetAccounts(accounts(MAX_FLEET_ACCOUNTS)).length, MAX_FLEET_ACCOUNTS);

  assert.equal(rejects(() => parseFleetAccounts(accounts(4))), "account_count_out_of_range");
  assert.equal(rejects(() => parseFleetAccounts(accounts(51))), "account_count_out_of_range");
  assert.equal(
    rejects(() => parseFleetAccounts([...accounts(4), { ownerAddress: owner(1), salt: salt(99) }])),
    "duplicate_owner_address",
  );
  assert.equal(
    rejects(() => parseFleetAccounts([...accounts(4), { ownerAddress: owner(99), salt: salt(1) }])),
    "duplicate_salt",
  );
  assert.equal(rejects(() => parseFleetAccounts([...accounts(4), { ownerAddress: "0x1", salt: salt(9) }])), "invalid_owner_address");
});

test("account parsing normalizes case and never accepts a secret field", () => {
  const parsed = parseFleetAccounts(
    accounts(MIN_FLEET_ACCOUNTS).map((entry) => ({ ...entry, ownerAddress: entry.ownerAddress.toUpperCase().replace("0X", "0x") })),
  );
  for (const entry of parsed) {
    assert.equal(entry.ownerAddress, entry.ownerAddress.toLowerCase());
    assert.deepEqual(Object.keys(entry).sort(), ["ownerAddress", "salt"]);
  }
});

test("a policy requires every bounded field before activation", () => {
  const parsed = parsePolicy(policy());
  assert.equal(parsed.accounts, DEMO_FLEET_ACCOUNTS);
  assert.equal(parsed.router, owner(0x11));

  assert.equal(rejects(() => parsePolicy({ ...policy(), chainId: 0 })), "invalid_chain_id");
  assert.equal(rejects(() => parsePolicy({ ...policy(), accounts: 4 })), "account_count_out_of_range");
  assert.equal(rejects(() => parsePolicy({ ...policy(), router: "0x1" })), "invalid_router");
  assert.equal(rejects(() => parsePolicy({ ...policy(), function: "" })), "invalid_function");
  assert.equal(rejects(() => parsePolicy({ ...policy(), maxTradeValue: "0" })), "invalid_max_trade_value");
  assert.equal(rejects(() => parsePolicy({ ...policy(), perAccountGas: "-1" })), "invalid_per_account_gas");
  assert.equal(rejects(() => parsePolicy({ ...policy(), totalGas: "0" })), "invalid_total_gas");
  assert.equal(rejects(() => parsePolicy({ ...policy(), expiry: "soon" })), "invalid_expiry");
  assert.equal(
    rejects(() => parsePolicy({ ...policy(), perAccountGas: "1000000000000000", totalGas: "1000000000000" })),
    "total_gas_below_per_account_gas",
  );
});

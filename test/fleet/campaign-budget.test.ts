import assert from "node:assert/strict";
import test from "node:test";

import { BudgetError, CampaignBudget } from "../../src/fleet/campaign-budget.js";

const budget = (funded = "1000000000000000000") => new CampaignBudget(funded);

const rejects = (run: () => unknown, code: BudgetError["code"]): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof BudgetError);
    assert.equal(error.code, code);
    return error.reason;
  }
  return assert.fail(`expected ${code}`);
};

test("a new budget is entirely unused", () => {
  assert.deepEqual(budget("100").snapshot(), { funded: "100", reserved: "0", spent: "0", unused: "100" });
});

test("reservation is exact and never exceeds the funded budget", () => {
  const account = budget("100");
  account.reserve("fleet-key-1", "60");
  assert.deepEqual(account.snapshot(), { funded: "100", reserved: "60", spent: "0", unused: "40" });

  assert.equal(rejects(() => account.reserve("fleet-key-2", "41"), "budget_exceeded"), "reservation_exceeds_unused");
  assert.equal(rejects(() => account.reserve("fleet-key-2", "0"), "budget_invalid"), "reservation_not_positive");
});

test("reserving the same key twice reserves once", () => {
  const account = budget("100");
  assert.deepEqual(account.reserve("fleet-key-1", "60"), account.reserve("fleet-key-1", "60"));
  assert.equal(account.snapshot().reserved, "60");
  assert.equal(rejects(() => account.reserve("fleet-key-1", "61"), "idempotency_conflict"), "reservation_amount_changed");
});

test("commit debits only the permitted actual cost and releases the remainder", () => {
  const account = budget("100");
  account.reserve("fleet-key-1", "60");
  account.commit("fleet-key-1", "45");
  assert.deepEqual(account.snapshot(), { funded: "100", reserved: "0", spent: "45", unused: "55" });

  account.commit("fleet-key-1", "45");
  assert.deepEqual(account.snapshot(), { funded: "100", reserved: "0", spent: "45", unused: "55" });
  assert.equal(rejects(() => account.commit("fleet-key-1", "46"), "idempotency_conflict"), "commit_amount_changed");
});

test("a commit above its reservation is refused so no request overspends", () => {
  const account = budget("100");
  account.reserve("fleet-key-1", "60");
  assert.equal(rejects(() => account.commit("fleet-key-1", "61"), "budget_exceeded"), "commit_exceeds_reservation");
  assert.equal(account.snapshot().reserved, "60");
});

test("a failed or expired reservation rolls back idempotently and charges nothing", () => {
  const account = budget("100");
  account.reserve("fleet-key-1", "60");
  account.rollback("fleet-key-1");
  account.rollback("fleet-key-1");
  assert.deepEqual(account.snapshot(), { funded: "100", reserved: "0", spent: "0", unused: "100" });

  assert.equal(rejects(() => account.commit("fleet-key-1", "10"), "state_invalid"), "reservation_rolled_back");
  assert.equal(rejects(() => account.rollback("fleet-unknown"), "state_invalid"), "reservation_unknown");
});

test("a committed reservation can no longer be rolled back", () => {
  const account = budget("100");
  account.reserve("fleet-key-1", "60");
  account.commit("fleet-key-1", "60");
  assert.equal(rejects(() => account.rollback("fleet-key-1"), "state_invalid"), "reservation_committed");
});

test("five sponsored buys debit exactly their attributed cost", () => {
  const account = budget("1000");
  for (let index = 0; index < 5; index += 1) {
    account.reserve(`fleet-key-${index}`, "150");
    account.commit(`fleet-key-${index}`, "120");
  }
  assert.deepEqual(account.snapshot(), { funded: "1000", reserved: "0", spent: "600", unused: "400" });
});

test("close returns the unused budget and blocks every later charge", () => {
  const account = budget("1000");
  account.reserve("fleet-key-1", "150");
  account.commit("fleet-key-1", "120");

  assert.equal(account.close(), "880");
  assert.deepEqual(account.snapshot(), { funded: "1000", reserved: "0", spent: "120", unused: "0" });
  assert.equal(account.close(), "0");
  assert.equal(rejects(() => account.reserve("fleet-key-2", "1"), "state_invalid"), "budget_closed");
});

test("an open reservation is released before the unused budget is returned", () => {
  const account = budget("1000");
  account.reserve("fleet-key-1", "150");
  assert.equal(account.close(), "1000");
  assert.equal(account.snapshot().reserved, "0");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { depositOptions, exitView, withdrawIssue, type BalanceState } from "../src/fleet/balance.js";

/**
 * The Balance page decides what a trader is offered before any transaction is
 * sent. Every refusal it shows must match one the pool would enforce, or a
 * trader loses gas learning a limit the app already knew.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const eth = (whole: string): string => {
  const [int, frac = ""] = whole.split(".");
  return `${BigInt(int!)}${frac.padEnd(18, "0")}`.replace(/^0+(?=\d)/, "");
};

const state = (over: Partial<BalanceState> = {}): BalanceState => ({
  available: eth("0.06"),
  deposited: eth("0.1"),
  spent: eth("0.02"),
  openDraws: eth("0.02"),
  headroom: { sizes: [eth("0.01"), eth("0.05"), eth("0.1")], perTraderRemaining: eth("0.4"), poolRemaining: eth("4.9") },
  exit: {},
  pool: { paused: false },
  ...over,
});

test("offers every published size the caps still admit", () => {
  const options = depositOptions(state());
  assert.deepEqual(options.map((o) => o.label), ["0.01 ETH", "0.05 ETH", "0.1 ETH"]);
  assert.ok(options.every((o) => !o.disabled));
});

test("disables a size the caps refuse, and says which cap", () => {
  const nearTraderCap = depositOptions(state({
    headroom: { sizes: [eth("0.01")], perTraderRemaining: eth("0.04"), poolRemaining: eth("4.9") },
  }));
  assert.deepEqual(nearTraderCap.filter((o) => !o.disabled).map((o) => o.label), ["0.01 ETH"]);
  assert.match(nearTraderCap.find((o) => o.disabled)!.reason!, /your limit/i);

  const nearPoolCap = depositOptions(state({
    headroom: { sizes: [eth("0.01")], perTraderRemaining: eth("0.4"), poolRemaining: eth("0.02") },
  }));
  assert.match(nearPoolCap.find((o) => o.disabled)!.reason!, /pool/i);
});

test("disables every size while the pool is paused", () => {
  const options = depositOptions(state({ pool: { paused: true } }));
  assert.ok(options.every((o) => o.disabled));
  assert.match(options[0]!.reason!, /paused/i);
});

test("refuses a withdrawal the balance cannot cover, and accepts one it can", () => {
  assert.match(withdrawIssue(state(), eth("0.07"), "0x00000000000000000000000000000000000f3e58")!, /balance/i);
  assert.equal(withdrawIssue(state(), eth("0.06"), "0x00000000000000000000000000000000000f3e58"), undefined);
});

test("refuses an empty or malformed amount and destination", () => {
  const to = "0x00000000000000000000000000000000000f3e58";
  assert.ok(withdrawIssue(state(), "0", to));
  assert.ok(withdrawIssue(state(), "", to));
  assert.ok(withdrawIssue(state(), "abc", to));
  assert.ok(withdrawIssue(state(), eth("0.01"), "not-an-address"));
});

test("warns without blocking when the destination is the depositing wallet", () => {
  const primary = "0x00000000000000000000000000000000000a11ce";
  const issue = withdrawIssue(state(), eth("0.01"), primary, primary);
  assert.match(issue ?? "", /same wallet/i);
  assert.equal(withdrawIssue(state(), eth("0.01"), primary, primary, { blocking: true }), undefined);
});

test("describes the exit from not-requested through paid", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  assert.equal(exitView(state(), now).status, "none");

  const requested = exitView(state({
    exit: { requestedAt: "2026-09-07T06:00:00.000Z", amount: eth("0.06"), availableAt: "2026-09-08T06:00:00.000Z" },
  }), now);
  assert.equal(requested.status, "waiting");
  assert.equal(requested.availableAt, "2026-09-08T06:00:00.000Z");

  const ready = exitView(state({
    exit: { requestedAt: "2026-09-05T06:00:00.000Z", amount: eth("0.06"), availableAt: "2026-09-06T06:00:00.000Z" },
  }), now);
  assert.equal(ready.status, "available");
});

test("the page carries the deposit, withdraw, and exit cards and the honest claim", async () => {
  const html = await readFile(join(appRoot, "balance.html"), "utf8");
  for (const id of ["deposit-sizes", "withdraw-form", "withdraw-destination", "exit-card", "balance-available"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /operator/i, "the page says who can still see the mapping");
  assert.doesNotMatch(html, /anonymous|untraceable/i);
});

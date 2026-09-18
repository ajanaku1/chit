import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FRESH_MS, canAddFunds, clearCachedBalance, depositOptions, exitView, isFresh, loadCachedBalance, receiptOutcome, saveCachedBalance, showableBalance, toEth, withdrawIssue, type BalanceState } from "../src/fleet/balance.js";

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

/**
 * A transaction is not done when the wallet hands back a hash; it is done when
 * the chain says so. Reporting "Exit requested" on the hash alone showed a
 * trader a success the chain had refused.
 */
test("a receipt is judged by its status, not by the existence of a hash", () => {
  assert.equal(receiptOutcome({ status: "0x1" }).ok, true);
  assert.equal(receiptOutcome({ status: "0x0" }).ok, false);
  assert.match(receiptOutcome({ status: "0x0" }).message, /reverted|rejected/i);
  assert.equal(receiptOutcome(null).ok, false, "no receipt yet is not success");
  assert.match(receiptOutcome(null).message, /not confirmed|waiting/i);
});

/**
 * Every navigation re-signs to read the balance, and until that signature the
 * page showed dashes, which read as "gone". The last known figures are kept per
 * wallet so the page never blanks, then refreshed.
 */
test("the last known balance is kept per wallet and never shown to another", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const alice = "0x00000000000000000000000000000000000a11ce";
  const bob = "0x00000000000000000000000000000000000b0b00";
  assert.equal(loadCachedBalance(storage, alice), undefined);
  saveCachedBalance(storage, alice, state({ available: eth("0.05") }));
  assert.equal(loadCachedBalance(storage, alice)?.available, eth("0.05"));
  assert.equal(loadCachedBalance(storage, bob), undefined, "one trader's figures are not another's");
});

test("a corrupt cache is ignored rather than crashing the page", () => {
  const storage = { getItem: () => "{not json", setItem: () => undefined };
  assert.equal(loadCachedBalance(storage, "0x00000000000000000000000000000000000a11ce"), undefined);
});

/**
 * One rule, asked by every surface. A figure the Control Room withholds until
 * the trader signs must not be sitting in the header menu meanwhile, and the
 * only thing allowed to decide either way is how old the read is.
 */
test("a kept balance shows without signing only while the read is fresh", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const alice = "0x00000000000000000000000000000000000a11ce";
  const bob = "0x00000000000000000000000000000000000b0b00";
  const at = new Date("2026-01-01T00:00:00Z");
  assert.equal(showableBalance(storage, alice, at), undefined, "nothing was kept, yet something is shown");
  saveCachedBalance(storage, alice, state({ available: eth("0.05") }), at);
  assert.equal(showableBalance(storage, alice, at)?.available, eth("0.05"));
  assert.equal(showableBalance(storage, alice, new Date(at.getTime() + FRESH_MS))?.available, eth("0.05"), "a read on the edge of the window is withheld");
  assert.equal(showableBalance(storage, alice, new Date(at.getTime() + FRESH_MS + 1)), undefined, "a read past the window is shown anyway");
  assert.equal(showableBalance(storage, bob, at), undefined, "one trader's figures are another's");
});

test("the page shows the wallet's own ETH beside the Chit balance", async () => {
  const html = await readFile(join(appRoot, "balance.html"), "utf8");
  assert.match(html, /id="wallet-eth"/, "a trader must see what is in the wallet, not only what is at Chit");
});

test("the page is built from the shared components, not bare markup", async () => {
  const html = await readFile(join(appRoot, "balance.html"), "utf8");
  assert.match(html, /class="summary[^"]*"[^>]*>\s*<div><dt>Available/, "figures use the summary tiles");
  assert.match(html, /id="deposit-sizes" class="quickpick"/, "deposit sizes use the quickpick row");
  assert.match(html, /id="withdraw-submit"[^>]*class="primary"/, "the withdraw action is a primary button");
  const dashboard = await readFile(join(appRoot, "fleet-dashboard.html"), "utf8");
  assert.match(dashboard, /id="balance-strip"[\s\S]*?<dl class="summary/, "the dashboard strip uses the same tiles");
});

/** A tile is not a ledger: six decimals is plenty, and exact strings stay exact in logic. */
test("figures are shown to six decimals and never overflow into noise", () => {
  assert.equal(toEth("509263445375312000"), "0.509263");
  assert.equal(toEth("10000000000000000"), "0.01");
  assert.equal(toEth("1000000000000000000"), "1");
  assert.equal(toEth("0"), "0");
});

/**
 * Every balance read needs a signature. Re-signing on every page load reads as
 * "connect again", so a recent read stands in for a minute and the trader can
 * refresh by hand.
 */
test("a cached balance is fresh inside its window and stale beyond it", () => {
  const saved = Date.parse("2026-09-09T12:00:00Z");
  assert.equal(isFresh(saved, new Date(saved + FRESH_MS - 1_000)), true);
  assert.equal(isFresh(saved, new Date(saved + FRESH_MS + 1_000)), false);
  assert.equal(isFresh(undefined, new Date()), false, "no timestamp is never fresh");
});

test("the cache records when it was saved", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const alice = "0x00000000000000000000000000000000000a11ce";
  saveCachedBalance(storage, alice, state(), new Date("2026-09-09T12:00:00Z"));
  const cached = loadCachedBalance(storage, alice);
  assert.equal(cached?.savedAt, Date.parse("2026-09-09T12:00:00Z"));
});

test("the page offers a refresh and lays the tiles out as a grid", async () => {
  const html = await readFile(join(appRoot, "balance.html"), "utf8");
  assert.match(html, /id="balance-refresh"/, "the trader can refresh without a reload");
  assert.match(html, /class="summary grid"/, "tiles share one width, whatever their count");
});

/**
 * Choosing an amount and committing to it are two different decisions. A row of
 * buttons that each move money means a mis-click costs ETH; picking a size then
 * pressing Add funds is one deliberate act.
 */
test("nothing can be added until a size is chosen", () => {
  assert.equal(canAddFunds(state(), undefined), false);
  assert.equal(canAddFunds(state(), ""), false);
  assert.equal(canAddFunds(state(), eth("0.05")), true);
});

test("a size the caps refuse cannot be added, even if it is selected", () => {
  const nearCap = state({
    headroom: { sizes: [eth("0.01")], perTraderRemaining: eth("0.04"), poolRemaining: eth("4.9") },
  });
  assert.equal(canAddFunds(nearCap, eth("0.1")), false, "over the trader's own limit");
  assert.equal(canAddFunds(nearCap, eth("0.01")), true);
});

test("nothing can be added while the pool is paused", () => {
  assert.equal(canAddFunds(state({ pool: { paused: true } }), eth("0.05")), false);
});

test("an amount that is not a published size cannot be added", () => {
  assert.equal(canAddFunds(state(), eth("0.03")), false);
});

test("the page has a separate, disabled-by-default Add funds control", async () => {
  const html = await readFile(join(appRoot, "balance.html"), "utf8");
  assert.match(html, /id="deposit-submit"[^>]*disabled/, "Add funds starts disabled until a size is picked");
  assert.match(html, /id="deposit-submit"[^>]*class="[^"]*primary/, "Add funds is the page's primary action");
});

/**
 * Reading the balance costs a signature, so the cache has to outlive a browsing
 * session, not a minute of it. Correctness comes from clearing it whenever
 * something actually moves the balance, not from letting it go stale quickly.
 */
test("a cached balance outlives ordinary browsing", () => {
  assert.ok(FRESH_MS >= 5 * 60_000, "a minute of cache means a prompt every minute of use");
  const saved = Date.parse("2026-09-10T12:00:00Z");
  assert.equal(isFresh(saved, new Date("2026-09-10T12:04:00Z")), true);
});

test("clearing the cache forces the next read to be live", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const alice = "0x00000000000000000000000000000000000a11ce";
  saveCachedBalance(storage, alice, state());
  assert.ok(loadCachedBalance(storage, alice));
  clearCachedBalance(storage, alice);
  assert.equal(loadCachedBalance(storage, alice), undefined);
});

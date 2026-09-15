# Trading panel, plan 2 of 3: the Trade page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Trade page where a trader pastes a token, sees its quote, places a fleet buy as a seeded order, and watches the open page drive it to completion, with the browser as the order's only store.

**Architecture:** A pure order store (`app/src/fleet/orders.ts`) owns every order's state and the rule that a slice is marked *sent* before the response arrives. `app/src/trade-page.ts` paints from it and talks to the five service actions through `signedFleetApi`. The page reuses the redesign's shell, cards, pills, meters and LED figures; nothing new is styled that an existing component can do. One service addition: `order` and `trade` refuse while the wallet's exit is pending.

**Tech Stack:** TypeScript (strict), the app's layered CSS, node:test, Playwright for `app:shots`.

**Spec:** `docs/superpowers/specs/2026-09-15-trading-panel-design.md` (read "Idempotency, stated plainly" twice).

## Global Constraints

- Test-first; red commit before green; ≤ 200 changed lines per commit.
- Never edit an existing test, with two disclosed exceptions ruled by the controller: `app/test/app-look.test.ts` `NAV` and `PAGES` gain the Trade entry (the spec adds the page), and `test/fleet/order-route.test.ts` (this feature's own file) may be appended to.
- No new dependencies. No Claude attribution in commits.
- Claims words: never "untraceable", "unlinkab…", "no trail"; "anonymous", "hidden trade", "mainnet" only on a line with a denial word. Never "organic", "organic-looking" or "volume" as a selling point: the stagger exists to hide the funder's rhythm, and the page says trades are public.
- The browser calls only Chit's API. No RPC URL appears in app code.
- Wire field is `entropy`, never `seed`. `tokenQuote`, `order`, `list`, `holdings` are signed reads (no idempotency key); `trade` needs one.
- Coral only on live/done selectors (`pill|data-live|data-done|aria-current="step"|data-tone="ok"|\.delta|meter__fill|gauge`); hover only inside `@media (hover: hover) and (pointer: fine)`; only transform/opacity/clip-path/filter animate.
- Stow patterns: pill buttons, full-width main action, mono tracked labels, figures as label/value rows, sections split by hairlines.
- Commands: `cd app && node --import tsx --test test/app-*.test.ts`; `npm --prefix app run verify`; `npm run app:shots` (dev server running); gates `./verify.sh fleet-trade fleet-acceptance`.

---

### Task 0: The service refuses orders while an exit is pending

**Files:**
- Modify: `src/fleet/campaign-routes.ts` (`#validatedOrder`)
- Test: `test/fleet/order-route.test.ts` (append)

**Interfaces:** `PoolPort.balance(depositor)` already returns `exit: { requestedAt?: string }`.

- [ ] **Step 1: Append the failing test.** The order-route fixtures have no pool by default; build one router with a minimal pool fake: `pool: { ...noopPool, balance: async () => ({ ...emptyBalance, exit: { requestedAt: "2026-09-15T10:00:00.000Z", amount: "10000000000000000", availableAt: "2026-09-16T10:00:00.000Z" } }) }`. Copy the fake-pool shape from `test/fleet/balance-route.test.ts` (read it; don't import from it).
```ts
test("an order is refused while the wallet's exit is pending", async () => {
  const { router, service, campaign, accounts } = await activeCampaign({ pool: exitingPool() });
  const placed = await router.handle(await signed(service, "order", { campaign, token: TOKEN, totalWei: "1000000000000000", wallets: accounts, entropy: SEED, createdAt: "2026-09-15T12:00:00.000Z" }));
  assert.equal(placed.status, 400);
  assert.equal((placed.body as Record<string, unknown>)["code"], "exit_pending");
});
```
If `activeCampaign` cannot take a pool without the create/activate path changing (the pooled path needs `openDraw`), add a second helper that swaps the pool in after activation: `router` exposes no setter, so build the fake with a mutable `exiting = false` flag that the test flips to `true` before calling `order`.

- [ ] **Step 2: Red commit.** `git add test/fleet/order-route.test.ts && git commit -m "test(fleet): no new order while the wallet's exit is pending"`

- [ ] **Step 3: Implement.** In `#validatedOrder`, right after `if (!canSponsor(record.state)) …`:
```ts
    // The roadmap's rule: nothing new leaves the pool for a wallet on its way out.
    if (this.#deps.pool) {
      const { exit } = await this.#deps.pool.balance(owner);
      if (exit.requestedAt) throw new TradeValidationError("exit_pending");
    }
```
`#trade` reaches `#validatedOrder`, so both actions refuse.

- [ ] **Step 4: Green.** `npm run build:fleet && node --test dist-fleet/test/fleet/order-route.test.js dist-fleet/test/fleet/balance-route.test.js` → all pass. Commit: `feat(fleet): order and trade refuse while the wallet's exit is pending`.

---

### Task 1: The browser order store

**Files:**
- Create: `app/src/fleet/orders.ts`
- Test: `app/test/app-orders.test.ts`

**Interfaces (Produces):**
```ts
export type WireOrder = { id: string; campaign: string; token: string; totalWei: string; wallets: string[]; entropy: string; windowMs: number; createdAt: string; owner: string };
export type SliceState = "pending" | "sent" | "sponsored" | "rejected" | "failed" | "unconfirmed";
export type SliceRecord = { index: number; wallet: string; amountWei: string; dueAt: string; state: SliceState; attempts: number; txHash?: string; reason?: string };
export type OrderRecord = { order: WireOrder; symbol: string; slices: SliceRecord[]; cancelled: boolean; placedAt: string };
export type OrderStore = { list(): OrderRecord[]; get(id: string): OrderRecord | undefined; add(record: OrderRecord): void; update(id: string, fn: (r: OrderRecord) => OrderRecord): void };
export const MAX_ATTEMPTS = 3; // one send plus two retries
export const createOrderStore: (storage: Storage, owner: string) => OrderStore;       // key `chit-orders:<owner lowercased>`
export const pendingIndices: (r: OrderRecord) => number[];                            // slices in state "pending" or "rejected" with attempts < MAX_ATTEMPTS, not cancelled
export const markSent: (r: OrderRecord, indices: number[]) => OrderRecord;            // pending/rejected → sent, attempts + 1
export const applyResults: (r: OrderRecord, executed: { index: number; status: string; txHash?: string; userOpHash?: string; reason?: string }[]) => OrderRecord;
   // sponsored → "sponsored" with hash; rejected → "rejected" if attempts < MAX_ATTEMPTS else "failed"; a "sent" slice the response did not mention returns to "pending" only if its dueAt is in the future, else stays "sent" (nothing happened: it was not due) → see test
export const markUnconfirmed: (r: OrderRecord, indices: number[]) => OrderRecord;      // sent → unconfirmed (response lost); never re-sent
export const reconcile: (r: OrderRecord, spentDeltaWei: string) => OrderRecord;        // unconfirmed slices become sponsored, smallest first, while their sum ≤ spentDelta; the rest become failed
export const progress: (r: OrderRecord) => { done: number; total: number; nextDueAt: string | undefined; finished: boolean };
```

- [ ] **Step 1: Write the failing tests**
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyResults, createOrderStore, markSent, markUnconfirmed, MAX_ATTEMPTS, pendingIndices, progress, reconcile, type OrderRecord } from "../src/fleet/orders.js";

const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const record = (): OrderRecord => ({
  order: { id: `0x${"aa".repeat(32)}`, campaign: "c-1", token: wallet(0x77), totalWei: "3000", wallets: [1, 2, 3].map(wallet), entropy: `0x${"ab".repeat(32)}`, windowMs: 300_000, createdAt: "2026-09-15T12:00:00.000Z", owner: wallet(0x99) },
  symbol: "FLEET", cancelled: false, placedAt: "2026-09-15T12:00:00.000Z",
  slices: [
    { index: 0, wallet: wallet(1), amountWei: "1000", dueAt: "2026-09-15T12:01:00.000Z", state: "pending", attempts: 0 },
    { index: 1, wallet: wallet(2), amountWei: "1200", dueAt: "2026-09-15T12:03:00.000Z", state: "pending", attempts: 0 },
    { index: 2, wallet: wallet(3), amountWei: "800", dueAt: "2026-09-15T12:05:00.000Z", state: "pending", attempts: 0 },
  ],
});
class MemoryStorage implements Storage { #m = new Map<string, string>(); get length() { return this.#m.size; } clear() { this.#m.clear(); } getItem(k: string) { return this.#m.get(k) ?? null; } key(i: number) { return [...this.#m.keys()][i] ?? null; } removeItem(k: string) { this.#m.delete(k); } setItem(k: string, v: string) { this.#m.set(k, v); } }

test("a slice is marked sent before any response, so a lost reply can never re-send it", () => {
  const sent = markSent(record(), [0, 1]);
  assert.deepEqual(sent.slices.map((s) => s.state), ["sent", "sent", "pending"]);
  assert.deepEqual(pendingIndices(sent), [2]);
  const lost = markUnconfirmed(sent, [0, 1]);
  assert.deepEqual(lost.slices.map((s) => s.state), ["unconfirmed", "unconfirmed", "pending"]);
  assert.deepEqual(pendingIndices(lost), [2], "unconfirmed slices are never pending again");
});

test("results settle sent slices; a rejected slice may retry twice, then fails", () => {
  let r = markSent(record(), [0, 1, 2]);
  r = applyResults(r, [{ index: 0, status: "sponsored", txHash: "0x01" }, { index: 1, status: "rejected", reason: "swap_reverted" }]);
  assert.equal(r.slices[0]!.state, "sponsored");
  assert.equal(r.slices[0]!.txHash, "0x01");
  assert.equal(r.slices[1]!.state, "rejected");
  assert.equal(r.slices[2]!.state, "pending", "a sent slice the service did not run (not due yet) goes back to pending");
  assert.deepEqual(pendingIndices(r), [1, 2]);
  for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) r = applyResults(markSent(r, [1]), [{ index: 1, status: "rejected" }]);
  assert.equal(r.slices[1]!.state, "failed");
  assert.deepEqual(pendingIndices(r), [2]);
});

test("reconcile settles unconfirmed slices against what the draw actually spent", () => {
  const lost = markUnconfirmed(markSent(record(), [0, 1]), [0, 1]);
  const settled = reconcile(lost, "1000");
  assert.deepEqual(settled.slices.map((s) => s.state), ["sponsored", "failed", "pending"], "only the spend that happened is credited, smallest slice first");
  assert.equal(reconcile(lost, "5000").slices.filter((s) => s.state === "sponsored").length, 2);
});

test("progress counts done slices and finds the next due pending one; a cancelled order is finished", () => {
  const r = applyResults(markSent(record(), [0]), [{ index: 0, status: "sponsored", txHash: "0x01" }]);
  assert.deepEqual(progress(r), { done: 1, total: 3, nextDueAt: "2026-09-15T12:03:00.000Z", finished: false });
  assert.equal(progress({ ...r, cancelled: true }).finished, true);
  assert.deepEqual(pendingIndices({ ...r, cancelled: true }), []);
});

test("the store keeps orders per owner and survives a reload", () => {
  const storage = new MemoryStorage();
  const store = createOrderStore(storage, wallet(0x99));
  store.add(record());
  store.update(record().order.id, (r) => markSent(r, [0]));
  assert.equal(createOrderStore(storage, wallet(0x99)).get(record().order.id)?.slices[0]?.state, "sent");
  assert.equal(createOrderStore(storage, wallet(0x98)).list().length, 0, "another owner sees nothing");
});
```
- [ ] **Step 2: Red.** `cd app && node --import tsx --test test/app-orders.test.ts` fails on the missing module. Commit: `test(app): the order store marks a slice sent before the reply, retries twice, and reconciles lost replies`.
- [ ] **Step 3: Implement `app/src/fleet/orders.ts`** to the interfaces above. Rules: `pendingIndices` excludes cancelled orders and any slice not in `pending`/`rejected` or with `attempts >= MAX_ATTEMPTS`. `applyResults`: for each executed entry, `sponsored` → state `sponsored`, `txHash = txHash ?? userOpHash`; `rejected` → `attempts < MAX_ATTEMPTS ? "rejected" : "failed"`, keep `reason`; any slice left in `sent` after applying returns to `pending` (the service ran only what was due). `markUnconfirmed` moves `sent` → `unconfirmed`. `reconcile(spentDeltaWei)`: sort unconfirmed slices by `amountWei` ascending; credit while cumulative ≤ delta; the rest `failed`. `progress.done` counts `sponsored`; `nextDueAt` is the earliest `dueAt` among pending indices; `finished` = cancelled or no pending and no `sent`/`unconfirmed`. Store: JSON array under `chit-orders:<owner.toLowerCase()>`; `add` prepends; `update` maps by id and writes back.
- [ ] **Step 4: Green.** 5/5. Commit: `feat(app): a browser order store — sent before the reply, two retries, reconciled from what was spent`.

---

### Task 2: The Trade page markup, nav and build

**Files:**
- Create: `app/trade.html`
- Modify: `app/fleet.html`, `app/balance.html`, `app/fleet-dashboard.html`, `app/fleet-privacy.html` (nav gets Trade), `app/build.mjs`, `app/src/styles/pages.css`
- Test: `app/test/app-look.test.ts` (`NAV`, `PAGES` extended; new tests appended), `app/test/app-trade.test.ts` (new; claims rules over `trade.html`)

- [ ] **Step 1: Failing tests.** In `app-look.test.ts` change `NAV` to five entries — insert `["./trade.html", "Trade"]` after Set up — and `PAGES` to include `"trade.html"`. Append:
```ts
test("the Trade page: fleet card, order form, orders list, and the honest line about public trades", async () => {
  const html = await read("trade.html");
  assert.match(html, /<main id="trade" class="dash">/);
  for (const id of ["fleet-switch", "fleet-chip", "fleet-left", "holdings", "order-form", "o-token", "o-quote", "o-total", "o-plan", "o-place", "orders-open", "orders-past", "trade-error"]) assert.match(html, new RegExp(`id="${id}"`), `no #${id}`);
  assert.match(html, /<button id="o-place" type="submit" class="primary big" disabled>Place order<\/button>/);
  assert.match(html, /Trades stay public/);
  assert.doesNotMatch(html, /organic|volume/i, "the stagger hides the funder, it does not sell volume");
  assert.match(await read("build.mjs"), /"trade-page": new URL\("\.\/src\/trade-page\.ts"/);
  assert.match(await read("build.mjs"), /"\.\/trade\.html"/);
});
```
New `app/test/app-trade.test.ts`, the claims rules copied (not imported) from `test/fleet/fleet-claims.test.ts`:
```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const NEVER = ["untraceable", "unlinkab", "no trail"];
const ONLY_WHEN_DENIED = ["anonymous", "hidden trade", "mainnet"];
const DENIAL = /\b(not|never|no|without|cannot|isn't|won't|will not|do not|does not|excludes?)\b/i;
test("the Trade page makes no claim the code does not keep", async () => {
  const text = await readFile(join(appRoot, "trade.html"), "utf8");
  for (const word of NEVER) assert.equal(text.toLowerCase().includes(word), false, `trade.html claims "${word}"`);
  const bad = text.split(/\n/).map((l) => l.trim()).filter((l) => ONLY_WHEN_DENIED.some((w) => new RegExp(w, "i").test(l)) && !DENIAL.test(l));
  assert.deepEqual(bad, []);
  const script = await readFile(join(appRoot, "src/trade-page.ts"), "utf8");
  assert.doesNotMatch(script, /https?:\/\//, "the page talks only to Chit's API");
  assert.match(script, /markSent\(/, "a slice must be marked sent before the request goes out");
});
```
- [ ] **Step 2: Red commit.** `test(app): the Trade page's shape, its nav entry, and its claims`.
- [ ] **Step 3: Markup.** `app/trade.html`: copy `fleet-dashboard.html`'s head, `<body class="fleet-body">`, `.fleet-shell`, `<header class="masthead">` (nav with `aria-current="page"` on Trade), the `#pool-status` pill, and footer; `theme-color #171513`; script `./trade-page.js`. Body of `<main id="trade" class="dash">`:
```html
<div id="status-banner" class="status-banner" role="status" aria-live="polite" hidden></div>
<section class="dash-card" aria-labelledby="fleet-h">
  <div class="dash-head"><h1 id="fleet-h">Trade</h1><span id="fleet-chip" class="state-chip" data-live="false">No fleet</span></div>
  <label class="field"><span>Fleet</span><select id="fleet-switch" aria-label="Which fleet trades"></select></label>
  <dl class="summary"><div><dt>ETH left to spend</dt><dd id="fleet-left">—</dd></div></dl>
  <p class="cardlabel">Holdings</p>
  <dl class="summary" id="holdings"><div><dt>Nothing bought yet</dt><dd>—</dd></div></dl>
</section>
<section class="dash-card" aria-labelledby="order-h">
  <h2 id="order-h">Buy a token with every wallet</h2>
  <p class="lead">One token, one total. Each wallet buys its own slice, at its own moment, inside about the window shown. Trades stay public; only who funded the fleet is withheld.</p>
  <form id="order-form" novalidate>
    <div class="field"><label for="o-token">Token address</label><input id="o-token" name="token" type="text" inputmode="text" placeholder="0x…" autocomplete="off" /></div>
    <p id="o-quote" class="fineprint" role="status" aria-live="polite"></p>
    <div class="field"><label for="o-total">Total to spend (ETH)</label><input id="o-total" name="total" type="text" inputmode="decimal" value="0.005" /></div>
    <p id="o-plan" class="fineprint" role="status" aria-live="polite"></p>
    <p id="trade-error" class="field-error" role="alert" hidden></p>
    <button id="o-place" type="submit" class="primary big" disabled>Place order</button>
  </form>
</section>
<section class="dash-card" aria-labelledby="orders-h">
  <h2 id="orders-h">Orders</h2>
  <p class="cardlabel">Running</p>
  <ul id="orders-open" class="order-list"></ul>
  <p class="cardlabel">Past</p>
  <ul id="orders-past" class="order-list"></ul>
</section>
```
Add `<a href="./trade.html">Trade</a>` after the Set up link in every page's nav (five pages, `aria-current` only on trade.html). `build.mjs`: copy `./trade.html` beside `fleet-dashboard.html`, entry `"trade-page": …/src/trade-page.ts`. Also copy `trade.html` in `scripts/assemble-site.mjs` if it lists pages explicitly (check; the redesign pages were added there).
- [ ] **Step 4: CSS**, appended to `pages.css` under `/* ---- Trade ---- */`: `.order-list { display: grid; gap: 0.75rem; margin: 0 0 1.25rem; padding: 0; list-style: none; }`, `.order { display: grid; gap: 0.5rem; padding: 0.9rem 1rem; border: 1px solid rgba(245, 239, 229, 0.1); border-radius: var(--radius-inner); background: rgba(0, 0, 0, 0.25); }`, `.order__head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }`, `.order__meta { color: var(--text-muted); font-size: 0.85rem; }`, `.order__slices { display: grid; gap: 0.25rem; margin: 0; padding: 0; list-style: none; font-family: var(--font-mono); font-size: 0.8rem; }`, `.order__slices li { display: flex; justify-content: space-between; gap: 0.75rem; overflow-wrap: anywhere; }`, `.order__slices a { color: var(--soft-paper); }`, `.order[data-done="true"] .order__head h3 { color: var(--paper); }`. The meter reuses `.meter`/`.meter__fill`.
- [ ] **Step 5: Green + verify.** `cd app && node --import tsx --test test/app-*.test.ts` and `npm --prefix app run verify` (the TS entry may be an empty `trade-page.ts` that only calls `initHeaderWallet(); initShell();` for now). Commit: `feat(app): the Trade page's markup, nav entry and build`.

---

### Task 3: The page script

**Files:**
- Create: `app/src/trade-page.ts`
- Modify: `app/src/fleet/page-shared.ts` (no-key list), `app/src/fleet/led.ts` unchanged
- Test: `app/test/app-look.test.ts` (append)

**Interfaces consumed:** `signedFleetApi(wallet, action, body)` (`app/src/fleet/signed-request.ts`), `getConnectedWallet`, `initHeaderWallet`, `initShell`, `parseEth`, `toEth`, `loadFleetSnapshot`, `saveFleetSnapshot`, `confirmDialog`, `renderLed`, `stateLabel`, `isLiveState`, the order store (Task 1), `readBalance` (`app/src/fleet/balance-read.ts`) for reconcile via `spent`.

- [ ] **Step 1: Failing test**, appended to app-look:
```ts
test("the Trade page marks slices sent before it asks, never re-sends an unconfirmed one, and asks before it signs", async () => {
  const script = await read("src/trade-page.ts");
  const poll = /async #poll\([\s\S]*?\n  \}/.exec(script);
  assert.ok(poll, "no #poll");
  assert.ok(poll[0].indexOf("markSent(") < poll[0].indexOf('signedFleetApi(wallet, "trade"'), "the request leaves before the slices are marked sent");
  assert.match(poll[0], /markUnconfirmed\(/, "a lost reply leaves slices pending, so they would be re-sent");
  assert.match(script, /pending: pendingIndices\(/, "the service must receive only what the browser still holds");
  const place = /async #place\([\s\S]*?\n  \}/.exec(script);
  assert.ok(place && place[0].indexOf("confirmDialog(") < place[0].indexOf('signedFleetApi(wallet, "order"'), "placing an order does not confirm first");
  assert.match(await read("src/fleet/page-shared.ts"), /\["quote", "challenge", "read", "balance", "status", "tokenQuote", "order", "list", "holdings"\]/, "signed reads must not carry an idempotency key");
});
```
- [ ] **Step 2: Red commit.** `test(app): the Trade page's order loop — sent before asked, reconciled when lost`.
- [ ] **Step 3: Implement `trade-page.ts`.** Shape, following `fleet-dashboard.ts`'s class style:
```ts
class TradePage {
  #wallet?: Hex; #fleets: Fleet[] = []; #fleet?: Fleet; #store?: OrderStore; #quote?: Quote; #timer?: number;
  start() { bind #fleet-switch change → #selectFleet; #o-token blur/input(debounced 400ms) → #quoteToken; #o-total input → #preview; #order-form submit → #place; window "chit-wallet-changed" → #onWallet; if (getConnectedWallet()) #onWallet(); }
  async #onWallet() { wallet = getConnectedWallet(); if none → disable form, clear; else store = createOrderStore(localStorage, wallet); fleets = (await signedFleetApi(wallet, "list", {})).fleets; fill switch; select loadFleetSnapshot()?.campaign if listed else first; #render(); #schedule(); }
  async #selectFleet(campaign) { fleet = …; saveFleetSnapshot-compatible update of the current campaign; #holdings(); #preview(); }
  async #quoteToken() { token = value; if !/^0x[0-9a-fA-F]{40}$/ → quote line "" ; else q = await signedFleetApi(wallet, "tokenQuote", { campaign, token, totalWei }); quote = q; line = q.hasPool ? `${q.symbol} · pool found · about ${toEth(q.estimatedOut)} ${q.symbol} for the total (estimate)` : "No ETH pool for this token on the venue."; #preview(); }
  #preview() { enable #o-place only if quote?.hasPool && total parses && total ≤ fleet.remaining; #o-plan = `${fleet.accounts} wallets · about ${toEth(total / accounts)} ETH each · over about ${Math.round(quote.windowMs/60000)} minutes`; errors: over the draw → "More than this fleet has left (X ETH)."; over cap → "Each wallet's slice would pass the ${toEth(capWei)} ETH cap." }
  async #place(event) { preventDefault; const entropy = 0x + 32 random bytes (crypto.getRandomValues); body = { campaign, token, totalWei, wallets: (await signedFleetApi(wallet, "holdings", { campaign, tokens: [] })).holdings.map(h => h.wallet), entropy, createdAt: new Date().toISOString() }; if (!(await confirmDialog({ title: `Buy ${symbol} with ${wallets.length} wallets?`, body: `${toEth(totalWei)} ETH in ${n} slices over about ${m} minutes. Trades are public; only who funded the fleet is withheld.`, confirm: "Place order" }))) return; const { order, slices } = await signedFleetApi(wallet, "order", body); store.add({ order, symbol, slices: slices.map(s => ({ ...s, state: "pending", attempts: 0 })), cancelled: false, placedAt }); #render(); #poll(); }
  async #poll() { for each open order with pendingIndices(r) whose earliest dueAt ≤ now: const due = indices due now; store.update(id, r => markSent(r, due)); try { const res = await signedFleetApi(wallet, "trade", { campaign, order: r.order, pending: pendingIndices(store.get(id)) — careful: pass the indices you marked sent (the `due` list) }); store.update(id, r => applyResults(r, res.executed)); } catch (error) { if (error is RequestFailed with a 4xx code) store.update(id, r => applyResults(r, due.map(i => ({ index: i, status: "rejected", reason: code })))); else store.update(id, r => markUnconfirmed(r, due)); await #reconcile(id); } } #render(); #schedule(); }
  async #reconcile(id) { const before = r.spentSeen ?? …; read = await readBalance(wallet, { force: true }); … } // simplest faithful version: store `spentAtSend` on the record before sending (from the fleet's `remaining` via a fresh `list`), then after a lost reply read `list` again and pass the delta of `remaining` (as wei) to reconcile. Add `spentAtSend?: string` to OrderRecord if needed (Task 1 type may gain the optional field; update its test only by adding, never changing assertions).
  #schedule() { clearTimeout; next = min nextDueAt over open orders; if any sent/unconfirmed or pending: setTimeout(#poll, clamp(next - now, 5s, 60s)); }
  #render() { chip = stateLabel(fleet.state), dataset.live = isLiveState; fleet-left = LED toEth(remaining); holdings rows (symbol from store's known tokens); open orders: h3 `${symbol} · ${toEth(total)} ETH`, meta `${done}/${total} slices · next in about ${minutes} min` or `waiting for a reply on N slices`, meter --fill = done/total, slice rows with explorer links `https://…` NOT allowed in app code → link text only, the hash shown as mono text with a Copy button, or use the explorer base from `ROBINHOOD_TESTNET` in page-shared if it has one (it lists rpc/explorer for wallet_addEthereumChain; reuse `ROBINHOOD_TESTNET.blockExplorerUrls[0]` — that is data, not a fetch, and it is already in the app); Cancel button (ghost) → cancelled = true; past orders when progress().finished. }
}
initHeaderWallet(); initShell(); new TradePage().start();
```
In `page-shared.ts` line 55 the no-key list becomes `["quote", "challenge", "read", "balance", "status", "tokenQuote", "order", "list", "holdings"]`.
Errors from the service (`RequestFailed` with `code`) map to plain sentences in `#trade-error`: `no_pool` "No ETH pool for this token.", `over_draw` "More than this fleet has left.", `over_cap` "A slice would pass the per-trade cap.", `exit_pending` "You have an exit in progress; nothing new can leave the pool.", `state_not_sponsorable:*` "This fleet is not active.", anything else `Something went wrong: <code>`.
- [ ] **Step 4: Green.** `npm --prefix app run verify` green; then `npm run dev:local`, open http://localhost:3000/app/trade.html, connect MetaMask, paste the FLEET token `0x13283ab8e1f2bc4297e9ec6480c80c59674af554`, confirm the quote reads "FLEET · pool found". Placing a real order spends testnet ETH from the fleet's draw: do it once with 0.001 ETH if a funded fleet exists; otherwise record that it was not done. Commit (split TS from the page-shared edit if over 200): `feat(app): the Trade page — quote, plan, place, and drive an order from the open page`.

---

### Task 4: Render check, log, ship

**Files:** `scripts/app-shots.mjs` (add `"trade"` to `PAGES` and to `CONNECTED_PAGES`; the connected seed must also set a `chit-orders:<addr>` entry with one open and one past order so both lists render), `IMPLEMENTATION.md` (append), `.gitignore` unchanged.

- [ ] **Step 1:** Extend the shots script; run `npm run dev:local` (restart) then `npm run app:shots` → ok. Commit evidence PNGs for trade at 1440/390 (matched by the existing ignore rules). Look at `app/evidence/trade-390-connected.png` yourself before moving on.
- [ ] **Step 2:** Append to `IMPLEMENTATION.md`:
```markdown
## Trading panel, plan 2: the Trade page (2026-09-15)

A trader pastes a token address, sees whether the venue has an ETH pool for it and
roughly what the total buys, enters a total, and reads the plan: how many wallets,
about how much each, over about how long. Placing the order confirms in a dialog and
signs once. From then on the open page drives it: on each poll the browser marks the
due slices as sent *before* asking the service to run them, sends only the indices it
still holds, and settles each from the reply. A reply that never comes leaves those
slices "unconfirmed", never re-sent, and settled against what the fleet's draw actually
spent. A rejected slice retries twice, then fails. Orders live in the browser under
`chit-orders:<owner>`; there is nothing to list from the service. The page says trades
stay public and never sells volume: the stagger hides who funded the fleet, nothing
else. `order` and `trade` now refuse while the wallet's exit is pending.
```
- [ ] **Step 3:** `npm --prefix app run verify`, `(cd landing && npm run verify)`, `./verify.sh fleet-trade fleet-acceptance pool-balance`, then rebase on `origin/main` (keep both IMPLEMENTATION.md entries on conflict), re-run the app verify, and push `HEAD:main`. No attribution.

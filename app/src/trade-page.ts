/**
 * Trade page: quote a token, plan a fleet buy, place it as a signed order, and
 * drive it to completion from the open page.
 *
 * The browser is the order's only store (see `./fleet/orders.js`). The one
 * rule that keeps a slice from running twice across service instances: a
 * slice is marked sent before the request that could execute it leaves, never
 * after. If the reply never comes back, that slice becomes "unconfirmed" and
 * is reconciled against how much the fleet's draw actually spent, read fresh
 * from `list` — never re-sent on a guess.
 */

import type { Hex } from "viem";

import { isLiveState } from "./fleet/control-room.js";
import { renderLed } from "./fleet/led.js";
import { stateLabel } from "./fleet/balance.js";
import {
  applyResults,
  createOrderStore,
  markSent,
  markUnconfirmed,
  markUnsent,
  pendingIndices,
  progress,
  reconcile,
  type ExecutedSlice,
  type OrderRecord,
  type OrderStore,
  type SliceRecord,
  type WireOrder,
} from "./fleet/orders.js";
import { askBeforeSigning, confirmDialog, dropSigningAsk, fleetApi, getConnectedWallet, initHeaderWallet, initShell, loadFleetSnapshot, parseEth, toEth } from "./fleet/page-shared.js";
import { forgetSignedReads, readSigned, recentSigned } from "./fleet/signed-read.js";
import { orderTrade, RequestFailed, SignatureMissing, signedFleetApi } from "./fleet/signed-request.js";
import { readStatus } from "./fleet/status-read.js";

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node as T;
};

type Fleet = { campaign: string; state: string; remaining: string; accounts: number };
type Quote = { symbol: string; hasPool: boolean; estimatedOut: string; windowMs: number; capWei: string; minOut?: string; boundBps?: number };
type ListedToken = { token: string; symbol: string; decimals: number; boundBps: number };
type Holding = { wallet: string; eth: string; tokens: Record<string, string> };
type HoldingsReply = { holdings?: Holding[]; symbols?: Record<string, string> };
type PlannedSlice = { index: number; wallet: string; amountWei: string; dueAt: string };

const randomEntropy = (): Hex => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
};

const shortHash = (hash: string): string => (hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash);

const ERROR_TEXT: Record<string, string> = {
  no_pool: "No ETH pool for this token.",
  over_draw: "More than this fleet has left.",
  over_cap: "A slice would pass the per-trade cap.",
  exit_pending: "You have an exit in progress; nothing new can leave the pool.",
};

class TradePage {
  #wallet: Hex | undefined;
  #fleets: Fleet[] = [];
  #fleet: Fleet | undefined;
  #store: OrderStore | undefined;
  #quote: Quote | undefined;
  #timer: number | undefined;
  #quoteTimer: number | undefined;
  /** The poll in flight, if any; a second request waits for it and runs once more. */
  #polling: Promise<void> | undefined;
  #pollAgain = false;
  /** The trader clicked Continue: the next poll may open the wallet. */
  #signNext = false;

  start(): void {
    el<HTMLSelectElement>("fleet-switch").addEventListener("change", (event) => {
      void this.#selectFleet((event.target as HTMLSelectElement).value);
    });
    const token = el<HTMLInputElement>("o-token");
    token.addEventListener("blur", () => {
      // Leaving the field quotes now; the typing timer would only ask a second time.
      window.clearTimeout(this.#quoteTimer);
      void this.#quoteToken();
    });
    token.addEventListener("input", () => {
      if (this.#quoteTimer !== undefined) window.clearTimeout(this.#quoteTimer);
      this.#quoteTimer = window.setTimeout(() => void this.#quoteToken(), 400);
    });
    void this.#bindPicker();
    el<HTMLInputElement>("o-total").addEventListener("input", () => this.#preview());
    el<HTMLFormElement>("order-form").addEventListener("submit", (event) => void this.#place(event));
    window.addEventListener("chit-wallet-changed", () => void this.#onWallet());
    if (getConnectedWallet()) void this.#onWallet();
  }

  /** Reloads the fleet list for the connected wallet, or clears the page when it disconnects. */
  async #onWallet(): Promise<void> {
    const wallet = getConnectedWallet();
    this.#wallet = wallet;
    dropSigningAsk();
    if (!wallet) {
      this.#store = undefined;
      this.#fleets = [];
      this.#fleet = undefined;
      this.#quote = undefined;
      el<HTMLSelectElement>("fleet-switch").replaceChildren();
      if (this.#timer !== undefined) {
        window.clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#preview();
      this.#render();
      return;
    }
    this.#store = createOrderStore(localStorage, wallet);
    // Orders already placed run on their own tokens, whatever the list read does.
    this.#render();
    this.#schedule();
    let asked = false;
    if (!recentSigned(wallet, "list", {})) {
      await askBeforeSigning(this.#gateHost(), "Your fleets are private to your wallet.", "Show my fleets");
      if (getConnectedWallet() !== wallet) return;
      asked = true;
    }
    try {
      const body = (await readSigned(wallet, "list", {})) as { fleets?: Fleet[] };
      this.#fleets = await Promise.all((body.fleets ?? []).map((fleet) => this.#live(fleet)));
    } catch {
      this.#fleets = [];
    }
    const select = el<HTMLSelectElement>("fleet-switch");
    select.replaceChildren();
    for (const fleet of this.#fleets) {
      const option = document.createElement("option");
      option.value = fleet.campaign;
      option.textContent = `${fleet.campaign.slice(0, 8)}… · ${stateLabel(fleet.state)}`;
      select.append(option);
    }
    const saved = loadFleetSnapshot()?.campaign;
    const initial = (saved && this.#fleets.some((fleet) => fleet.campaign === saved) ? saved : this.#fleets[0]?.campaign);
    if (initial) await this.#selectFleet(initial, asked);
    else this.#render();
  }

  /** Where the page asks before a signed read: the fleet card, above the order form. */
  #gateHost(): HTMLElement {
    return el("fleet-switch").closest("section") ?? el("trade");
  }

  /** The list may be a cached answer; state and what's left come from the unsigned status read. */
  async #live(fleet: Fleet): Promise<Fleet> {
    try {
      const status = await readStatus(fleet.campaign);
      return { ...fleet, state: status.state, remaining: status.draw?.remaining ?? fleet.remaining };
    } catch {
      return fleet;
    }
  }

  /** `asked`: the trader clicked for this, so a signed read may open the wallet. */
  async #selectFleet(campaign: string, asked = true): Promise<void> {
    this.#fleet = this.#fleets.find((fleet) => fleet.campaign === campaign);
    const select = el<HTMLSelectElement>("fleet-switch");
    if (select.value !== campaign) select.value = campaign;
    this.#render();
    void this.#quoteToken();
    await this.#holdings(asked);
  }

  /**
   * Sums holdings across the fleet's wallets: the venue's tokens always (the
   * service adds them), plus any token an order in this browser has touched.
   */
  async #holdings(asked: boolean): Promise<void> {
    const wallet = this.#wallet;
    const fleet = this.#fleet;
    if (!wallet || !fleet) return;
    const recent = recentSigned(wallet, "holdings", this.#holdingsBody(fleet));
    if (recent) {
      this.#renderHoldings(recent as HoldingsReply);
      return;
    }
    if (!asked) {
      await askBeforeSigning(this.#gateHost(), "What your fleet holds is private to your wallet.", "Show holdings");
      if (this.#wallet !== wallet || this.#fleet !== fleet) return;
    }
    try {
      this.#renderHoldings((await this.#readHoldings(wallet, fleet)) as HoldingsReply);
    } catch {
      // A failed read leaves the last known holdings on screen rather than an error banner.
    }
  }

  #renderHoldings(body: HoldingsReply): void {
    const fleet = this.#fleet;
    if (!fleet) return;
    const tokens = this.#orderTokens(fleet);
    const totals = new Map<string, bigint>();
    for (const holding of body.holdings ?? []) {
      for (const [token, amount] of Object.entries(holding.tokens)) {
        const key = token.toLowerCase();
        totals.set(key, (totals.get(key) ?? 0n) + BigInt(amount));
        if (!tokens.has(key)) tokens.set(key, body.symbols?.[key] ?? key.slice(0, 8));
      }
    }
    if (tokens.size === 0) return;
    const dl = el("holdings");
    dl.replaceChildren();
    for (const [token, symbol] of tokens) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = symbol;
      const dd = document.createElement("dd");
      dd.textContent = `${toEth((totals.get(token) ?? 0n).toString())} ${symbol}`;
      row.append(dt, dd);
      dl.append(row);
    }
  }

  /** Every token an order in this browser has touched for the fleet, with its symbol. */
  #orderTokens(fleet: Fleet): Map<string, string> {
    const tokens = new Map<string, string>();
    for (const record of this.#store?.list() ?? []) {
      if (record.order.campaign === fleet.campaign) tokens.set(record.order.token.toLowerCase(), record.symbol);
    }
    return tokens;
  }

  /** One body for every holdings read, so placing an order reuses the one the page already made. */
  #holdingsBody(fleet: Fleet): Record<string, unknown> {
    return { campaign: fleet.campaign, tokens: [...this.#orderTokens(fleet).keys()] };
  }

  #readHoldings(wallet: Hex, fleet: Fleet): Promise<Record<string, unknown>> {
    return readSigned(wallet, "holdings", this.#holdingsBody(fleet));
  }

  /** Quotes the pasted token against the fleet's current total, on blur or 400ms after typing stops. */
  /**
   * The token picker (T071): where the service keeps a registry, the field
   * becomes a list of its enabled entries and nothing else; a token not in
   * it is not an error, it is simply not offered. Without a registry the
   * free entry stays, as on the testnet.
   */
  async #bindPicker(): Promise<void> {
    let listed: ListedToken[] = [];
    try {
      const { status, body } = await fleetApi("tokens", { action: "tokens", body: {} });
      if (status === 200 && Array.isArray(body["tokens"])) listed = body["tokens"] as ListedToken[];
    } catch {
      // The free entry stays; the service refuses an unlisted token either way.
    }
    if (listed.length === 0) return;
    const input = el<HTMLInputElement>("o-token");
    const select = document.createElement("select");
    select.id = "o-token";
    select.name = "token";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Choose a token";
    select.append(blank);
    for (const entry of listed) {
      const option = document.createElement("option");
      option.value = entry.token;
      option.textContent = `${entry.symbol} · ${entry.token.slice(0, 6)}…${entry.token.slice(-4)}`;
      select.append(option);
    }
    select.addEventListener("change", () => void this.#quoteToken());
    input.replaceWith(select);
  }

  async #quoteToken(): Promise<void> {
    const wallet = this.#wallet;
    const fleet = this.#fleet;
    const token = el<HTMLInputElement>("o-token").value.trim();
    const line = el("o-quote");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
      this.#quote = undefined;
      line.textContent = "";
      this.#preview();
      return;
    }
    if (!wallet || !fleet) return;
    let totalWei = "0";
    try {
      totalWei = parseEth(el<HTMLInputElement>("o-total").value);
    } catch {
      // The quote still resolves against a zero total; the plan preview catches an empty amount.
    }
    try {
      // Typing then leaving the field asks twice for the same quote; a recent answer serves both.
      const quote = (await readSigned(wallet, "tokenQuote", { campaign: fleet.campaign, token, totalWei }, { maxAgeMs: 60_000 })) as Quote;
      this.#quote = quote;
      // The bound in force, as the least the fleet will receive, beside the estimate (FR-013, T068).
      const least = quote.hasPool && quote.minOut && quote.boundBps !== undefined
        ? ` · at least ${toEth(quote.minOut)} ${quote.symbol} (the bound is ${quote.boundBps / 100}%; a fill under it is refused)`
        : "";
      line.textContent = quote.hasPool
        ? `${quote.symbol} · pool found · about ${toEth(quote.estimatedOut)} ${quote.symbol} for the total (estimate)${least}`
        : "No ETH pool for this token on the venue.";
    } catch (error) {
      this.#quote = undefined;
      line.textContent = error instanceof RequestFailed ? this.#errorText(error.code) : "Couldn't reach Chit's API.";
    }
    this.#preview();
  }

  /** Recomputes the plan preview and whether Place order may be pressed. */
  #preview(): void {
    const placeButton = el<HTMLButtonElement>("o-place");
    const planLine = el("o-plan");
    const errorLine = el<HTMLParagraphElement>("trade-error");
    errorLine.hidden = true;
    errorLine.textContent = "";
    placeButton.disabled = true;
    planLine.textContent = "";
    const fleet = this.#fleet;
    const quote = this.#quote;
    if (!fleet || !quote || !quote.hasPool) return;
    let totalWei: string;
    try {
      totalWei = parseEth(el<HTMLInputElement>("o-total").value);
    } catch {
      return;
    }
    if (BigInt(totalWei) <= 0n) return;
    if (BigInt(totalWei) > BigInt(fleet.remaining)) {
      errorLine.textContent = `More than this fleet has left (${toEth(fleet.remaining)} ETH).`;
      errorLine.hidden = false;
      return;
    }
    const accounts = BigInt(Math.max(1, fleet.accounts));
    const perWallet = BigInt(totalWei) / accounts;
    if (perWallet > BigInt(quote.capWei)) {
      errorLine.textContent = `Each wallet's slice would pass the ${toEth(quote.capWei)} ETH cap.`;
      errorLine.hidden = false;
      return;
    }
    planLine.textContent = `${fleet.accounts} wallets · about ${toEth(perWallet.toString())} ETH each · over about ${Math.round(quote.windowMs / 60_000)} minutes`;
    placeButton.disabled = false;
  }

  /** Confirms, signs once, and starts a new order; the actual sends happen from #poll. */
  async #place(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const wallet = this.#wallet;
    const fleet = this.#fleet;
    const quote = this.#quote;
    const store = this.#store;
    const errorLine = el<HTMLParagraphElement>("trade-error");
    errorLine.hidden = true;
    if (!wallet || !fleet || !quote || !quote.hasPool || !store) return;
    const token = el<HTMLInputElement>("o-token").value.trim();
    let totalWei: string;
    try {
      totalWei = parseEth(el<HTMLInputElement>("o-total").value);
    } catch {
      errorLine.textContent = "Enter a valid ETH amount.";
      errorLine.hidden = false;
      return;
    }
    try {
      const holdingsBody = (await this.#readHoldings(wallet, fleet)) as { holdings?: Holding[] };
      const wallets = (holdingsBody.holdings ?? []).map((holding) => holding.wallet);
      const accounts = wallets.length || fleet.accounts;
      const perWallet = accounts > 0 ? toEth((BigInt(totalWei) / BigInt(accounts)).toString()) : toEth(totalWei);
      const minutes = Math.round(quote.windowMs / 60_000);
      const confirmed = await confirmDialog({
        title: `Buy ${quote.symbol} with ${wallets.length} wallets?`,
        body: `${toEth(totalWei)} ETH in ${wallets.length} slices (about ${perWallet} ETH each) over about ${minutes} minutes. Trades are public; only who funded the fleet is withheld.`,
        confirm: "Place order",
      });
      if (!confirmed) return;
      const createdAt = new Date().toISOString();
      const body = await signedFleetApi(wallet, "order", {
        campaign: fleet.campaign,
        token,
        totalWei,
        wallets,
        entropy: randomEntropy(),
        createdAt,
        // The fill accepted here: each slice is refused before it is sent if the pool no longer gives its share inside the bound.
        acceptedOut: quote.estimatedOut,
      });
      const order = body["order"] as WireOrder;
      const slices: SliceRecord[] = (body["slices"] as PlannedSlice[]).map((slice) => ({
        ...slice,
        state: "pending",
        attempts: 0,
      }));
      const orderToken = typeof body["orderToken"] === "string" ? body["orderToken"] : undefined;
      store.add({ order, symbol: quote.symbol, slices, cancelled: false, placedAt: createdAt, ...(orderToken ? { orderToken } : {}) });
      el<HTMLInputElement>("o-token").value = "";
      this.#quote = undefined;
      el("o-quote").textContent = "";
      this.#preview();
      this.#render();
      void this.#poll();
    } catch (error) {
      errorLine.textContent = error instanceof RequestFailed ? this.#errorText(error.code) : "Something went wrong. Nothing was placed.";
      errorLine.hidden = false;
    }
  }

  /**
   * One poll at a time. A timer tick and a freshly placed order both ask for a
   * poll; running two together could send the same due slices twice, so a
   * second request waits for the first and runs once more afterwards.
   */
  async #poll(sign = false): Promise<void> {
    if (sign) this.#signNext = true;
    if (this.#polling) {
      this.#pollAgain = true;
      return this.#polling;
    }
    this.#polling = (async () => {
      do {
        this.#pollAgain = false;
        const signNow = this.#signNext;
        this.#signNext = false;
        await this.#pollOnce(signNow);
      } while (this.#pollAgain);
    })().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  /**
   * Sends every due slice of every open order. Each order is re-read from the
   * store right before it is touched, and a slice is marked sent there before
   * its request leaves, so a reply that never arrives leaves it "unconfirmed"
   * rather than sent again. A confirmed rejection (a 4xx from the service)
   * settles the slice directly; anything else — a dropped connection, a
   * timeout — is a lost reply, reconciled from the unsigned status read.
   *
   * `sign`: the trader clicked Continue. Only then may a poll open the wallet;
   * a timer's poll that would need a signature leaves the order waiting.
   */
  async #pollOnce(sign: boolean): Promise<void> {
    const wallet = this.#wallet;
    const store = this.#store;
    if (!wallet || !store) return;
    const now = Date.now();
    for (const id of store.list().map((record) => record.order.id)) {
      const current = store.get(id);
      if (!current || current.cancelled) continue;
      if (current.needsSignature && !sign) continue;
      const dueNow = new Set(
        pendingIndices(current).filter((index) => {
          const slice = current.slices.find((entry) => entry.index === index);
          return slice !== undefined && Date.parse(slice.dueAt) <= now;
        }),
      );
      if (dueNow.size === 0) continue;
      if (!current.orderToken && !sign) {
        store.update(current.order.id, (record) => ({ ...record, needsSignature: true }));
        continue;
      }
      // The draw's remaining right now, without a signature: a lost reply is
      // settled against how far it falls.
      const remainingAtSend = await readStatus(current.order.campaign).then((body) => body.draw?.remaining, () => undefined);
      store.update(current.order.id, (record) => ({
        ...markSent(record, [...dueNow]),
        ...(remainingAtSend !== undefined ? { remainingAtSend } : {}),
      }));
      try {
        const res = await orderTrade(wallet, current.orderToken, {
          campaign: current.order.campaign,
          order: current.order,
          pending: pendingIndices(current).filter((index) => dueNow.has(index)),
        }, { sign });
        const executed = (res["executed"] as ExecutedSlice[] | undefined) ?? [];
        // A signed poll comes back with a fresh token, so the polls after it need no signature.
        const renewed = typeof res["orderToken"] === "string" ? { orderToken: res["orderToken"] } : {};
        store.update(current.order.id, (record) => ({ ...applyResults(record, executed), ...renewed, needsSignature: false }));
        // A trade that bought something returns what the fleet now holds, so the tile updates without a signature.
        if (res["holdings"] && current.order.campaign === this.#fleet?.campaign) this.#renderHoldings(res as HoldingsReply);
      } catch (error) {
        if (error instanceof SignatureMissing) {
          // The poll never left: nothing ran, and the order waits for the trader.
          store.update(current.order.id, (record) => ({ ...markUnsent(record, [...dueNow]), needsSignature: true }));
          continue;
        }
        if (error instanceof RequestFailed && error.status >= 400 && error.status < 500) {
          const reason = error.reason ? `${error.code}: ${error.reason}` : error.code;
          store.update(current.order.id, (record) =>
            applyResults(record, [...dueNow].map((index) => ({ index, status: "rejected", reason }))),
          );
        } else {
          store.update(current.order.id, (record) => markUnconfirmed(record, [...dueNow]));
          await this.#reconcile(current.order.id);
        }
      }
      // Even a lost reply may have spent the draw and bought tokens, so the next read is live.
      forgetSignedReads(wallet);
    }
    this.#render();
    this.#schedule();
  }

  /** Settles unconfirmed slices from the unsigned status read: no signature, no wallet or public RPC read. */
  async #reconcile(orderId: string): Promise<void> {
    const store = this.#store;
    const record = store?.get(orderId);
    if (!store || !record || record.remainingAtSend === undefined) return;
    try {
      const remaining = (await readStatus(record.order.campaign)).draw?.remaining;
      if (remaining === undefined) return;
      const before = BigInt(record.remainingAtSend);
      const now = BigInt(remaining);
      const spentDelta = (before > now ? before - now : 0n).toString();
      store.update(orderId, (current) => reconcile(current, spentDelta));
    } catch {
      // Left unconfirmed; the next poll tries to reconcile again.
    }
  }

  /** Schedules the next poll for the earliest due slice across every open order, clamped to [5s, 60s]. */
  #schedule(): void {
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    const store = this.#store;
    if (!store) return;
    // An order waiting for the trader's signature is not polled until they continue it.
    const records = store.list().filter((record) => !record.cancelled && !record.needsSignature);
    const dueTimes = records
      .map((record) => progress(record).nextDueAt)
      .filter((due): due is string => due !== undefined)
      .map((due) => Date.parse(due));
    const inFlight = records.some((record) => record.slices.some((slice) => slice.state === "sent" || slice.state === "unconfirmed"));
    if (dueTimes.length === 0 && !inFlight) return;
    const now = Date.now();
    const next = dueTimes.length > 0 ? Math.min(...dueTimes) : now;
    this.#timer = window.setTimeout(() => void this.#poll(), Math.min(60_000, Math.max(5_000, next - now)));
  }

  #render(): void {
    const chip = el("fleet-chip");
    const fleet = this.#fleet;
    chip.textContent = fleet ? stateLabel(fleet.state) : "No fleet";
    chip.dataset["live"] = String(fleet ? isLiveState(fleet.state) : false);
    renderLed(el("fleet-left"), fleet ? toEth(fleet.remaining) : "—", "ETH");
    this.#renderOrders();
  }

  #renderOrders(): void {
    const open = el<HTMLUListElement>("orders-open");
    const past = el<HTMLUListElement>("orders-past");
    open.replaceChildren();
    past.replaceChildren();
    for (const record of this.#store?.list() ?? []) {
      const item = this.#orderItem(record);
      if (progress(record).finished) past.append(item);
      else open.append(item);
    }
  }

  #orderItem(record: OrderRecord): HTMLLIElement {
    const { done, total, nextDueAt, finished } = progress(record);
    const li = document.createElement("li");
    li.className = "order";
    li.dataset["done"] = String(finished);

    const head = document.createElement("div");
    head.className = "order__head";
    const h3 = document.createElement("h3");
    h3.textContent = `${record.symbol} · ${toEth(record.order.totalWei)} ETH`;
    const meta = document.createElement("span");
    meta.className = "order__meta";
    const waiting = record.slices.filter((slice) => slice.state === "unconfirmed").length;
    meta.textContent =
      waiting > 0
        ? `waiting for a reply on ${waiting} slice${waiting === 1 ? "" : "s"}`
        : record.needsSignature && !finished
          ? `${done}/${total} slices · paused until you sign to continue`
          : nextDueAt
          ? `${done}/${total} slices · next in about ${Math.max(0, Math.round((Date.parse(nextDueAt) - Date.now()) / 60_000))} min`
          : `${done}/${total} slices`;
    head.append(h3, meta);

    const meter = document.createElement("div");
    meter.className = "meter";
    const fill = document.createElement("span");
    fill.className = "meter__fill";
    fill.style.setProperty("--fill", String(total > 0 ? done / total : 0));
    meter.append(fill);

    const slices = document.createElement("ul");
    slices.className = "order__slices";
    for (const slice of record.slices) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      // The reason rides along: "failed" alone says nothing a trader can act on.
      label.textContent = `${toEth(slice.amountWei)} ETH · ${slice.state}${slice.reason && slice.state !== "sponsored" ? ` · ${slice.reason}` : ""}`;
      row.append(label);
      if (slice.txHash) row.append(this.#hashRow(slice.txHash));
      slices.append(row);
    }

    li.append(head, meter, slices);
    if (record.needsSignature && !finished && !record.cancelled) {
      // The order's token lapsed (the tab was closed too long); one signature renews it.
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "primary";
      resume.textContent = "Sign to continue";
      resume.addEventListener("click", () => void this.#poll(true));
      li.append(resume);
    }
    if (!finished && !record.cancelled) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ghost";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        this.#store?.update(record.order.id, (current) => ({ ...current, cancelled: true }));
        this.#render();
      });
      li.append(cancel);
    }
    return li;
  }

  /** The slice's tx hash, shortened, with a button that copies the full hash — never a link off the page. */
  #hashRow(hash: string): HTMLElement {
    const wrap = document.createElement("span");
    const text = document.createElement("span");
    text.textContent = shortHash(hash);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "ghost";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(hash)
        .then(() => {
          copy.textContent = "Copied";
          el("copy-status").textContent = "Transaction hash copied.";
        })
        .catch(() => {
          copy.textContent = "Copy failed";
          el("copy-status").textContent = "Copy failed. Try again.";
        })
        .finally(() => {
          globalThis.setTimeout(() => {
            copy.textContent = "Copy";
          }, 1600);
        });
    });
    wrap.append(text, copy);
    return wrap;
  }

  #errorText(code: string): string {
    if (code in ERROR_TEXT) return ERROR_TEXT[code]!;
    if (code.startsWith("state_not_sponsorable:")) return "This fleet is not active.";
    return `Something went wrong: ${code}`;
  }
}

initHeaderWallet();
initShell();
new TradePage().start();

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
  pendingIndices,
  progress,
  reconcile,
  type ExecutedSlice,
  type OrderRecord,
  type OrderStore,
  type SliceRecord,
  type WireOrder,
} from "./fleet/orders.js";
import {
  confirmDialog,
  getConnectedWallet,
  initHeaderWallet,
  initShell,
  loadFleetSnapshot,
  parseEth,
  toEth,
} from "./fleet/page-shared.js";
import { RequestFailed, signedFleetApi } from "./fleet/signed-request.js";
import { readStatus } from "./fleet/status-read.js";

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node as T;
};

type Fleet = { campaign: string; state: string; remaining: string; accounts: number };
type Quote = { symbol: string; hasPool: boolean; estimatedOut: string; windowMs: number; capWei: string };
type Holding = { wallet: string; eth: string; tokens: Record<string, string> };
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

  start(): void {
    el<HTMLSelectElement>("fleet-switch").addEventListener("change", (event) => {
      void this.#selectFleet((event.target as HTMLSelectElement).value);
    });
    const token = el<HTMLInputElement>("o-token");
    token.addEventListener("blur", () => void this.#quoteToken());
    token.addEventListener("input", () => {
      if (this.#quoteTimer !== undefined) window.clearTimeout(this.#quoteTimer);
      this.#quoteTimer = window.setTimeout(() => void this.#quoteToken(), 400);
    });
    el<HTMLInputElement>("o-total").addEventListener("input", () => this.#preview());
    el<HTMLFormElement>("order-form").addEventListener("submit", (event) => void this.#place(event));
    window.addEventListener("chit-wallet-changed", () => void this.#onWallet());
    if (getConnectedWallet()) void this.#onWallet();
  }

  /** Reloads the fleet list for the connected wallet, or clears the page when it disconnects. */
  async #onWallet(): Promise<void> {
    const wallet = getConnectedWallet();
    this.#wallet = wallet;
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
    try {
      const body = (await signedFleetApi(wallet, "list", {})) as { fleets?: Fleet[] };
      this.#fleets = body.fleets ?? [];
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
    if (initial) await this.#selectFleet(initial);
    else this.#render();
    this.#schedule();
  }

  async #selectFleet(campaign: string): Promise<void> {
    this.#fleet = this.#fleets.find((fleet) => fleet.campaign === campaign);
    const select = el<HTMLSelectElement>("fleet-switch");
    if (select.value !== campaign) select.value = campaign;
    await this.#holdings();
    void this.#quoteToken();
    this.#render();
  }

  /**
   * Sums holdings across the fleet's wallets: the venue's tokens always (the
   * service adds them), plus any token an order in this browser has touched.
   */
  async #holdings(): Promise<void> {
    const wallet = this.#wallet;
    const fleet = this.#fleet;
    if (!wallet || !fleet) return;
    const tokens = new Map<string, string>();
    for (const record of this.#store?.list() ?? []) {
      if (record.order.campaign === fleet.campaign) tokens.set(record.order.token.toLowerCase(), record.symbol);
    }
    try {
      const body = (await signedFleetApi(wallet, "holdings", {
        campaign: fleet.campaign,
        tokens: [...tokens.keys()],
      })) as { holdings?: Holding[]; symbols?: Record<string, string> };
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
    } catch {
      // A failed read leaves the last known holdings on screen rather than an error banner.
    }
  }

  /** Quotes the pasted token against the fleet's current total, on blur or 400ms after typing stops. */
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
      const quote = (await signedFleetApi(wallet, "tokenQuote", { campaign: fleet.campaign, token, totalWei })) as Quote;
      this.#quote = quote;
      line.textContent = quote.hasPool
        ? `${quote.symbol} · pool found · about ${toEth(quote.estimatedOut)} ${quote.symbol} for the total (estimate)`
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
      const holdingsBody = (await signedFleetApi(wallet, "holdings", { campaign: fleet.campaign, tokens: [] })) as {
        holdings?: Holding[];
      };
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
      });
      const order = body["order"] as WireOrder;
      const slices: SliceRecord[] = (body["slices"] as PlannedSlice[]).map((slice) => ({
        ...slice,
        state: "pending",
        attempts: 0,
      }));
      store.add({ order, symbol: quote.symbol, slices, cancelled: false, placedAt: createdAt });
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
  async #poll(): Promise<void> {
    if (this.#polling) {
      this.#pollAgain = true;
      return this.#polling;
    }
    this.#polling = (async () => {
      do {
        this.#pollAgain = false;
        await this.#pollOnce();
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
   */
  async #pollOnce(): Promise<void> {
    const wallet = this.#wallet;
    const store = this.#store;
    if (!wallet || !store) return;
    const now = Date.now();
    for (const id of store.list().map((record) => record.order.id)) {
      const current = store.get(id);
      if (!current || current.cancelled) continue;
      const dueNow = new Set(
        pendingIndices(current).filter((index) => {
          const slice = current.slices.find((entry) => entry.index === index);
          return slice !== undefined && Date.parse(slice.dueAt) <= now;
        }),
      );
      if (dueNow.size === 0) continue;
      // The draw's remaining right now, without a signature: a lost reply is
      // settled against how far it falls.
      const remainingAtSend = await readStatus(current.order.campaign).then((body) => body.draw?.remaining, () => undefined);
      store.update(current.order.id, (record) => ({
        ...markSent(record, [...dueNow]),
        ...(remainingAtSend !== undefined ? { remainingAtSend } : {}),
      }));
      try {
        const res = await signedFleetApi(wallet, "trade", {
          campaign: current.order.campaign,
          order: current.order,
          pending: pendingIndices(current).filter((index) => dueNow.has(index)),
        });
        const executed = (res["executed"] as ExecutedSlice[] | undefined) ?? [];
        store.update(current.order.id, (record) => applyResults(record, executed));
      } catch (error) {
        if (error instanceof RequestFailed && error.status >= 400 && error.status < 500) {
          const reason = error.code;
          store.update(current.order.id, (record) =>
            applyResults(record, [...dueNow].map((index) => ({ index, status: "rejected", reason }))),
          );
        } else {
          store.update(current.order.id, (record) => markUnconfirmed(record, [...dueNow]));
          await this.#reconcile(current.order.id);
        }
      }
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
    const records = store.list().filter((record) => !record.cancelled);
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
      label.textContent = `${toEth(slice.amountWei)} ETH · ${slice.state}`;
      row.append(label);
      if (slice.txHash) row.append(this.#hashRow(slice.txHash));
      slices.append(row);
    }

    li.append(head, meter, slices);
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

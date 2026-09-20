/**
 * Chit Bot on mainnet: the same buttons, no key held (docs/bot-mainnet-mode.md).
 *
 * The owner keeps their wallet, creates a session account of their own on
 * the Sessions page, grants the bot's key a bounded session (which router,
 * how much a trade, how much in all, until when) and links the account to
 * their Telegram with one signature. From then on Buy is one `execute` on
 * their account, signed by the bot's key; the account pays the trade, the
 * bot pays the gas. Pause or revoke is the owner's, in one transaction.
 *
 * What this handler never does: hold a key of the owner's, sell (the
 * owner sells from the Sessions page in the beta), withdraw, or trade from
 * an account that was not linked with the owner's signature.
 */

import { type Address, type Hex, isAddress } from "viem";
import type { BotChain } from "./bot-chain.js";
import { heyLine, type HeyScanner } from "./bot-hey.js";
import { issueNonce, type BotLinkStore } from "./bot-link.js";
import { MAX_OPEN_ORDERS, newOrderId, type Order, type OrderStore } from "./bot-orders.js";
import { orusLine, type OrusScanner } from "./bot-orus.js";
import type { SessionChain } from "./bot-session-chain.js";
import { CAPTION_MAX_CHARS, esc, type Keyboard, type Outgoing, type Telegram } from "./bot-telegram.js";
import type { TokenPlateRenderer } from "./bot-token-card.js";
import { sessionState } from "./session-keys.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, minOutFor } from "./v4-swap.js";
import type { Update } from "./bot-handlers.js";

export type SessionBotDeps = {
  /** Token reads: price, pool, balances, quotes. Never used to sign here. */
  reads: BotChain;
  session: SessionChain;
  links: BotLinkStore;
  telegram: Telegram;
  orus?: OrusScanner;
  hey?: HeyScanner;
  plate?: TokenPlateRenderer;
  /** Standing orders (limit buys, DCA), fired by api/bot/orders.js; absent, the card offers none. */
  orders?: OrderStore;
  botUsername: string;
  siteUrl: string;
  /** Per user, per UTC day: how many executes and how much gas the bot fronts. */
  dailyExecutes?: number;
  dailyGasWei?: bigint;
  buySlippageBps?: number;
  buyPresetsEth?: string[];
  /** Set when the testnet playground lives in the same bot: the home cards offer the door. */
  playgroundFloor?: boolean;
  now?: () => Date;
};

const DEFAULTS = { dailyExecutes: 200, dailyGasWei: 2_000_000_000_000_000n, buySlippageBps: 300, buyPresetsEth: ["0.005", "0.01", "0.05"] };
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (units: bigint, decimals = 18, places = 5): string => {
  const neg = units < 0n; const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals); const whole = u / base; const frac = u % base;
  const f = frac.toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${f ? "." + f : ""}`;
};
const eth = (wei: bigint, places = 5): string => fmt(wei, 18, places);
const toWei = (s: string): bigint | null => {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) return null;
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
};
const kb = (...rows: Keyboard): Keyboard => rows;
const btn = (text: string, data: string) => ({ text, callback_data: data });
const url = (text: string, href: string) => ({ text, url: href });

/** One user's executes today, in this instance: enough to stop a loop; the chain-side caps are the real bound. */
type DayCount = { day: string; executes: number; gasWei: bigint };

export class SessionBot {
  readonly #d: SessionBotDeps;
  readonly #days = new Map<string, DayCount>();
  readonly #pending = new Map<string, { token: Address; order?: "limit" | "dca" }>();
  readonly #photos = new Set<string>();

  constructor(d: SessionBotDeps) { this.#d = d; }

  get #now(): Date { return this.#d.now ? this.#d.now() : new Date(); }
  #cfg<K extends keyof typeof DEFAULTS>(k: K): (typeof DEFAULTS)[K] { return (this.#d[k] as (typeof DEFAULTS)[K] | undefined) ?? DEFAULTS[k]; }

  async handle(u: Update): Promise<void> {
    if (u.message?.text && u.message.from) {
      const chatId = String(u.message.chat.id), tgId = String(u.message.from.id), text = u.message.text.trim();
      if (u.message.chat.type !== "private") return;
      const [cmd, arg] = text.split(/\s+/);
      if (cmd === "/start") return this.#start(chatId, tgId, arg);
      if (cmd === "/help") return this.#help(chatId);
      if (cmd === "/link") return this.#connect(chatId, tgId);
      const pending = this.#pending.get(tgId);
      if (pending && u.message.reply_to_message) { this.#pending.delete(tgId); return pending.order ? this.#placeOrder(chatId, tgId, pending.token, pending.order, text) : this.#buy(chatId, tgId, pending.token, text); }
      const pasted = text.match(/0x[0-9a-fA-F]{40}/)?.[0];
      if (pasted) return this.#tokenCard(chatId, tgId, pasted.toLowerCase() as Address);
      return this.#help(chatId);
    }
    const q = u.callback_query;
    if (!q?.message) return;
    const chatId = String(q.message.chat.id), tgId = String(q.from.id), messageId = q.message.message_id, data = q.data ?? "";
    if (q.message.photo) this.#photos.add(`${chatId}:${messageId}`);
    const ack = (text?: string) => this.#d.telegram.deliver({ kind: "answer", callbackId: q.id, ...(text ? { text } : {}) });
    const [verb, a, b] = data.split(":");
    switch (verb) {
      case "home": await ack(); return this.#home(chatId, tgId, messageId);
      case "connect": await ack(); return this.#connect(chatId, tgId);
      case "token": await ack(); return a && isAddress(a) ? this.#tokenCard(chatId, tgId, a as Address, messageId) : this.#help(chatId);
      case "b": await ack(); return a && isAddress(a) && b ? this.#buy(chatId, tgId, a as Address, b, true) : this.#help(chatId);
      case "ask": {
        await ack();
        if (!a || !isAddress(a)) return this.#help(chatId);
        this.#pending.set(tgId, { token: a as Address });
        return this.#d.telegram.deliver({ kind: "send", chatId, text: `how much ETH into <code>${a}</code>? reply with a number, like 0.02.`, ask: "amount in ETH" });
      }
      case "help": await ack(); return this.#help(chatId);
      // orders: the prompts, the list, a cancel (bot-orders.ts)
      case "lim": case "dca": {
        await ack();
        if (!a || !isAddress(a) || !this.#d.orders) return this.#help(chatId);
        this.#pending.set(tgId, { token: a as Address, order: verb === "lim" ? "limit" : "dca" });
        return this.#d.telegram.deliver(verb === "lim"
          ? { kind: "send", chatId, text: `limit buy on <code>${a}</code>: reply with the amount in eth, then the price as tokens per eth, like <code>0.02 at 1200000</code>. it buys when one eth gets at least that many tokens (the price per token at or below that level).`, ask: "amount in eth at tokens per eth" }
          : { kind: "send", chatId, text: `dca on <code>${a}</code>: reply with the amount, every N hours, N times, like <code>0.01 every 4 hours 6 times</code>. the first buy goes at the next check (within five minutes), the rest one interval apart.`, ask: "amount every N hours N times" });
      }
      case "orders": await ack(); return this.#orders(chatId, tgId, messageId);
      case "oc": await ack(); return a ? this.#cancelOrder(chatId, tgId, a, messageId) : this.#help(chatId);
      default: await ack(); return this.#home(chatId, tgId, messageId);
    }
  }

  // ---------- cards ----------

  async #out(chatId: string, messageId: number | undefined, text: string, keyboard: Keyboard, png?: Uint8Array): Promise<void> {
    const overPhoto = messageId !== undefined && this.#photos.has(`${chatId}:${messageId}`);
    let out: Outgoing;
    if (png && text.length <= CAPTION_MAX_CHARS) out = messageId && overPhoto ? { kind: "editPhoto", chatId, messageId, photo: png, text, keyboard } : { kind: "photo", chatId, photo: png, text, keyboard };
    else out = messageId && !overPhoto ? { kind: "edit", chatId, messageId, text, keyboard } : { kind: "send", chatId, text, keyboard };
    await this.#d.telegram.deliver(out);
  }
  #say(chatId: string, text: string, keyboard?: Keyboard): Promise<void> {
    return this.#d.telegram.deliver({ kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}) });
  }

  #mode(): string { return `<b>Robinhood Chain</b> · ${this.#d.session.chainId} · your keys stay with you`; }
  /** The door to the testnet playground, when it is in this bot. */
  #door(): Keyboard { return this.#d.playgroundFloor ? [[btn("🧪 Testnet playground", "floor:playground")]] : []; }

  async #start(chatId: string, tgId: string, param?: string): Promise<void> {
    const linked = param?.startsWith("t-") ? param.slice(2) : undefined;
    if (linked && isAddress(linked)) return this.#tokenCard(chatId, tgId, linked.toLowerCase() as Address);
    return this.#home(chatId, tgId);
  }

  async #home(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const link = await this.#d.links.getLink(tgId);
    if (!link) {
      const text = [
        this.#mode(),
        "",
        "the bot never holds your key. you keep your wallet, you create a session account of your own, you grant the bot's key a bounded session (which router, how much a trade, how much in all, until when), and every Buy is one call on your account that you can pause or revoke in one transaction.",
        "",
        `the bot's signer is <code>${this.#d.session.signer}</code>. the Sessions page shows it in full; if it differs, stop.`,
        "",
        "<i>beta. holders only. not audited by a firm yet, and we say so on every card.</i>",
      ].join("\n");
      return this.#out(chatId, messageId, text, kb([btn("🔗 Connect your wallet", "connect")], [btn("❓ Help", "help")], ...this.#door()));
    }
    const [s, ethBal] = await Promise.all([this.#d.session.sessionOf(link.account), this.#d.reads.ethBalance(link.account)]);
    const state = sessionState(s, Math.floor(this.#now.getTime() / 1000));
    const lines = [
      this.#mode(),
      `linked to <code>${link.account}</code> <i>(your session account; owner ${short(link.owner)})</i>`,
      `account holds: <code>${eth(ethBal)} ETH</code>`,
      this.#sessionLine(state, s),
      "",
      state === "active" ? "paste any token's contract address to see its card and buy from your account." : `manage the session on the <a href="${this.#d.siteUrl}/app/sessions.html">Sessions page</a>: fund, grant, pause, resume, revoke, withdraw. only you can.`,
      "<i>beta. holders only. not audited by a firm yet.</i>",
    ];
    return this.#out(chatId, messageId, lines.join("\n"), kb(
      [url("🔑 Sessions page", `${this.#d.siteUrl}/app/sessions.html`), btn("🔗 Re-link", "connect")],
      ...(this.#d.orders ? [[btn("📋 Orders", "orders")]] : []),
      [btn("❓ Help", "help"), btn("↻ Refresh", "home")],
      ...this.#door(),
    ));
  }

  #sessionLine(state: ReturnType<typeof sessionState>, s: { maxValuePerCall: string; totalValueCap: string; spentValue: string; expiry: number }): string {
    switch (state) {
      case "active": return `session <b>active</b>: <code>${eth(BigInt(s.maxValuePerCall), 4)} ETH</code> a trade, <code>${eth(BigInt(s.totalValueCap), 4)} ETH</code> in all (<code>${eth(BigInt(s.spentValue), 4)}</code> spent), until ${new Date(s.expiry * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      case "none": return "no session granted to the bot's key yet: grant one on the Sessions page.";
      case "paused": return "session <b>paused</b> by you. resume it on the Sessions page to buy again.";
      case "revoked": return "session <b>revoked</b>. grant a new key on the Sessions page to let the bot back in.";
      case "expired": return "session <b>expired</b>. grant a new one on the Sessions page.";
      case "spent": return "session <b>spent</b>: its total cap is used up. grant a new one on the Sessions page.";
    }
  }

  async #connect(chatId: string, tgId: string): Promise<void> {
    const nonce = await issueNonce(this.#d.links, tgId, this.#now);
    const href = `${this.#d.siteUrl}/app/sessions.html?link=${nonce}&key=${this.#d.session.signer}`;
    await this.#say(chatId, [
      "<b>connect your wallet</b>",
      "",
      "1. open the Sessions page from the button below (the only link this bot ever sends is chit.tools).",
      "2. create your account, fund it, grant the bot's key a session: 0.05 ETH a trade, 0.5 ETH in all, 7 days are the beta's defaults, the page fills them.",
      "3. press <b>Link to the bot</b> and sign the message in your wallet. the link is good for 15 minutes.",
      "",
      `the bot's signer: <code>${this.#d.session.signer}</code>`,
    ].join("\n"), kb([url("🔑 Open the Sessions page", href)], [btn("↻ I linked it", "home")]));
  }

  async #help(chatId: string): Promise<void> {
    await this.#say(chatId, [
      "<b>chit bot on mainnet</b>",
      "the key stays with you. link a session account once, then paste any token's address and buy from your account in one tap.",
      "sells, withdrawals and fleets are yours to do from the app in this beta.",
      "/link to connect or re-link. /start for your card.",
    ].join("\n"), kb([btn("← Back", "home")]));
  }

  async #tokenCard(chatId: string, tgId: string, token: Address, messageId?: number): Promise<void> {
    const link = await this.#d.links.getLink(tgId);
    if (!link) return this.#home(chatId, tgId);
    const [info, held, scan, hey] = await Promise.all([this.#d.reads.tokenInfo(token), this.#d.reads.tokenBalance(token, link.account), this.#d.orus?.scan(token), this.#d.hey?.scan(token)]);
    if (!info.hasPool) return this.#out(chatId, messageId, `<b>${esc(info.symbol)}</b> <code>${token}</code>\nno ETH pool on the venue for this token, so nothing to buy it with here.`, kb([btn("← Back", "home")]));
    const text = [
      `<b>${esc(info.symbol)}</b> · <code>${token}</code> <i>(tap to copy)</i>`,
      `price: <code>${fmt(info.perEth, info.decimals, 2)} ${esc(info.symbol)}</code> per ETH · pool: <code>${eth(info.poolEth, 4)} ETH</code>`,
      ...(scan && this.#d.orus ? [`orus: ${orusLine(scan, this.#d.orus.link(token))}`] : []),
      ...(hey ? [`hey research lab: ${heyLine(hey)}`] : []),
      `your account holds: <code>${fmt(held, info.decimals, 4)} ${esc(info.symbol)}</code>`,
      "",
      `<i>buys run as one execute on your account, guarded at ${(this.#cfg("buySlippageBps") / 100).toString()}%; the reply carries the hash. sells are yours from the app in this beta.${info.hooked ? " hooked pool: the hook's fee is not in the quote." : ""}</i>`,
    ].join("\n");
    const png = this.#d.plate
      ? await this.#d.plate({ symbol: info.symbol, address: token, perEth: fmt(info.perEth, info.decimals, 2), poolEth: eth(info.poolEth, 4), hooked: info.hooked, chainLabel: "robinhood chain", testnet: this.#d.session.chainId !== 4663, ...(this.#d.orus ? { orus: scan ?? null } : {}), ...(this.#d.hey ? { hey: hey ?? null } : {}) }).catch(() => undefined)
      : undefined;
    await this.#out(chatId, messageId, text, kb(
      this.#cfg("buyPresetsEth").map((p) => btn(`Buy ${p} ETH`, `b:${token}:${p}`)),
      [btn("Buy custom", `ask:${token}`)],
      ...(this.#d.orders ? [[btn("⏱ Limit buy", `lim:${token}`), btn("🔁 DCA", `dca:${token}`)]] : []),
      [btn("↻ Refresh", `token:${token}`), btn("← Back", "home")],
    ), png);
  }

  // ---------- buy ----------

  #today(tgId: string): DayCount {
    const day = this.#now.toISOString().slice(0, 10);
    const c = this.#days.get(tgId);
    if (c && c.day === day) return c;
    const fresh = { day, executes: 0, gasWei: 0n };
    this.#days.set(tgId, fresh);
    return fresh;
  }

  async #buy(chatId: string, tgId: string, token: Address, amount: string, fromButton = false): Promise<void> {
    const link = await this.#d.links.getLink(tgId);
    if (!link) return this.#home(chatId, tgId);
    const wei = toWei(amount.trim());
    if (wei === null || wei <= 0n) return this.#say(chatId, "amount must be a number of ETH, like 0.02.", kb([btn("← Back", `token:${token}`)]));
    const count = this.#today(tgId);
    if (count.executes >= this.#cfg("dailyExecutes")) return this.#say(chatId, `that is ${this.#cfg("dailyExecutes")} buys today from this account; again tomorrow.`, kb([btn("← Back", `token:${token}`)]));
    if (count.gasWei >= this.#cfg("dailyGasWei")) return this.#say(chatId, "the bot has fronted its daily gas for this account; again tomorrow.", kb([btn("← Back", `token:${token}`)]));
    const [info, quote] = await Promise.all([this.#d.reads.tokenInfo(token), this.#d.reads.quoteBuy(token, wei)]);
    if (!info.hasPool || quote === null) return this.#say(chatId, "no ETH pool on the venue for this token.", kb([btn("← Back", "home")]));
    // The contract's own answer first, so a refused buy burns no gas and says why in the contract's words.
    const can = await this.#d.session.canExecute(link.account, this.#d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, wei);
    if (!can.ok) return this.#say(chatId, `your session says no: <b>${esc(can.why)}</b>. manage it on the Sessions page.`, kb([url("🔑 Sessions page", `${this.#d.siteUrl}/app/sessions.html`), btn("← Back", `token:${token}`)]));
    const minOut = minOutFor(quote, this.#cfg("buySlippageBps"));
    const deadline = BigInt(Math.floor(this.#now.getTime() / 1000) + 3600);
    const data = encodeV4EthBuy({ token, amountIn: wei, minOut, deadline, ...(info.poolKey ? { poolKey: info.poolKey } : {}) });
    await this.#say(chatId, `buying <code>${eth(wei)} ETH</code> of <b>${esc(info.symbol)}</b> from your account, floor <code>${fmt(minOut, info.decimals, 2)}</code>…${fromButton ? "" : ""}`);
    count.executes += 1;
    const r = await this.#d.session.execute(link.account, this.#d.reads.router, wei, data);
    // What the gas actually cost is the receipt's; here the budget counts the ceiling, so a loop is stopped early rather than late.
    count.gasWei += 700_000n * 1_000_000_000n;
    const explorer = `https://robinhoodchain.blockscout.com/tx/${r.hash}`;
    await this.#say(chatId, r.landed
      ? `landed. <a href="${explorer}">${short(r.hash)}</a> · the tokens are in your account.`
      : `sent, not confirmed as landed: <a href="${explorer}">${short(r.hash)}</a>. check the explorer; the account's floor protects the fill.`,
      kb([btn("↻ Card", `token:${token}`), btn("← Back", "home")]));
  }

  // ---------- orders (bot-orders.ts) ----------

  /**
   * The reply to a limit or dca prompt, parsed strictly and refused with the
   * format when it does not fit. The account is asked `canExecute` for the
   * amount before anything is stored, so an order the session would never
   * allow (over the per-trade cap, paused) is refused now, in the contract's
   * words, and not three times from the cron. An account keeps at most
   * MAX_OPEN_ORDERS open, so orders are not an unmetered channel for the
   * bot's gas; the order carries the chain it was placed on.
   */
  async #placeOrder(chatId: string, tgId: string, token: Address, kind: "limit" | "dca", text: string): Promise<void> {
    const orders = this.#d.orders;
    const link = await this.#d.links.getLink(tgId);
    if (!orders || !link) return this.#home(chatId, tgId);
    const back = kb([btn("← Back", `token:${token}`)]);
    const t = text.trim().toLowerCase();
    const limit = kind === "limit" ? t.match(/^(\d+(?:\.\d+)?)\s+at\s+(\d+(?:\.\d+)?)$/) : null;
    const dca = kind === "dca" ? t.match(/^(\d+(?:\.\d+)?)\s+every\s+(\d+)\s+hours?\s+(\d+)\s+times?$/) : null;
    if (!limit && !dca) return this.#say(chatId, kind === "limit" ? "that is not the format. amount in eth, then the price as tokens per eth, like <code>0.02 at 1200000</code>." : "that is not the format. amount, every N hours, N times, like <code>0.01 every 4 hours 6 times</code>.", back);
    const wei = toWei((limit ?? dca)![1]!);
    if (wei === null || wei <= 0n) return this.#say(chatId, "the amount must be a number of ETH above zero, like 0.02.", back);
    if ((await orders.openFor(tgId, this.#d.session.chainId)).length >= MAX_OPEN_ORDERS) return this.#say(chatId, `that is ${MAX_OPEN_ORDERS} open orders, the most one account keeps in the beta; cancel one from 📋 Orders to set another.`, kb([btn("📋 Orders", "orders"), btn("← Back", `token:${token}`)]));
    const info = await this.#d.reads.tokenInfo(token);
    if (!info.hasPool) return this.#say(chatId, "no ETH pool on the venue for this token, so nothing to order.", kb([btn("← Back", "home")]));
    const can = await this.#d.session.canExecute(link.account, this.#d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, wei);
    if (!can.ok) return this.#say(chatId, `your session says no to a buy of that size: <b>${esc(can.why)}</b>. manage it on the Sessions page, then set the order.`, kb([url("🔑 Sessions page", `${this.#d.siteUrl}/app/sessions.html`), btn("← Back", `token:${token}`)]));
    const now = this.#now.toISOString();
    const base = { id: newOrderId(), tgId, account: link.account, chainId: this.#d.session.chainId, token, ethWei: wei, createdAt: now, status: "open" as const, refusals: 0 };
    let order: Order;
    if (limit) {
      const trigger = toUnits(limit[2]!, info.decimals);
      if (trigger === null || trigger <= 0n) return this.#say(chatId, `the price must be a number of ${esc(info.symbol)} per ETH above zero, like 1200000.`, back);
      order = { ...base, kind: "limit", triggerPerEth: trigger };
    } else {
      const hours = Number(dca![2]), times = Number(dca![3]);
      if (hours < 1 || hours > 720) return this.#say(chatId, "the interval must be between 1 and 720 hours.", back);
      if (times < 1 || times > 100) return this.#say(chatId, "the count must be between 1 and 100 buys.", back);
      order = { ...base, kind: "dca", everyMs: hours * 3_600_000, remaining: times, nextAt: now };
    }
    await orders.put(order);
    await this.#say(chatId, `${this.#orderLine(order, info.symbol, info.decimals)}\nset. the bot checks every five minutes, asks your account first, and tells you here each time it buys or is refused. cancel from 📋 Orders.`, kb([btn("📋 Orders", "orders"), btn("↻ Card", `token:${token}`)]));
  }

  #orderLine(o: Order, symbol: string, decimals: number): string {
    if (o.kind === "limit") return `⏱ limit buy <code>${eth(o.ethWei)} ETH</code> of <b>${esc(symbol)}</b> at <code>${fmt(o.triggerPerEth ?? 0n, decimals, 2)} ${esc(symbol)}</code> per ETH or better`;
    const every = (o.everyMs ?? 0) / 3_600_000;
    return `🔁 dca <code>${eth(o.ethWei)} ETH</code> of <b>${esc(symbol)}</b> every ${every} hour${every === 1 ? "" : "s"}, ${o.remaining ?? 0} left, next ${(o.nextAt ?? "").slice(0, 16).replace("T", " ")} UTC`;
  }

  /** The open orders, one line each, a cancel button under each; the reason of the last refusal on the line when there was one. */
  async #orders(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const orders = this.#d.orders;
    const link = await this.#d.links.getLink(tgId);
    if (!orders || !link) return this.#home(chatId, tgId, messageId);
    const open = await orders.openFor(tgId, this.#d.session.chainId);
    if (!open.length) return this.#out(chatId, messageId, "no open orders. set a limit buy or a dca from any token's card.", kb([btn("← Back", "home")]));
    const infos = new Map<string, { symbol: string; decimals: number }>();
    for (const t of new Set(open.map((o) => o.token))) infos.set(t, await this.#d.reads.tokenInfo(t).then((i) => ({ symbol: i.symbol, decimals: i.decimals })).catch(() => ({ symbol: short(t), decimals: 18 })));
    const lines = open.map((o, i) => { const info = infos.get(o.token)!; return `${i + 1}. ${this.#orderLine(o, info.symbol, info.decimals)}${o.lastError ? `\n   last try: <i>${esc(o.lastError)}</i>` : ""}`; });
    const text = ["<b>your orders</b>", ...lines, "", "<i>each fires as one execute on your account, inside your session; pause the session and they wait.</i>"].join("\n");
    await this.#out(chatId, messageId, text, kb(...open.map((o, i) => [btn(`✕ Cancel ${i + 1}`, `oc:${o.id}`)]), [btn("↻ Refresh", "orders"), btn("← Back", "home")]));
  }

  async #cancelOrder(chatId: string, tgId: string, id: string, messageId?: number): Promise<void> {
    const orders = this.#d.orders;
    if (!orders) return this.#help(chatId);
    const o = await orders.get(id);
    // Only the owner of an order cancels it; someone else's id is treated as unknown.
    if (!o || o.tgId !== tgId) return this.#say(chatId, "that order is not one of yours, or it is already gone.", kb([btn("📋 Orders", "orders")]));
    // One conditional statement in the store, so a run mid-send cannot write the order back to open over the cancel.
    if (o.status === "open") await orders.cancel(o.id);
    return this.#orders(chatId, tgId, messageId);
  }
}

/** A decimal string to a token's base units; null when it is not a plain number. */
const toUnits = (s: string, decimals: number): bigint | null => {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
};

export type { Hex };

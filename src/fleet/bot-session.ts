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
 * Sell is the same shape, once the owner has turned the sell flag on for
 * the bot's key (`setSellAllowed` on the account, from the Sessions page).
 * The first sale of a token asks the account to approve Permit2 and the
 * router once (`approveForSell`, from the bot's key, inside the session's
 * rules); the sale itself is an `execute` with value zero, so the caps are
 * untouched and the amount is bounded by what the account holds. The ETH
 * lands in the account; only the owner can move it out.
 *
 * What this handler never does: hold a key of the owner's, withdraw, or
 * trade from an account that was not linked with the owner's signature.
 */

import { type Address, type Hex, isAddress } from "viem";
import type { BotChain } from "./bot-chain.js";
import { heyLine, type HeyScanner } from "./bot-hey.js";
import { issueNonce, type BotLinkStore } from "./bot-link.js";
import { orusLine, type OrusScanner } from "./bot-orus.js";
import type { SessionChain } from "./bot-session-chain.js";
import { CAPTION_MAX_CHARS, esc, type Keyboard, type Outgoing, type Telegram } from "./bot-telegram.js";
import type { TokenPlateRenderer } from "./bot-token-card.js";
import { sessionState } from "./session-keys.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, encodeV4TokenSell, minOutFor } from "./v4-swap.js";
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
  botUsername: string;
  siteUrl: string;
  /** Per user, per UTC day: how many executes and how much gas the bot fronts. */
  dailyExecutes?: number;
  dailyGasWei?: bigint;
  buySlippageBps?: number;
  buyPresetsEth?: string[];
  sellSlippageBps?: number;
  /** The shares of a position the Sell buttons offer, in whole percent. */
  sellPresetsPct?: number[];
  /** Set when the testnet playground lives in the same bot: the home cards offer the door. */
  playgroundFloor?: boolean;
  now?: () => Date;
};

const DEFAULTS = { dailyExecutes: 200, dailyGasWei: 2_000_000_000_000_000n, buySlippageBps: 300, buyPresetsEth: ["0.005", "0.01", "0.05"], sellSlippageBps: 300, sellPresetsPct: [25, 50, 100] };
/** What the daily gas budget charges per send: the gas ceiling at one gwei, so a loop is stopped early rather than late. */
const EXECUTE_GAS_WEI = 700_000n * 1_000_000_000n;
const APPROVE_GAS_WEI = 200_000n * 1_000_000_000n;
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
  readonly #pending = new Map<string, { token: Address; side: "buy" | "sell" }>();
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
      if (pending && u.message.reply_to_message) { this.#pending.delete(tgId); return pending.side === "sell" ? this.#sell(chatId, tgId, pending.token, text) : this.#buy(chatId, tgId, pending.token, text); }
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
        this.#pending.set(tgId, { token: a as Address, side: "buy" });
        return this.#d.telegram.deliver({ kind: "send", chatId, text: `how much ETH into <code>${a}</code>? reply with a number, like 0.02.`, ask: "amount in ETH" });
      }
      // sell: "s:<token>:<pct>" from a button, "asks:<token>" opens the reply field for a share.
      case "s": await ack(); return a && isAddress(a) && b ? this.#sell(chatId, tgId, a as Address, b) : this.#help(chatId);
      case "asks": {
        await ack();
        if (!a || !isAddress(a)) return this.#help(chatId);
        this.#pending.set(tgId, { token: a as Address, side: "sell" });
        return this.#d.telegram.deliver({ kind: "send", chatId, text: `what share of your <code>${a}</code> to sell? reply with a whole percent, 1 to 100, like 50.`, ask: "share in percent" });
      }
      case "help": await ack(); return this.#help(chatId);
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
      "sell from the token card too, once you turn on let it sell next to the bot's key on the Sessions page. withdrawals and fleets are yours to do from the app in this beta.",
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
      `<i>buys run as one execute on your account, guarded at ${(this.#cfg("buySlippageBps") / 100).toString()}%; sells the same, guarded at ${(this.#cfg("sellSlippageBps") / 100).toString()}%, once you let the bot sell on the Sessions page. the reply carries the hash.${info.hooked ? " hooked pool: the hook's fee is not in the quote." : ""}</i>`,
    ].join("\n");
    const png = this.#d.plate
      ? await this.#d.plate({ symbol: info.symbol, address: token, perEth: fmt(info.perEth, info.decimals, 2), poolEth: eth(info.poolEth, 4), hooked: info.hooked, chainLabel: "robinhood chain", testnet: this.#d.session.chainId !== 4663, ...(this.#d.orus ? { orus: scan ?? null } : {}), ...(this.#d.hey ? { hey: hey ?? null } : {}) }).catch(() => undefined)
      : undefined;
    await this.#out(chatId, messageId, text, kb(
      this.#cfg("buyPresetsEth").map((p) => btn(`Buy ${p} ETH`, `b:${token}:${p}`)),
      [btn("Buy custom", `ask:${token}`)],
      // Sell buttons only over a position: an account that holds none of the token has nothing to sell.
      ...(held > 0n ? [this.#cfg("sellPresetsPct").map((p) => btn(`Sell ${p}%`, `s:${token}:${p}`)), [btn("Sell custom", `asks:${token}`)]] : []),
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
    count.gasWei += EXECUTE_GAS_WEI;
    const explorer = `https://robinhoodchain.blockscout.com/tx/${r.hash}`;
    await this.#say(chatId, r.landed
      ? `landed. <a href="${explorer}">${short(r.hash)}</a> · the tokens are in your account.`
      : `sent, not confirmed as landed: <a href="${explorer}">${short(r.hash)}</a>. check the explorer; the account's floor protects the fill.`,
      kb([btn("↻ Card", `token:${token}`), btn("← Back", "home")]));
  }

  // ---------- sell ----------

  /**
   * A share of the account's position, sold through the router as one
   * execute with value zero. The order of the checks is the cheap and the
   * reversible first: the share, today's limits, the flag the owner set, the
   * quote, the contract's own answer; only then the one-time approval and
   * the sale, each a transaction the bot's key pays the gas for.
   */
  async #sell(chatId: string, tgId: string, token: Address, share: string): Promise<void> {
    const link = await this.#d.links.getLink(tgId);
    if (!link) return this.#home(chatId, tgId);
    const percent = /^\d{1,3}%?$/.test(share.trim()) ? Number(share.trim().replace("%", "")) : NaN;
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return this.#say(chatId, "a whole percent of your position, 1 to 100, like 50.", kb([btn("← Back", `token:${token}`)]));
    const count = this.#today(tgId);
    if (count.executes >= this.#cfg("dailyExecutes")) return this.#say(chatId, `that is ${this.#cfg("dailyExecutes")} trades today from this account; again tomorrow.`, kb([btn("← Back", `token:${token}`)]));
    if (count.gasWei >= this.#cfg("dailyGasWei")) return this.#say(chatId, "the bot has fronted its daily gas for this account; again tomorrow.", kb([btn("← Back", `token:${token}`)]));
    const sessions = `${this.#d.siteUrl}/app/sessions.html`;
    const [info, held, allowed] = await Promise.all([this.#d.reads.tokenInfo(token), this.#d.reads.tokenBalance(token, link.account), this.#d.session.sellAllowed(link.account)]);
    const amount = (held * BigInt(percent)) / 100n;
    if (amount === 0n) return this.#say(chatId, `nothing to sell: your account holds no ${esc(info.symbol)}.`, kb([btn("← Back", `token:${token}`)]));
    // The flag is the owner's to set, from the wallet; the bot cannot give it to itself.
    if (!allowed) return this.#say(chatId, "your session does not allow sells yet. on the Sessions page, next to the bot's key, turn on let it sell (one transaction), then try again.", kb([url("🔑 Sessions page", sessions), btn("← Back", `token:${token}`)]));
    const quote = info.hasPool ? await this.#d.reads.quoteSell(token, amount) : null;
    if (quote === null) return this.#say(chatId, "no ETH pool on the venue for this token.", kb([btn("← Back", "home")]));
    // The contract's own answer first: a paused, expired or revoked session refuses here, before any gas.
    const can = await this.#d.session.canExecute(link.account, this.#d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, 0n);
    if (!can.ok) return this.#say(chatId, `your session says no: <b>${esc(can.why)}</b>. manage it on the Sessions page.`, kb([url("🔑 Sessions page", sessions), btn("← Back", `token:${token}`)]));
    if (!(await this.#d.session.tokenAllowanceReady(link.account, token, this.#d.reads.router))) {
      await this.#say(chatId, `first sale of <b>${esc(info.symbol)}</b> from your account: approving the router once, then selling…`);
      count.gasWei += APPROVE_GAS_WEI;
      const approval = await this.#d.session.approveForSell(link.account, token, this.#d.reads.router);
      if (!approval.landed) return this.#say(chatId, `the approval did not land: <a href="https://robinhoodchain.blockscout.com/tx/${approval.hash}">${short(approval.hash)}</a>. nothing was sold; try again in a moment.`, kb([btn("↻ Card", `token:${token}`), btn("← Back", "home")]));
    }
    const minOut = minOutFor(quote, this.#cfg("sellSlippageBps"));
    const deadline = BigInt(Math.floor(this.#now.getTime() / 1000) + 3600);
    const data = encodeV4TokenSell({ token, amountIn: amount, minOut, deadline, ...(info.poolKey ? { poolKey: info.poolKey } : {}) });
    await this.#say(chatId, `selling <code>${fmt(amount, info.decimals, 4)} ${esc(info.symbol)}</code> (${percent}%) from your account: about <code>${eth(quote)} ETH</code>, floor <code>${eth(minOut)}</code>…`);
    count.executes += 1;
    const r = await this.#d.session.execute(link.account, this.#d.reads.router, 0n, data);
    count.gasWei += EXECUTE_GAS_WEI;
    const explorer = `https://robinhoodchain.blockscout.com/tx/${r.hash}`;
    await this.#say(chatId, r.landed
      ? `landed. <a href="${explorer}">${short(r.hash)}</a> · the ETH is in your account.`
      : `sent, not confirmed as landed: <a href="${explorer}">${short(r.hash)}</a>. check the explorer; the account's floor protects the fill.`,
      kb([btn("↻ Card", `token:${token}`), btn("← Back", "home")]));
  }
}

export type { Hex };

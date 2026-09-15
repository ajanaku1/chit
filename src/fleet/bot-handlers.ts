/**
 * Chit Bot: the Telegram trading bot on Robinhood Chain, testnet edition.
 *
 * The shape every degen already knows (a card with the wallet, a balance,
 * and buttons: Buy, Sell, Positions, Withdraw, Refresh), on a chain that has
 * no such bot. On testnet the bot makes the wallet for you on /start and
 * holds its key, because a testnet key holds nothing but test ETH and the
 * point is to let anyone try Chit in one tap. On mainnet the same buttons
 * drive a session on the user's own account through session keys
 * (docs/session-keys.md), and the bot never holds a key at all; that is the
 * line this bot exists to draw.
 *
 * Every figure on a card is read from the chain when the card is drawn.
 * Every trade is a real transaction through the real Uniswap v4 router, and
 * the reply carries its hash. Nothing is estimated as if it happened.
 *
 * This module is pure over its ports (store, chain, telegram), so the tests
 * run the whole conversation against fakes.
 */

import { formatEther, isAddress, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Address, Hex } from "./types.js";
import { minOutFor } from "./v4-swap.js";
import type { BotChain } from "./bot-chain.js";
import { esc, type Keyboard, type Outgoing, type Telegram } from "./bot-telegram.js";
import { openKey, sealKey, type BotWallet, type BotWalletStore } from "./bot-wallets.js";

export type BotDeps = {
  store: BotWalletStore;
  chain: BotChain;
  telegram: Telegram;
  /** Seals the playground keys at rest. */
  keySecret: string;
  /** The bot's @username, for the "dm me" link in groups. */
  botUsername: string;
  /** What /start hands a new wallet, and what /faucet tops up, in wei. */
  faucetWei?: bigint;
  /** How long a wallet waits between faucet top-ups. */
  faucetEveryMs?: number;
  /** Where the Sessions page and the app live. */
  siteUrl?: string;
  now?: () => Date;
};

export type Update = {
  message?: { message_id: number; text?: string; chat: { id: number; type: string }; from?: { id: number; username?: string; first_name?: string } };
  callback_query?: { id: string; data?: string; from: { id: number; username?: string; first_name?: string }; message?: { message_id: number; chat: { id: number; type: string } } };
};

const BUY_PRESETS = ["0.001", "0.005", "0.01"] as const;
const SELL_PRESETS = [25, 50, 100] as const;
const MAX_BUY = parseEther("0.05");
const SLIPPAGE_BPS = 300;

const eth = (wei: bigint, places = 5): string => {
  const s = formatEther(wei);
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, places).replace(/0+$/, "");
  return frac ? `${w}.${frac}` : w!;
};
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const parseEth = (raw: string): bigint | null => {
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) return null;
  try { return parseEther(raw); } catch { return null; }
};

const homeKeyboard = (): Keyboard => [
  [{ text: "Buy", callback_data: "buy" }, { text: "Sell", callback_data: "sell" }],
  [{ text: "Positions", callback_data: "positions" }, { text: "Fleet", callback_data: "fleet" }],
  [{ text: "Withdraw", callback_data: "withdraw" }, { text: "↻ Refresh", callback_data: "home" }],
  [{ text: "Help", callback_data: "help" }],
];
const backKeyboard = (): Keyboard => [[{ text: "← Back", callback_data: "home" }]];

export class ChitBot {
  readonly #d: BotDeps;
  readonly #faucetWei: bigint;
  readonly #faucetEveryMs: number;
  readonly #site: string;
  readonly #now: () => Date;

  constructor(deps: BotDeps) {
    this.#d = deps;
    this.#faucetWei = deps.faucetWei ?? parseEther("0.02");
    this.#faucetEveryMs = deps.faucetEveryMs ?? 24 * 3600 * 1000;
    this.#site = (deps.siteUrl ?? "https://chit.tools").replace(/\/+$/, "");
    this.#now = deps.now ?? (() => new Date());
  }

  /** One Telegram update in, zero or more messages out. Never throws at the caller: a failure is a message. */
  async handle(update: Update): Promise<void> {
    try {
      if (update.callback_query) await this.#callback(update.callback_query);
      else if (update.message?.text) await this.#message(update.message);
    } catch (error) {
      const chatId = String(update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? "");
      const line = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.error("chit bot:", line);
      if (chatId) await this.#say(chatId, `something broke on our side: <code>${esc(line ?? "unknown")}</code>. try again in a moment.`);
    }
  }

  async #say(chatId: string, text: string, keyboard?: Keyboard): Promise<void> {
    await this.#d.telegram.deliver({ kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}) });
  }

  // ---------- messages ----------

  async #message(m: NonNullable<Update["message"]>): Promise<void> {
    const chatId = String(m.chat.id);
    const text = (m.text ?? "").trim();
    const [rawCmd = "", ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.+$/, "");
    const isPrivate = m.chat.type === "private";
    const tgId = String(m.from?.id ?? "");

    if (!isPrivate) {
      if (cmd === "/pool") return this.#pool(chatId);
      if (["/start", "/wallet", "/buy", "/sell", "/positions", "/withdraw", "/faucet", "/help", "/fleet"].includes(cmd)) {
        return this.#say(chatId, `the playground is in private: <a href="https://t.me/${esc(this.#d.botUsername)}?start=go">open the bot</a> and press Start. testnet, test ETH, nothing to lose.`);
      }
      return;
    }
    if (!tgId) return;

    switch (cmd) {
      case "/start": return this.#start(chatId, tgId, m.from?.first_name);
      case "/wallet": case "/home": return this.#home(chatId, tgId);
      case "/buy": return args[0] ? this.#buy(chatId, tgId, args[0]) : this.#buyMenu(chatId, tgId);
      case "/sell": return args[0] ? this.#sell(chatId, tgId, args[0]) : this.#sellMenu(chatId, tgId);
      case "/positions": return this.#positions(chatId, tgId);
      case "/withdraw": return this.#withdraw(chatId, tgId, args[0], args[1]);
      case "/faucet": return this.#faucet(chatId, tgId);
      case "/fleet": return this.#fleet(chatId);
      case "/pool": return this.#pool(chatId);
      case "/help": return this.#help(chatId);
      default:
        return this.#say(chatId, "i know /start, /buy, /sell, /positions, /withdraw, /faucet, /fleet, /pool and /help. or press a button on your card.", homeKeyboard());
    }
  }

  async #callback(q: NonNullable<Update["callback_query"]>): Promise<void> {
    const chatId = String(q.message?.chat.id ?? q.from.id);
    const messageId = q.message?.message_id;
    const tgId = String(q.from.id);
    const data = q.data ?? "";
    const ack = (text?: string): Promise<void> => this.#d.telegram.deliver({ kind: "answer", callbackId: q.id, ...(text ? { text } : {}) });

    if (q.message?.chat.type !== "private") { await ack("open the bot in private"); return; }

    if (data === "home") { await ack(); return this.#home(chatId, tgId, messageId); }
    if (data === "buy") { await ack(); return this.#buyMenu(chatId, tgId, messageId); }
    if (data === "sell") { await ack(); return this.#sellMenu(chatId, tgId, messageId); }
    if (data === "positions") { await ack(); return this.#positions(chatId, tgId, messageId); }
    if (data === "withdraw") { await ack(); return this.#withdrawHelp(chatId, messageId); }
    if (data === "fleet") { await ack(); return this.#fleet(chatId, messageId); }
    if (data === "help") { await ack(); return this.#help(chatId, messageId); }
    if (data === "faucet") { await ack(); return this.#faucet(chatId, tgId); }
    if (data.startsWith("buy:")) { await ack("buying…"); return this.#buy(chatId, tgId, data.slice(4)); }
    if (data.startsWith("sell:")) { await ack("selling…"); return this.#sell(chatId, tgId, data.slice(5)); }
    await ack("unknown button");
  }

  // ---------- the wallet ----------

  async #walletOf(tgId: string): Promise<BotWallet | undefined> {
    return this.#d.store.get(tgId);
  }

  async #start(chatId: string, tgId: string, firstName?: string): Promise<void> {
    let wallet = await this.#walletOf(tgId);
    let fresh = false;
    if (!wallet) {
      const key = generatePrivateKey();
      wallet = {
        tgId,
        address: privateKeyToAccount(key).address,
        sealedKey: sealKey(key, this.#d.keySecret),
        createdAt: this.#now().toISOString(),
        faucetAt: null,
      };
      await this.#d.store.put(wallet);
      fresh = true;
    }
    const hello = fresh
      ? `gm${firstName ? ` ${esc(firstName)}` : ""}. made you a wallet on <b>Robinhood Chain testnet</b>. test ETH, test tokens, nothing real, and we hold this key so you can try things in one tap. on mainnet the key stays with you (that is the whole point of Chit).`
      : `welcome back${firstName ? ` ${esc(firstName)}` : ""}.`;
    if (fresh) {
      const topped = await this.#tryFaucet(wallet);
      await this.#say(chatId, `${hello}\n\n${topped ? `topped it up with ${eth(this.#faucetWei)} test ETH.` : "the faucet is dry right now; ask again with /faucet in a while."}`);
    } else {
      await this.#say(chatId, hello);
    }
    await this.#home(chatId, tgId);
  }

  async #card(wallet: BotWallet): Promise<string> {
    const [ethBal, tokens] = await Promise.all([this.#d.chain.ethBalance(wallet.address), this.#d.chain.tokenBalance(wallet.address)]);
    const sym = this.#d.chain.tokenSymbol;
    return [
      `<b>Robinhood Chain testnet</b> · 46630`,
      `<code>${wallet.address}</code> <i>(tap to copy)</i>`,
      `balance: <code>${eth(ethBal)} ETH</code>` + (tokens > 0n ? ` · <code>${eth(tokens, 4)} ${esc(sym)}</code>` : ""),
      "",
      `buys and sells go through the real Uniswap v4 router; every reply carries the transaction hash.`,
      `<i>testnet playground: this key is ours, the ETH is test ETH. never do this with real money; on mainnet Chit uses session keys and never holds yours.</i>`,
    ].join("\n");
  }

  async #home(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first and i make you a testnet wallet.");
    const text = await this.#card(wallet);
    await this.#out(chatId, messageId, text, homeKeyboard());
  }

  async #out(chatId: string, messageId: number | undefined, text: string, keyboard?: Keyboard): Promise<void> {
    const out: Outgoing = messageId
      ? { kind: "edit", chatId, messageId, text, ...(keyboard ? { keyboard } : {}) }
      : { kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}) };
    await this.#d.telegram.deliver(out);
  }

  // ---------- faucet ----------

  async #tryFaucet(wallet: BotWallet): Promise<boolean> {
    const available = await this.#d.chain.faucetBalance().catch(() => 0n);
    if (available < this.#faucetWei * 2n) return false;
    const landed = await this.#d.chain.faucet(wallet.address, this.#faucetWei);
    if (!landed.ok) return false;
    wallet.faucetAt = this.#now().toISOString();
    await this.#d.store.put(wallet);
    return true;
  }

  async #faucet(chatId: string, tgId: string): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first.");
    const last = wallet.faucetAt ? Date.parse(wallet.faucetAt) : 0;
    const wait = last + this.#faucetEveryMs - this.#now().getTime();
    if (wait > 0) return this.#say(chatId, `the faucet is once a day per wallet. again in about ${Math.ceil(wait / 3_600_000)}h.`, backKeyboard());
    const ok = await this.#tryFaucet(wallet);
    await this.#say(chatId, ok ? `sent ${eth(this.#faucetWei)} test ETH to your wallet.` : "the faucet is dry right now. try later.", backKeyboard());
  }

  // ---------- buy ----------

  async #buyMenu(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first.");
    const bal = await this.#d.chain.ethBalance(wallet.address);
    const sym = this.#d.chain.tokenSymbol;
    const text = `<b>buy ${esc(sym)}</b>\nyou have <code>${eth(bal)} ETH</code>. pick an amount, or type <code>/buy 0.002</code>.\nspot quote first, ${SLIPPAGE_BPS / 100}% slippage guard, then the router.`;
    const keyboard: Keyboard = [
      BUY_PRESETS.map((p) => ({ text: `${p} ETH`, callback_data: `buy:${p}` })),
      [{ text: "← Back", callback_data: "home" }],
    ];
    await this.#out(chatId, messageId, text, keyboard);
  }

  async #buy(chatId: string, tgId: string, raw: string): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first.");
    const amount = parseEth(raw);
    if (!amount || amount === 0n) return this.#say(chatId, "an amount like 0.002.", backKeyboard());
    if (amount > MAX_BUY) return this.#say(chatId, `keep it under ${eth(MAX_BUY)} ETH a trade on the playground.`, backKeyboard());
    const bal = await this.#d.chain.ethBalance(wallet.address);
    if (bal < amount + parseEther("0.0005")) return this.#say(chatId, `not enough: you have <code>${eth(bal)} ETH</code> and a trade needs the amount plus a little gas. /faucet once a day.`, backKeyboard());
    const quote = await this.#d.chain.quoteBuy(amount);
    if (quote === null || quote === 0n) return this.#say(chatId, "no price in the pool right now.", backKeyboard());
    const sym = this.#d.chain.tokenSymbol;
    const minOut = minOutFor(quote, SLIPPAGE_BPS);
    await this.#say(chatId, `buying ${esc(sym)} with <code>${eth(amount)} ETH</code>, about <code>${eth(quote, 4)} ${esc(sym)}</code> at spot, at least <code>${eth(minOut, 4)}</code> or it reverts…`);
    const before = await this.#d.chain.tokenBalance(wallet.address);
    const landed = await this.#d.chain.buy(openKey(wallet.sealedKey, this.#d.keySecret), amount, minOut);
    if (!landed.ok) return this.#say(chatId, `the buy reverted (<code>${landed.hash}</code>). the price moved past the guard, or the pool is thin. nothing was spent but gas.`, homeKeyboard());
    const got = (await this.#d.chain.tokenBalance(wallet.address)) - before;
    await this.#say(chatId, `✅ bought <code>${eth(got, 4)} ${esc(sym)}</code> for <code>${eth(amount)} ETH</code>\ntx <code>${landed.hash}</code>`, homeKeyboard());
  }

  // ---------- sell ----------

  async #sellMenu(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first.");
    const tokens = await this.#d.chain.tokenBalance(wallet.address);
    const sym = this.#d.chain.tokenSymbol;
    if (tokens === 0n) return this.#out(chatId, messageId, `nothing to sell: you hold no ${esc(sym)} yet. buy some first.`, [[{ text: "Buy", callback_data: "buy" }, { text: "← Back", callback_data: "home" }]]);
    const text = `<b>sell ${esc(sym)}</b>\nyou hold <code>${eth(tokens, 4)} ${esc(sym)}</code>. how much?`;
    const keyboard: Keyboard = [
      SELL_PRESETS.map((p) => ({ text: `${p}%`, callback_data: `sell:${p}` })),
      [{ text: "← Back", callback_data: "home" }],
    ];
    await this.#out(chatId, messageId, text, keyboard);
  }

  async #sell(chatId: string, tgId: string, raw: string): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first.");
    const pct = Number(raw.replace("%", ""));
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) return this.#say(chatId, "a percentage: /sell 50", backKeyboard());
    const held = await this.#d.chain.tokenBalance(wallet.address);
    const amount = (held * BigInt(pct)) / 100n;
    const sym = this.#d.chain.tokenSymbol;
    if (amount === 0n) return this.#say(chatId, `nothing to sell: you hold no ${esc(sym)}.`, backKeyboard());
    const bal = await this.#d.chain.ethBalance(wallet.address);
    if (bal < parseEther("0.0005")) return this.#say(chatId, "not enough ETH for gas. /faucet once a day.", backKeyboard());
    const quote = await this.#d.chain.quoteSell(amount);
    if (quote === null || quote === 0n) return this.#say(chatId, "no price in the pool right now.", backKeyboard());
    const minOut = minOutFor(quote, SLIPPAGE_BPS);
    await this.#say(chatId, `selling <code>${eth(amount, 4)} ${esc(sym)}</code> (${pct}%), about <code>${eth(quote)} ETH</code> at spot, at least <code>${eth(minOut)}</code> or it reverts… (first sale approves the router once)`);
    const ethBefore = await this.#d.chain.ethBalance(wallet.address);
    const landed = await this.#d.chain.sell(openKey(wallet.sealedKey, this.#d.keySecret), amount, minOut);
    if (!landed.ok) return this.#say(chatId, `the sale reverted (<code>${landed.hash}</code>). nothing was sold.`, homeKeyboard());
    const ethAfter = await this.#d.chain.ethBalance(wallet.address);
    await this.#say(chatId, `✅ sold <code>${eth(amount, 4)} ${esc(sym)}</code>, wallet went from <code>${eth(ethBefore)}</code> to <code>${eth(ethAfter)} ETH</code> after gas\ntx <code>${landed.hash}</code>`, homeKeyboard());
  }

  // ---------- positions, withdraw, help ----------

  async #positions(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first.");
    const [ethBal, tokens] = await Promise.all([this.#d.chain.ethBalance(wallet.address), this.#d.chain.tokenBalance(wallet.address)]);
    const sym = this.#d.chain.tokenSymbol;
    const worth = tokens > 0n ? await this.#d.chain.quoteSell(tokens) : 0n;
    const lines = [
      `<b>positions</b> · <code>${short(wallet.address)}</code>`,
      `ETH: <code>${eth(ethBal)}</code>`,
      tokens > 0n
        ? `${esc(sym)}: <code>${eth(tokens, 4)}</code>` + (worth ? ` ≈ <code>${eth(worth)} ETH</code> at spot` : "")
        : `${esc(sym)}: none yet`,
      "",
      `<i>one token on the testnet venue for now; any token with a v4 pool is the next step.</i>`,
    ];
    await this.#out(chatId, messageId, lines.join("\n"), [[{ text: "Buy", callback_data: "buy" }, { text: "Sell", callback_data: "sell" }], [{ text: "← Back", callback_data: "home" }]]);
  }

  async #withdrawHelp(chatId: string, messageId?: number): Promise<void> {
    await this.#out(chatId, messageId, `<b>withdraw</b>\ntype <code>/withdraw 0xYourAddress 0.01</code> and the test ETH goes there. it is test ETH: worth nothing off this chain.`, backKeyboard());
  }

  async #withdraw(chatId: string, tgId: string, to?: string, raw?: string): Promise<void> {
    const wallet = await this.#walletOf(tgId);
    if (!wallet) return this.#say(chatId, "press /start first.");
    if (!to || !isAddress(to)) return this.#say(chatId, "<code>/withdraw 0xAddress 0.01</code>", backKeyboard());
    const amount = raw ? parseEth(raw) : null;
    if (!amount || amount === 0n) return this.#say(chatId, "<code>/withdraw 0xAddress 0.01</code>", backKeyboard());
    const bal = await this.#d.chain.ethBalance(wallet.address);
    if (bal < amount + parseEther("0.0002")) return this.#say(chatId, `you have <code>${eth(bal)} ETH</code>; leave a little for gas.`, backKeyboard());
    const landed = await this.#d.chain.send(openKey(wallet.sealedKey, this.#d.keySecret), to as Address, amount);
    await this.#say(chatId, landed.ok ? `✅ sent <code>${eth(amount)} ETH</code> to <code>${to}</code>\ntx <code>${landed.hash}</code>` : `the send reverted (<code>${landed.hash}</code>).`, homeKeyboard());
  }

  async #fleet(chatId: string, messageId?: number): Promise<void> {
    await this.#out(chatId, messageId, [
      `<b>fleet</b>: the thing Chit is for.`,
      `one deposit into a shared pool, a fleet of wallets funded from it after a random wait, the buy through the router from every wallet, and no transaction linking your deposit to them.`,
      ``,
      `from this chat it is the next thing i learn. today it lives in the app: <a href="${esc(this.#site)}/app/balance.html">Balance</a> → <a href="${esc(this.#site)}/app/fleet.html">Set up</a> → <a href="${esc(this.#site)}/app/trade.html">Trade</a> → <a href="${esc(this.#site)}/app/fleet-dashboard.html">Control Room</a>, with your own wallet on testnet.`,
    ].join("\n"), backKeyboard());
  }

  async #pool(chatId: string): Promise<void> {
    const p = await this.#d.chain.poolNumbers();
    if (!p) return this.#say(chatId, "the pool is not configured on this bot yet.");
    await this.#say(chatId, `<b>the pool</b> · <code>${short(p.address)}</code>\nholds <code>${eth(p.heldWei)} ETH</code> · <code>${eth(p.totalDeposited)} ETH</code> ever deposited · ${p.campaigns} fleet${p.campaigns === 1n ? "" : "s"} funded${p.paused ? " · <b>paused</b>" : ""}\n<i>read from the chain just now. testnet.</i>`);
  }

  async #help(chatId: string, messageId?: number): Promise<void> {
    await this.#out(chatId, messageId, [
      `<b>Chit Bot</b>, Robinhood Chain testnet`,
      `/start · your testnet wallet, topped up`,
      `/buy 0.002 · buy ${esc(this.#d.chain.tokenSymbol)} through Uniswap v4`,
      `/sell 50 · sell a share of it`,
      `/positions · what you hold`,
      `/withdraw 0x… 0.01 · move test ETH out`,
      `/faucet · test ETH, once a day`,
      `/fleet · what the real product does`,
      `/pool · the pool's numbers, also in the group`,
      ``,
      `<i>everything here is testnet and test tokens. the bot holds this playground key; on mainnet it never holds yours: <a href="${esc(this.#site)}/app/sessions.html">session keys</a>.</i>`,
    ].join("\n"), backKeyboard());
  }
}

/**
 * Chit Bot: the Telegram trading bot on Robinhood Chain, testnet edition.
 *
 * The shape every degen already knows (a card with the wallet and the
 * balance, buttons under it, a reply field that opens when a number is
 * needed, paste a contract address and get its card), on a chain that has
 * no such bot. On testnet the bot makes the wallet for you on Start and
 * holds its key, because a testnet key holds nothing but test ETH and the
 * point is to let anyone try Chit in one tap. On mainnet the same buttons
 * drive a session on the user's own account through session keys
 * (docs/session-keys.md), and the bot never holds a key at all; that is the
 * line this bot exists to draw.
 *
 * Every figure on a card is read from the chain when the card is drawn.
 * Every trade is a real transaction through the real Uniswap v4 router, and
 * the reply carries its hash. Nothing is estimated as if it happened. There
 * are no priority fees, no MEV toggles and no turbo modes here, because the
 * chain has a sequencer and none of that exists on it; the settings are the
 * ones that mean something: amounts, slippage, a confirmation step.
 *
 * This module is pure over its ports (store, chain, telegram), so the tests
 * run the whole conversation against fakes.
 */

import { formatUnits, isAddress, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { BotChain, TokenInfo } from "./bot-chain.js";
import { FleetDriver, FleetError, fleetPhase, type FleetApi } from "./bot-fleet.js";
import { esc, type Keyboard, type Outgoing, type Telegram } from "./bot-telegram.js";
import { DEFAULT_SETTINGS, openKey, refCodeOf, sealKey, withDefaults, type BotSettings, type BotWallet, type BotWalletStore } from "./bot-wallets.js";
import type { Address, Hex } from "./types.js";
import { minOutFor } from "./v4-swap.js";

export type BotDeps = {
  store: BotWalletStore;
  chain: BotChain;
  telegram: Telegram;
  /** The hosted fleet service; absent means the Fleet card only explains. */
  fleetApi?: FleetApi;
  /** Seals the playground keys at rest and keys the referral codes. */
  keySecret: string;
  /** The bot's @username, for links. */
  botUsername: string;
  /** What Start hands a new wallet, and what the faucet tops up, in wei. */
  faucetWei?: bigint;
  /** How long a wallet waits between faucet top-ups. */
  faucetEveryMs?: number;
  /** Where the app lives. */
  siteUrl?: string;
  now?: () => Date;
};

export type Update = {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    reply_to_message?: { text?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number; type: string } };
  };
};

/** The bounds of the playground, so a faucet cannot be drained through a trade. */
const MAX_BUY = parseEther("0.05");
const MIN_GAS_RESERVE = parseEther("0.0005");
const MAX_TOKENS_REMEMBERED = 12;

/** The prompts a reply can be to. The text is what Telegram hands back in reply_to_message. */
const PROMPT = {
  buyAmount: "how much ETH to spend?",
  sellPercent: "what share to sell? (a number, 1 to 100)",
  withdrawTo: "paste the address the test ETH goes to",
  withdrawAmount: "how much ETH to send?",
  token: "paste the token's contract address",
  buyPresets: "your three buy amounts in ETH, like: 0.001 0.005 0.01",
  sellPresets: "your three sell shares in percent, like: 25 50 100",
  buySlippage: "buy slippage in percent, 0.5 to 20",
  sellSlippage: "sell slippage in percent, 0.5 to 20",
} as const;
type PromptKey = keyof typeof PROMPT;

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (units: bigint, decimals = 18, places = 5): string => {
  const s = formatUnits(units, decimals);
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, places).replace(/0+$/, "");
  return frac ? `${w}.${frac}` : w!;
};
const eth = (wei: bigint, places = 5): string => fmt(wei, 18, places);
const parseEth = (raw: string): bigint | null => {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  try { return parseEther(t); } catch { return null; }
};
const pct = (bps: number): string => `${(bps / 100).toString()}%`;
const ADDRESS = /0x[0-9a-fA-F]{40}/;

const kb = (...rows: Keyboard): Keyboard => rows;
const btn = (text: string, data: string) => ({ text, callback_data: data });
const back = (to = "home") => [btn("← Back", to)];

export class ChitBot {
  readonly #d: BotDeps;
  readonly #faucetWei: bigint;
  readonly #faucetEveryMs: number;
  readonly #site: string;
  readonly #now: () => Date;
  /** One trade at a time per wallet within this instance: two taps in the same second would race on the nonce. */
  readonly #busy = new Set<string>();

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
      const line = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown";
      console.error("chit bot:", line);
      if (chatId) await this.#say(chatId, `something broke on our side: <code>${esc(line)}</code>. try again in a moment.`, kb(back()));
    }
  }

  // ---------- sending ----------

  async #say(chatId: string, text: string, keyboard?: Keyboard): Promise<void> {
    await this.#d.telegram.deliver({ kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}) });
  }
  async #ask(chatId: string, prompt: PromptKey, hint?: string): Promise<void> {
    await this.#d.telegram.deliver({ kind: "send", chatId, text: PROMPT[prompt], ask: hint ?? PROMPT[prompt] });
  }
  async #out(chatId: string, messageId: number | undefined, text: string, keyboard?: Keyboard): Promise<void> {
    const out: Outgoing = messageId
      ? { kind: "edit", chatId, messageId, text, ...(keyboard ? { keyboard } : {}) }
      : { kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}) };
    await this.#d.telegram.deliver(out);
  }

  // ---------- routing ----------

  async #message(m: NonNullable<Update["message"]>): Promise<void> {
    const chatId = String(m.chat.id);
    const text = (m.text ?? "").trim();
    const tgId = String(m.from?.id ?? "");
    const isPrivate = m.chat.type === "private";
    const [rawCmd = ""] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.+$/, "");

    if (!isPrivate) {
      if (cmd === "/pool") return this.#pool(chatId);
      if (cmd.startsWith("/")) {
        return this.#say(chatId, `the playground is in private: <a href="https://t.me/${esc(this.#d.botUsername)}?start=go">open the bot</a> and press Start. testnet, test ETH, nothing to lose.`);
      }
      return;
    }
    if (!tgId) return;

    // A reply to one of our prompts carries the answer; the prompt's text says which.
    const replied = m.reply_to_message?.text;
    if (replied) {
      const key = (Object.keys(PROMPT) as PromptKey[]).find((k) => PROMPT[k] === replied);
      if (key) return this.#answer(chatId, tgId, key, text);
    }
    if (cmd === "/start") return this.#start(chatId, tgId, m.from?.first_name, text.split(/\s+/)[1]);
    if (cmd === "/pool") return this.#pool(chatId);
    if (cmd === "/help") return this.#help(chatId);
    // A pasted contract address opens the token's card, wherever it is in the text.
    const pasted = ADDRESS.exec(text)?.[0];
    if (pasted) return this.#tokenCard(chatId, tgId, pasted as Address);
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId, m.from?.first_name);
    return this.#home(chatId, tgId);
  }

  async #callback(q: NonNullable<Update["callback_query"]>): Promise<void> {
    const chatId = String(q.message?.chat.id ?? q.from.id);
    const messageId = q.message?.message_id;
    const tgId = String(q.from.id);
    const data = q.data ?? "";
    const ack = (text?: string): Promise<void> => this.#d.telegram.deliver({ kind: "answer", callbackId: q.id, ...(text ? { text } : {}) });
    if (q.message?.chat.type !== "private") { await ack("open the bot in private"); return; }

    const [verb = "", a = "", b = ""] = data.split(":");
    switch (verb) {
      case "home": await ack(); return this.#home(chatId, tgId, messageId);
      case "buy": await ack(); return this.#buyMenu(chatId, tgId, a as Address | "", messageId);
      case "sell": await ack(); return this.#sellMenu(chatId, tgId, a as Address | "", messageId);
      case "positions": await ack(); return this.#positions(chatId, tgId, messageId);
      case "token": await ack(); return a ? this.#tokenCard(chatId, tgId, a as Address, messageId) : this.#ask(chatId, "token");
      case "fleet": await ack(); return this.#fleet(chatId, tgId, messageId);
      case "fl": await ack(a === "status" || a === "bal" ? undefined : "working…"); return this.#fleetAction(chatId, tgId, a, b);
      case "sessions": await ack(); return this.#sessions(chatId, messageId);
      case "refer": await ack(); return this.#refer(chatId, tgId, messageId);
      case "settings": await ack(); return this.#settings(chatId, tgId, messageId);
      case "set": await ack(); return this.#setting(chatId, tgId, a, messageId);
      case "withdraw": await ack(); return this.#ask(chatId, "withdrawTo");
      case "faucet": await ack(); return this.#faucet(chatId, tgId);
      case "help": await ack(); return this.#help(chatId, messageId);
      case "b": await ack("buying…"); return this.#buy(chatId, tgId, a as Address, b, false);
      case "bc": await ack("buying…"); return this.#buy(chatId, tgId, a as Address, b, true);
      case "s": await ack("selling…"); return this.#sell(chatId, tgId, a as Address, Number(b), false);
      case "sc": await ack("selling…"); return this.#sell(chatId, tgId, a as Address, Number(b), true);
      case "ask": await ack(); return this.#askFor(chatId, tgId, a, b);
      case "w": await ack("sending…"); return this.#withdraw(chatId, tgId, a as Address, b);
      default: await ack("unknown button");
    }
  }

  /** A prompt that needs to remember what it is for carries it in the ask text's hint. */
  async #askFor(chatId: string, tgId: string, what: string, token: string): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (what === "buy") { this.#pending.set(tgId, { token: token as Address }); return this.#ask(chatId, "buyAmount"); }
    if (what === "sell") { this.#pending.set(tgId, { token: token as Address }); return this.#ask(chatId, "sellPercent"); }
    if (what === "wto") { this.#pending.set(tgId, { to: token as Address }); return this.#ask(chatId, "withdrawAmount"); }
  }
  /** What a custom-amount prompt was about, per user, on this instance. A lost one asks again; nothing is spent on a guess. */
  readonly #pending = new Map<string, { token?: Address; to?: Address }>();

  async #answer(chatId: string, tgId: string, key: PromptKey, text: string): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const pending = this.#pending.get(tgId) ?? {};
    switch (key) {
      case "buyAmount": {
        const token = pending.token ?? this.#d.chain.defaultToken;
        return this.#buy(chatId, tgId, token, text, false);
      }
      case "sellPercent": {
        const token = pending.token ?? this.#d.chain.defaultToken;
        return this.#sell(chatId, tgId, token, Number(text.replace("%", "")), false);
      }
      case "withdrawTo": {
        const to = ADDRESS.exec(text)?.[0];
        if (!to) return this.#say(chatId, "that is not an address. paste one like 0x… (42 characters).", kb([btn("Withdraw", "withdraw")], back()));
        this.#pending.set(tgId, { to: to as Address });
        const bal = await this.#d.chain.ethBalance(wallet.address);
        const spendable = bal > MIN_GAS_RESERVE ? bal - MIN_GAS_RESERVE : 0n;
        return this.#say(chatId, `to <code>${to}</code>. you have <code>${eth(bal)} ETH</code>; pick or type an amount.`, kb(
          [btn(`half (${eth(spendable / 2n)})`, `w:${to}:${eth(spendable / 2n, 18)}`), btn(`all but gas (${eth(spendable)})`, `w:${to}:${eth(spendable, 18)}`)],
          [btn("custom amount", `ask:wto:${to}`)],
          back(),
        ));
      }
      case "withdrawAmount": {
        if (!pending.to) return this.#ask(chatId, "withdrawTo");
        return this.#withdraw(chatId, tgId, pending.to, text);
      }
      case "token": {
        const t = ADDRESS.exec(text)?.[0];
        if (!t) return this.#say(chatId, "that is not an address. paste the token's contract, 0x… (42 characters).", kb(back()));
        return this.#tokenCard(chatId, tgId, t as Address);
      }
      case "buyPresets": {
        const parts = text.split(/[\s,]+/).filter(Boolean);
        const parsed = parts.map(parseEth);
        if (parts.length !== 3 || parsed.some((p) => p === null || p === 0n || p > MAX_BUY)) {
          return this.#say(chatId, `three amounts in ETH, each above zero and at most ${eth(MAX_BUY)}: like 0.001 0.005 0.01`, kb(back("settings")));
        }
        wallet.settings.buyPresets = parts;
        await this.#d.store.put(wallet);
        return this.#settings(chatId, tgId);
      }
      case "sellPresets": {
        const parts = text.split(/[\s,]+/).filter(Boolean).map((p) => Number(p.replace("%", "")));
        if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p) || p < 1 || p > 100)) {
          return this.#say(chatId, "three whole percentages, 1 to 100: like 25 50 100", kb(back("settings")));
        }
        wallet.settings.sellPresets = parts;
        await this.#d.store.put(wallet);
        return this.#settings(chatId, tgId);
      }
      case "buySlippage":
      case "sellSlippage": {
        const value = Number(text.replace("%", ""));
        if (!Number.isFinite(value) || value < 0.5 || value > 20) return this.#say(chatId, "a percentage between 0.5 and 20.", kb(back("settings")));
        if (key === "buySlippage") wallet.settings.buySlippageBps = Math.round(value * 100);
        else wallet.settings.sellSlippageBps = Math.round(value * 100);
        await this.#d.store.put(wallet);
        return this.#settings(chatId, tgId);
      }
    }
  }

  // ---------- start and the home card ----------

  async #start(chatId: string, tgId: string, firstName?: string, startParam?: string): Promise<void> {
    let wallet = await this.#d.store.get(tgId);
    let fresh = false;
    if (!wallet) {
      const key = generatePrivateKey();
      const refCode = refCodeOf(tgId, this.#d.keySecret);
      // A referral link is t.me/<bot>?start=r-<code>; you cannot refer yourself, and the code has to exist.
      let referredBy: string | null = null;
      const code = startParam?.startsWith("r-") ? startParam.slice(2) : undefined;
      if (code && code !== refCode && (await this.#d.store.byRefCode(code))) referredBy = code;
      wallet = withDefaults({
        tgId, address: privateKeyToAccount(key).address, sealedKey: sealKey(key, this.#d.keySecret),
        createdAt: this.#now().toISOString(), refCode, referredBy,
      });
      await this.#d.store.put(wallet);
      fresh = true;
    }
    if (fresh) {
      const topped = await this.#tryFaucet(wallet);
      await this.#say(chatId,
        `gm${firstName ? ` ${esc(firstName)}` : ""}. made you a wallet on <b>Robinhood Chain testnet</b>. test ETH, test tokens, nothing real, and we hold this key so you can try things in one tap. on mainnet the key stays with you; that is the whole point of Chit.\n\n` +
        (topped ? `topped it up with <code>${eth(this.#faucetWei)} test ETH</code>.` : "the faucet is dry right now; ask again from the card in a while.") +
        (wallet.referredBy ? "\n\nyou came through a referral link; that is on your card." : ""));
    } else {
      await this.#say(chatId, `welcome back${firstName ? ` ${esc(firstName)}` : ""}.`);
    }
    await this.#home(chatId, tgId);
  }

  async #card(wallet: BotWallet): Promise<string> {
    const ethBal = await this.#d.chain.ethBalance(wallet.address);
    const held = await this.#holdings(wallet);
    const lines = [
      `<b>Robinhood Chain testnet</b> · 46630`,
      `<code>${wallet.address}</code> <i>(tap to copy)</i>`,
      `balance: <code>${eth(ethBal)} ETH</code>`,
    ];
    if (held.length) lines.push(held.map((h) => `<code>${fmt(h.balance, h.info.decimals, 4)} ${esc(h.info.symbol)}</code>`).join(" · "));
    lines.push("", "press Refresh for fresh figures. paste any token's contract address to see its card.");
    lines.push(`<i>testnet playground: this key is ours, the ETH is test ETH. never do this with real money; on mainnet Chit uses session keys and never holds yours.</i>`);
    return lines.join("\n");
  }

  #homeKeyboard(): Keyboard {
    return kb(
      [btn("💰 Buy", "buy:"), btn("💸 Sell", "sell:")],
      [btn("📊 Positions", "positions"), btn("🚀 Fleet", "fleet")],
      [btn("🔑 Sessions", "sessions"), btn("🤝 Refer", "refer")],
      [btn("⚙️ Settings", "settings"), btn("🏦 Withdraw", "withdraw")],
      [btn("❓ Help", "help"), btn("↻ Refresh", "home")],
    );
  }

  async #home(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    await this.#out(chatId, messageId, await this.#card(wallet), this.#homeKeyboard());
  }

  // ---------- tokens ----------

  #tokensOf(wallet: BotWallet): Address[] {
    const list = [this.#d.chain.defaultToken, ...wallet.tokens];
    return [...new Map(list.map((t) => [t.toLowerCase(), t])).values()] as Address[];
  }

  async #remember(wallet: BotWallet, token: Address): Promise<void> {
    const key = token.toLowerCase();
    if (key === this.#d.chain.defaultToken.toLowerCase() || wallet.tokens.some((t) => t.toLowerCase() === key)) return;
    wallet.tokens = [...wallet.tokens, token].slice(-MAX_TOKENS_REMEMBERED);
    await this.#d.store.put(wallet);
  }

  async #holdings(wallet: BotWallet): Promise<Array<{ info: TokenInfo; balance: bigint }>> {
    const rows = await Promise.all(this.#tokensOf(wallet).map(async (token) => {
      const [info, balance] = await Promise.all([this.#d.chain.tokenInfo(token), this.#d.chain.tokenBalance(token, wallet.address)]);
      return { info, balance };
    }));
    return rows.filter((r) => r.balance > 0n);
  }

  async #tokenCard(chatId: string, tgId: string, token: Address, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(token)) return this.#say(chatId, "that is not an address.", kb(back()));
    const [info, balance, ethBal] = await Promise.all([this.#d.chain.tokenInfo(token), this.#d.chain.tokenBalance(token, wallet.address), this.#d.chain.ethBalance(wallet.address)]);
    if (!info.hasPool) {
      return this.#out(chatId, messageId, `<b>${esc(info.symbol)}</b> <code>${token}</code>\nno ETH pool on the venue for this token, so nothing to buy it with here.`, kb(back()));
    }
    await this.#remember(wallet, token);
    const s = wallet.settings;
    const text = [
      `<b>${esc(info.symbol)}</b> · <code>${token}</code> <i>(tap to copy)</i>`,
      `price: <code>${fmt(info.perEth, info.decimals, 2)} ${esc(info.symbol)}</code> per ETH · pool: <code>${eth(info.poolEth, 4)} ETH</code>`,
      `you hold: <code>${fmt(balance, info.decimals, 4)} ${esc(info.symbol)}</code> · wallet: <code>${eth(ethBal)} ETH</code>`,
      "",
      `<i>quotes from the pool with fee and impact; buys guarded at ${pct(s.buySlippageBps)}, sells at ${pct(s.sellSlippageBps)}. the reply carries the hash.</i>`,
    ].join("\n");
    await this.#out(chatId, messageId, text, kb(
      s.buyPresets.map((p) => btn(`Buy ${p} ETH`, `${s.confirmTrades ? "bc" : "b"}:${token}:${p}`)),
      [btn("Buy custom", `ask:buy:${token}`)],
      s.sellPresets.map((p) => btn(`Sell ${p}%`, `${s.confirmTrades ? "sc" : "s"}:${token}:${p}`)),
      [btn("Sell custom", `ask:sell:${token}`)],
      [btn("↻ Refresh", `token:${token}`), btn("← Back", "home")],
    ));
  }

  // ---------- buy ----------

  async #buyMenu(chatId: string, tgId: string, token: Address | "", messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (token) return this.#tokenCard(chatId, tgId, token, messageId);
    const tokens = this.#tokensOf(wallet);
    const infos = await Promise.all(tokens.map((t) => this.#d.chain.tokenInfo(t)));
    const rows = infos.filter((i) => i.hasPool).map((i) => [btn(`${i.symbol}`, `token:${i.address}`)]);
    await this.#out(chatId, messageId, `<b>buy</b>\npick a token, or paste any token's contract address.`, kb(...rows, [btn("paste a contract address", "token:")], back()));
  }

  async #buy(chatId: string, tgId: string, token: Address, raw: string, confirmed: boolean): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(token)) return this.#say(chatId, "that is not a token address.", kb(back()));
    const amount = parseEth(raw);
    if (!amount || amount === 0n) return this.#say(chatId, "an amount like 0.002.", kb([btn("Buy custom", `ask:buy:${token}`)], back()));
    if (amount > MAX_BUY) return this.#say(chatId, `keep it under ${eth(MAX_BUY)} ETH a trade on the playground.`, kb(back(`token:${token}`)));
    const s = wallet.settings;
    if (s.confirmTrades && !confirmed) {
      const info = await this.#d.chain.tokenInfo(token);
      return this.#say(chatId, `buy <code>${eth(amount)} ETH</code> of ${esc(info.symbol)}?`, kb([btn("✅ Confirm", `bc:${token}:${raw}`), btn("✖ Cancel", `token:${token}`)]));
    }
    if (this.#busy.has(tgId)) return this.#say(chatId, "one trade at a time; the last one is still landing.");
    this.#busy.add(tgId);
    try {
      const [bal, quote, info] = await Promise.all([this.#d.chain.ethBalance(wallet.address), this.#d.chain.quoteBuy(token, amount), this.#d.chain.tokenInfo(token)]);
      if (bal < amount + MIN_GAS_RESERVE) return this.#say(chatId, `not enough: you have <code>${eth(bal)} ETH</code> and a trade needs the amount plus a little gas.`, kb([btn("Faucet", "faucet")], back(`token:${token}`)));
      if (quote === null || quote === 0n) return this.#say(chatId, "no price in the pool right now.", kb(back(`token:${token}`)));
      const minOut = minOutFor(quote, s.buySlippageBps);
      await this.#say(chatId, `buying ${esc(info.symbol)} with <code>${eth(amount)} ETH</code>: about <code>${fmt(quote, info.decimals, 4)}</code>, at least <code>${fmt(minOut, info.decimals, 4)}</code> or it reverts…`);
      const before = await this.#d.chain.tokenBalance(token, wallet.address);
      const landed = await this.#d.chain.buy(openKey(wallet.sealedKey, this.#d.keySecret), token, amount, minOut);
      if (!landed.ok) return this.#say(chatId, `the buy reverted (<code>${landed.hash}</code>): the price moved past your ${pct(s.buySlippageBps)} guard, or the pool is thin. nothing was spent but gas.`, kb([btn("try again", `token:${token}`)], back()));
      const got = (await this.#d.chain.tokenBalance(token, wallet.address)) - before;
      await this.#remember(wallet, token);
      await this.#say(chatId, `✅ bought <code>${fmt(got, info.decimals, 4)} ${esc(info.symbol)}</code> for <code>${eth(amount)} ETH</code>\ntx <code>${landed.hash}</code>`, kb([btn(`${info.symbol} card`, `token:${token}`), btn("📊 Positions", "positions")], back()));
    } finally {
      this.#busy.delete(tgId);
    }
  }

  // ---------- sell ----------

  async #sellMenu(chatId: string, tgId: string, token: Address | "", messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (token) return this.#tokenCard(chatId, tgId, token, messageId);
    const held = await this.#holdings(wallet);
    if (!held.length) return this.#out(chatId, messageId, "nothing to sell yet: you hold no tokens. buy some first.", kb([btn("💰 Buy", "buy:")], back()));
    await this.#out(chatId, messageId, `<b>sell</b>\npick a position.`, kb(...held.map((h) => [btn(`${h.info.symbol} · ${fmt(h.balance, h.info.decimals, 4)}`, `token:${h.info.address}`)]), back()));
  }

  async #sell(chatId: string, tgId: string, token: Address, percent: number, confirmed: boolean): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(token)) return this.#say(chatId, "that is not a token address.", kb(back()));
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return this.#say(chatId, "a whole percentage, 1 to 100.", kb([btn("Sell custom", `ask:sell:${token}`)], back()));
    const s = wallet.settings;
    const [held, info] = await Promise.all([this.#d.chain.tokenBalance(token, wallet.address), this.#d.chain.tokenInfo(token)]);
    const amount = (held * BigInt(percent)) / 100n;
    if (amount === 0n) return this.#say(chatId, `nothing to sell: you hold no ${esc(info.symbol)}.`, kb(back(`token:${token}`)));
    const needsConfirm = (s.confirmTrades || (s.sellProtection && percent > 75)) && !confirmed;
    if (needsConfirm) {
      return this.#say(chatId, `sell <code>${percent}%</code> of your ${esc(info.symbol)}, <code>${fmt(amount, info.decimals, 4)}</code>?${percent > 75 && s.sellProtection ? " (sell protection: that is most of the position)" : ""}`, kb([btn("✅ Confirm", `sc:${token}:${percent}`), btn("✖ Cancel", `token:${token}`)]));
    }
    if (this.#busy.has(tgId)) return this.#say(chatId, "one trade at a time; the last one is still landing.");
    this.#busy.add(tgId);
    try {
      const [bal, quote] = await Promise.all([this.#d.chain.ethBalance(wallet.address), this.#d.chain.quoteSell(token, amount)]);
      if (bal < MIN_GAS_RESERVE) return this.#say(chatId, "not enough ETH for gas.", kb([btn("Faucet", "faucet")], back(`token:${token}`)));
      if (quote === null || quote === 0n) return this.#say(chatId, "no price in the pool right now.", kb(back(`token:${token}`)));
      const minOut = minOutFor(quote, s.sellSlippageBps);
      await this.#say(chatId, `selling <code>${fmt(amount, info.decimals, 4)} ${esc(info.symbol)}</code> (${percent}%): about <code>${eth(quote)} ETH</code>, at least <code>${eth(minOut)}</code> or it reverts… (a first sale approves the router once)`);
      const ethBefore = await this.#d.chain.ethBalance(wallet.address);
      const landed = await this.#d.chain.sell(openKey(wallet.sealedKey, this.#d.keySecret), token, amount, minOut);
      if (!landed.ok) return this.#say(chatId, `the sale reverted (<code>${landed.hash}</code>). nothing was sold.`, kb([btn("try again", `token:${token}`)], back()));
      const ethAfter = await this.#d.chain.ethBalance(wallet.address);
      await this.#say(chatId, `✅ sold <code>${fmt(amount, info.decimals, 4)} ${esc(info.symbol)}</code>; wallet <code>${eth(ethBefore)}</code> → <code>${eth(ethAfter)} ETH</code> after gas\ntx <code>${landed.hash}</code>`, kb([btn(`${info.symbol} card`, `token:${token}`), btn("📊 Positions", "positions")], back()));
    } finally {
      this.#busy.delete(tgId);
    }
  }

  // ---------- positions, withdraw, faucet ----------

  async #positions(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const [ethBal, held] = await Promise.all([this.#d.chain.ethBalance(wallet.address), this.#holdings(wallet)]);
    const lines = [`<b>positions</b> · <code>${short(wallet.address)}</code>`, `ETH: <code>${eth(ethBal)}</code>`];
    const rows: Keyboard = [];
    for (const h of held) {
      const worth = await this.#d.chain.quoteSell(h.info.address, h.balance);
      lines.push(`${esc(h.info.symbol)}: <code>${fmt(h.balance, h.info.decimals, 4)}</code>` + (worth ? ` ≈ <code>${eth(worth)} ETH</code> if sold now` : ""));
      rows.push([btn(`${h.info.symbol}`, `token:${h.info.address}`), btn("Sell 50%", `${wallet.settings.confirmTrades ? "sc" : "s"}:${h.info.address}:50`), btn("Sell 100%", `sc:${h.info.address}:100`)]);
    }
    if (!held.length) lines.push("no tokens yet.");
    lines.push("", "<i>\"if sold now\" is the pool's fill for the whole position, fee and impact included.</i>");
    await this.#out(chatId, messageId, lines.join("\n"), kb(...rows, [btn("💰 Buy", "buy:"), btn("↻ Refresh", "positions")], back()));
  }

  async #withdraw(chatId: string, tgId: string, to: Address, raw: string): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(to)) return this.#say(chatId, "that is not an address.", kb(back()));
    const amount = parseEth(raw);
    if (!amount || amount === 0n) return this.#say(chatId, "an amount like 0.01.", kb([btn("custom amount", `ask:wto:${to}`)], back()));
    const bal = await this.#d.chain.ethBalance(wallet.address);
    if (bal < amount + parseEther("0.0002")) return this.#say(chatId, `you have <code>${eth(bal)} ETH</code>; leave a little for gas.`, kb(back()));
    if (this.#busy.has(tgId)) return this.#say(chatId, "one thing at a time; the last transaction is still landing.");
    this.#busy.add(tgId);
    try {
      const landed = await this.#d.chain.send(openKey(wallet.sealedKey, this.#d.keySecret), to, amount);
      await this.#say(chatId, landed.ok ? `✅ sent <code>${eth(amount)} ETH</code> to <code>${to}</code>\ntx <code>${landed.hash}</code>` : `the send reverted (<code>${landed.hash}</code>).`, kb(back()));
    } finally {
      this.#busy.delete(tgId);
    }
  }

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
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const last = wallet.faucetAt ? Date.parse(wallet.faucetAt) : 0;
    const wait = last + this.#faucetEveryMs - this.#now().getTime();
    if (wait > 0) return this.#say(chatId, `the faucet is once a day per wallet. again in about ${Math.ceil(wait / 3_600_000)}h.`, kb(back()));
    const ok = await this.#tryFaucet(wallet);
    await this.#say(chatId, ok ? `sent <code>${eth(this.#faucetWei)} test ETH</code> to your wallet.` : "the faucet is dry right now. try later.", kb(back()));
  }

  // ---------- settings ----------

  async #settings(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const s = wallet.settings;
    const on = (v: boolean) => (v ? "🟢" : "🔴");
    const text = [
      `<b>settings</b>`,
      `buy amounts: <code>${s.buyPresets.join(" · ")} ETH</code>`,
      `sell shares: <code>${s.sellPresets.join("% · ")}%</code>`,
      `buy slippage <code>${pct(s.buySlippageBps)}</code> · sell slippage <code>${pct(s.sellSlippageBps)}</code>`,
      `${on(s.confirmTrades)} confirm trades: ${s.confirmTrades ? "on, every trade asks first" : "off, a tap trades"}`,
      `${on(s.sellProtection)} sell protection: ${s.sellProtection ? "on, selling over 75% asks first" : "off"}`,
      "",
      `<i>no priority fees, no MEV toggles, no turbo: the chain has a sequencer and none of that exists here. the guard is the slippage.</i>`,
    ].join("\n");
    await this.#out(chatId, messageId, text, kb(
      [btn("✏️ buy amounts", "set:buyPresets"), btn("✏️ sell shares", "set:sellPresets")],
      [btn(`buy slippage ${pct(s.buySlippageBps)}`, "set:buySlippage"), btn(`sell slippage ${pct(s.sellSlippageBps)}`, "set:sellSlippage")],
      [btn(`${on(s.confirmTrades)} confirm trades`, "set:confirmTrades"), btn(`${on(s.sellProtection)} sell protection`, "set:sellProtection")],
      [btn("reset to defaults", "set:reset")],
      back(),
    ));
  }

  async #setting(chatId: string, tgId: string, which: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    switch (which) {
      case "buyPresets": return this.#ask(chatId, "buyPresets");
      case "sellPresets": return this.#ask(chatId, "sellPresets");
      case "buySlippage": return this.#ask(chatId, "buySlippage");
      case "sellSlippage": return this.#ask(chatId, "sellSlippage");
      case "confirmTrades": wallet.settings.confirmTrades = !wallet.settings.confirmTrades; break;
      case "sellProtection": wallet.settings.sellProtection = !wallet.settings.sellProtection; break;
      case "reset": wallet.settings = { ...DEFAULT_SETTINGS } satisfies BotSettings; break;
      default: return this.#settings(chatId, tgId, messageId);
    }
    await this.#d.store.put(wallet);
    return this.#settings(chatId, tgId, messageId);
  }

  // ---------- referral, fleet, sessions, pool, help ----------

  async #refer(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const referred = await this.#d.store.referralsOf(wallet.refCode);
    const link = `https://t.me/${this.#d.botUsername}?start=r-${wallet.refCode}`;
    await this.#out(chatId, messageId, [
      `<b>refer</b>`,
      `your link: <code>${esc(link)}</code>`,
      `people who came through it: <code>${referred}</code>`,
      "",
      `rewards: none yet, and we say so. the roadmap's referral pays when the fee goes live, from the fee, and only for referrals the chain can see (a fleet that actually deposits). until then this counts, nothing more.`,
      wallet.referredBy ? `you came through <code>${esc(wallet.referredBy)}</code>.` : "",
    ].filter(Boolean).join("\n"), kb(back()));
  }

  // ---------- the fleet: Chit's own product, from the chat ----------

  #driver(wallet: BotWallet): FleetDriver | undefined {
    if (!this.#d.fleetApi) return undefined;
    const account = privateKeyToAccount(openKey(wallet.sealedKey, this.#d.keySecret));
    return new FleetDriver(this.#d.fleetApi, wallet.address, (message) => account.signMessage({ message }), this.#now);
  }

  async #fleet(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const intro = [
      `<b>fleet</b>: the thing Chit is for.`,
      `one deposit into a shared pool, a fleet of five wallets funded from it after a random wait, one buy through the router from every wallet, and no transaction linking your deposit to them. the operator can see the link and says so; the chain cannot.`,
    ];
    if (!this.#d.fleetApi) {
      return this.#out(chatId, messageId, [...intro, "", `from this chat it is not wired yet. today it lives in the app: <a href="${esc(this.#site)}/app/balance.html">Balance</a> → <a href="${esc(this.#site)}/app/fleet.html">Set up</a> → <a href="${esc(this.#site)}/app/trade.html">Trade</a> → <a href="${esc(this.#site)}/app/fleet-dashboard.html">Control Room</a>.`].join("\n"), kb(back()));
    }
    const fleet = wallet.fleet;
    const phase = fleetPhase(fleet);
    const lines = [...intro, ""];
    const rows: Keyboard = [];
    if (fleet) {
      lines.push(`your fleet: <code>${esc(fleet.campaign)}</code> · <b>${esc(fleet.state || phase)}</b>` + (fleet.fleet.length ? ` · ${fleet.fleet.length} wallets` : ""));
    }
    switch (phase) {
      case "none":
      case "closed":
        lines.push(fleet ? "closed; the unspent draw went back to your balance. start another when you like." : "step 1: put ETH in the pool from your wallet, a published size. step 2: create the fleet. step 3: activate it with a draw; after a random wait it is funded. step 4: buy.");
        rows.push([btn("① deposit 0.01", "fl:dep:0.01"), btn("① deposit 0.05", "fl:dep:0.05")], [btn("② create a fleet of 5", "fl:create")]);
        break;
      case "created":
        lines.push("created and confirmed. activate it with a draw from your pool balance; the pool funds the five wallets after a random wait of up to fifteen minutes.");
        rows.push([btn("③ activate, draw 0.02", "fl:act:0.02"), btn("③ activate, draw 0.005", "fl:act:0.005")]);
        break;
      case "activating":
        lines.push("activating: the draw is open and the wait is running. refresh in a few minutes.");
        rows.push([btn("↻ status", "fl:status")]);
        break;
      case "active":
        lines.push("funded. one buy from every wallet through the router, principal sent just in time. pause holds it; close returns the unspent draw to your balance.");
        rows.push([btn("④ buy 0.0005 each", "fl:buy:0.0005"), btn("④ buy 0.001 each", "fl:buy:0.001")], [btn("⏸ pause", "fl:pause"), btn("✖ close", "fl:close")], [btn("↻ status", "fl:status")]);
        break;
      case "paused":
        rows.push([btn("▶ resume", "fl:resume"), btn("✖ close", "fl:close")], [btn("↻ status", "fl:status")]);
        break;
    }
    rows.push([btn("pool balance", "fl:bal"), btn("← Back", "home")]);
    await this.#out(chatId, messageId, lines.join("\n"), kb(...rows));
  }

  async #fleetAction(chatId: string, tgId: string, verb: string, arg: string): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const driver = this.#driver(wallet);
    if (!driver) return this.#fleet(chatId, tgId);
    if (this.#busy.has(tgId)) return this.#say(chatId, "one thing at a time; the last step is still landing.");
    this.#busy.add(tgId);
    try {
      switch (verb) {
        case "dep": {
          const wei = parseEth(arg);
          if (!wei) return this.#say(chatId, "a published size: 0.01, 0.05 or 0.1.", kb(back("fleet")));
          const bal = await this.#d.chain.ethBalance(wallet.address);
          if (bal < wei + MIN_GAS_RESERVE) return this.#say(chatId, `not enough: you have <code>${eth(bal)} ETH</code>.`, kb([btn("Faucet", "faucet")], back("fleet")));
          const landed = await this.#d.chain.deposit(openKey(wallet.sealedKey, this.#d.keySecret), wei);
          if (!landed.ok) return this.#say(chatId, `the deposit reverted (<code>${landed.hash}</code>): the pool takes 0.01, 0.05 or 0.1 and refuses above its caps.`, kb(back("fleet")));
          await this.#say(chatId, `✅ deposited <code>${eth(wei)} ETH</code> into the pool. it carries no fleet marker.\ntx <code>${landed.hash}</code>`);
          return this.#fleet(chatId, tgId);
        }
        case "create": {
          const accounts = FleetDriver.generateAccounts(5, this.#d.keySecret);
          await this.#say(chatId, "creating a fleet of five: fresh keys, sealed; the service sees addresses and salts, never keys…");
          const record = await driver.createFleet({
            accounts, chainId: this.#d.chain.chainId, router: this.#d.chain.router, fn: "execute(bytes,bytes[],uint256)",
            maxTradeValue: parseEther("0.001"), perAccountGas: parseEther("0.0002"), days: 7,
          });
          wallet.fleet = record;
          await this.#d.store.put(wallet);
          await this.#say(chatId, `✅ fleet <code>${esc(record.campaign)}</code> created and its recovery confirmed.`);
          return this.#fleet(chatId, tgId);
        }
        case "act": {
          const draw = parseEth(arg);
          if (!draw || !wallet.fleet) return this.#fleet(chatId, tgId);
          const r = await driver.activate(wallet.fleet.campaign, draw);
          wallet.fleet = { ...wallet.fleet, state: r.state || "Activating", fleet: r.accounts.length ? r.accounts : wallet.fleet.fleet };
          await this.#d.store.put(wallet);
          await this.#say(chatId, `✅ activated with a draw of <code>${eth(draw)} ETH</code>: <b>${esc(wallet.fleet.state)}</b>. the pool funds the wallets after a random wait; nothing links the deposit to them.`);
          return this.#fleet(chatId, tgId);
        }
        case "status": {
          if (!wallet.fleet) return this.#fleet(chatId, tgId);
          const s = await driver.status(wallet.fleet.campaign);
          const accounts = (s["accounts"] as Address[] | undefined) ?? wallet.fleet.fleet;
          wallet.fleet = { ...wallet.fleet, state: String(s["state"] ?? wallet.fleet.state), fleet: accounts };
          await this.#d.store.put(wallet);
          const budget = s["budget"] as { funded?: string; spent?: string; unused?: string } | undefined;
          await this.#say(chatId, `<b>${esc(wallet.fleet.state)}</b>` + (budget ? ` · draw <code>${eth(BigInt(budget.funded ?? "0"))} ETH</code>, spent <code>${eth(BigInt(budget.spent ?? "0"))}</code>, unused <code>${eth(BigInt(budget.unused ?? "0"))}</code>` : "") + (accounts.length ? `\nwallets: ${accounts.map((a) => `<code>${short(a)}</code>`).join(" ")}` : ""));
          return this.#fleet(chatId, tgId);
        }
        case "buy": {
          const value = parseEth(arg);
          if (!value || !wallet.fleet || !wallet.fleet.fleet.length) return this.#fleet(chatId, tgId);
          const r = await driver.buy(wallet.fleet.campaign, wallet.fleet.fleet, this.#d.chain.defaultToken, value);
          const results = (r["results"] as Array<{ account: Address; status: string; txHash?: string; reason?: string }> | undefined) ?? [];
          const ok = results.filter((x) => x.status === "sponsored").length;
          await this.#say(chatId, `bought from <b>${ok}</b> of ${results.length} wallets, <code>${eth(value)} ETH</code> each, through the router.\n` + results.map((x) => `${x.status === "sponsored" ? "✅" : "✖"} <code>${short(x.account)}</code>${x.txHash ? ` <code>${short(x.txHash)}</code>` : ""}${x.reason ? ` ${esc(x.reason)}` : ""}`).join("\n"));
          return this.#fleet(chatId, tgId);
        }
        case "pause": case "resume": case "close": {
          if (!wallet.fleet) return this.#fleet(chatId, tgId);
          const r = await driver.control(verb, wallet.fleet.campaign);
          wallet.fleet = { ...wallet.fleet, state: String(r["state"] ?? verb) };
          await this.#d.store.put(wallet);
          await this.#say(chatId, `✅ ${verb}: <b>${esc(wallet.fleet.state)}</b>` + (verb === "close" ? ". the unspent draw is back in your pool balance." : ""));
          return this.#fleet(chatId, tgId);
        }
        case "bal": {
          const b = await driver.balance();
          await this.#say(chatId, `<b>pool balance</b>\navailable <code>${eth(BigInt(String(b["available"] ?? "0")))} ETH</code> · in open fleets <code>${eth(BigInt(String(b["openDraws"] ?? "0")))}</code> · deposited <code>${eth(BigInt(String(b["deposited"] ?? "0")))}</code> · spent <code>${eth(BigInt(String(b["spent"] ?? "0")))}</code>`, kb(back("fleet")));
          return;
        }
        default:
          return this.#fleet(chatId, tgId);
      }
    } catch (error) {
      if (error instanceof FleetError) {
        return this.#say(chatId, `the service said <code>${esc(error.code)}</code> (${error.status}).` + (error.status === 503 ? " it is not wired to the pool yet, or the chain is slow; try again in a minute." : ""), kb(back("fleet")));
      }
      throw error;
    } finally {
      this.#busy.delete(tgId);
    }
  }

  async #sessions(chatId: string, messageId?: number): Promise<void> {
    await this.#out(chatId, messageId, [
      `<b>session keys</b>: how this bot works on mainnet.`,
      `Trojan gives you speed by taking your key. Chit gives you speed without it: you keep your wallet, grant the bot a session once (which router, how much per trade, how much in all, until when), and the bot signs only inside that. pull the key from your wallet in one transaction.`,
      ``,
      `the contract is written and tested against the live router. the page is <a href="${esc(this.#site)}/app/sessions.html">Sessions</a>; the buttons here become sessions there.`,
    ].join("\n"), kb(back()));
  }

  async #pool(chatId: string): Promise<void> {
    const p = await this.#d.chain.poolNumbers();
    if (!p) return this.#say(chatId, "the pool is not configured on this bot yet.");
    await this.#say(chatId, `<b>the pool</b> · <code>${short(p.address)}</code>\nholds <code>${eth(p.heldWei)} ETH</code> · <code>${eth(p.totalDeposited)} ETH</code> ever deposited · ${p.campaigns} fleet${p.campaigns === 1n ? "" : "s"} funded${p.paused ? " · <b>paused</b>" : ""}\n<i>read from the chain just now. testnet.</i>`);
  }

  async #help(chatId: string, messageId?: number): Promise<void> {
    await this.#out(chatId, messageId, [
      `<b>Chit Bot</b>, Robinhood Chain testnet`,
      `• Start makes you a testnet wallet and tops it up.`,
      `• Buy and Sell go through the real Uniswap v4 router, quoted from the pool with fee and impact, guarded by your slippage. every reply has the transaction hash.`,
      `• paste any token's contract address to get its card with buy and sell buttons.`,
      `• Positions shows what you hold and what it would fetch now.`,
      `• Withdraw moves test ETH to an address you paste. Faucet tops you up once a day.`,
      `• Settings: your amounts, shares, slippage, a confirmation step, sell protection.`,
      `• Fleet and Sessions explain the real products and where they live.`,
      ``,
      `<i>everything here is testnet and test tokens. the bot holds this playground key; on mainnet it never holds yours.</i>`,
    ].join("\n"), kb(back()));
  }
}

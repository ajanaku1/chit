/**
 * Chit Bot: the Telegram trading bot on Robinhood Chain, testnet edition.
 *
 * The shape every degen already knows (a card with the wallet and the
 * balance, buttons under it, a reply field that opens when a number is
 * needed, paste a contract address and get its card), on a chain that has
 * no such bot. On testnet the bot makes the wallet for you on Start and
 * holds its key, because a testnet key holds nothing but test ETH and the
 * point is to let anyone try Chit in one tap. On mainnet, which is next and
 * not live, the same buttons will drive a session on the user's own account
 * through session keys (docs/session-keys.md), and the bot will never hold
 * a key at all; that is the line this bot exists to draw.
 *
 * Every figure on a card is read from the chain when the card is drawn.
 * Every trade is a real transaction through the real Uniswap v4 router, and
 * the reply carries its hash. Nothing is estimated as if it happened. There
 * are no priority fees, no MEV toggles and no turbo modes here, because the
 * chain has a sequencer and none of that exists on it; the settings are the
 * ones that mean something: amounts, slippage, a confirmation step.
 *
 * Money moves only under a lock the store holds per wallet, so two taps, or
 * one tap answered by two function instances, cannot race on a nonce or
 * spend twice; every Telegram update is claimed by id before it is acted
 * on, so a redelivery does nothing; every button carries what it needs in
 * at most 64 bytes, and every reply prompt carries the token or address it
 * was about in its own text, so nothing depends on an instance's memory.
 *
 * This module is pure over its ports (store, chain, telegram, the fleet
 * service), so the tests run the whole conversation against fakes.
 */

import { formatUnits, isAddress, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { BotBridge } from "./bot-bridge.js";
import type { BotChain, Landed, NewPool, TokenInfo } from "./bot-chain.js";
import { FleetDriver, FleetError, fleetPhase, type FleetApi } from "./bot-fleet.js";
import type { ShareRenderer } from "./bot-share.js";
import { CAPTION_MAX_CHARS, esc, type Keyboard, type Outgoing, type Telegram } from "./bot-telegram.js";
import {
  CANARY_KEY, DEFAULT_SETTINGS, RefCodeTaken, SealError, checkCanary, fleetAad, fleetKeyAad, open, openKey, refCodeOf, seal, sealCanary, sealKey, walletAad, withDefaults,
  type BotSettings, type BotWallet, type BotWalletStore, type FleetRecordLike,
} from "./bot-wallets.js";
import type { HeyScanner } from "./bot-hey.js";
import { heyLine } from "./bot-hey.js";
import type { OrusScanner } from "./bot-orus.js";
import { orusLine } from "./bot-orus.js";
import { minimumDraw } from "./pool-buy.js";
import type { Address, Hex } from "./types.js";
import { minOutFor } from "./v4-swap.js";

export type BotDeps = {
  store: BotWalletStore;
  chain: BotChain;
  telegram: Telegram;
  /** The hosted fleet service; absent means the Fleet card only explains. */
  fleetApi?: FleetApi;
  /** The way in from other chains (Relay); absent means no Bridge card. */
  bridge?: BotBridge;
  /** Draws a position as a picture with the referral link on it; absent means no 📸 button. */
  share?: ShareRenderer;
  /** Orus, the safety line on the token card; absent means the card has no such line. */
  orus?: OrusScanner;
  /** HEY, the builder line on the token card; absent means the card has no such line. */
  hey?: HeyScanner;
  /** Seals the playground keys at rest and keys the referral codes. */
  keySecret: string;
  /** The bot's @username, for links. */
  botUsername: string;
  /** What Start hands a new wallet, and what the faucet tops up, in wei. */
  faucetWei?: bigint;
  /** How long a wallet waits between faucet top-ups. */
  faucetEveryMs?: number;
  /** The most the faucet pays out in a UTC day, across everyone. */
  faucetDailyWei?: bigint;
  /** Where the app lives. */
  siteUrl?: string;
  /** Banner images for the cards that have one: https URLs or local paths; a card without one is plain text. */
  banners?: Partial<Record<BannerKey, string>>;
  now?: () => Date;
};

export type BannerKey = "home" | "refer" | "fleet" | "buy";

export type Update = {
  /** Telegram's update id; the same id delivered twice is acted on once. */
  update_id?: number;
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
    /** `photo` is set when the button sat under a banner card: such a message can take another banner, never plain text. */
    message?: { message_id: number; chat: { id: number; type: string }; photo?: unknown };
  };
};

/** The bounds of the playground, so a faucet cannot be drained through a trade. */
const MAX_BUY = parseEther("0.05");
/** What a trade leaves behind for gas: 600k gas at 0.83 gwei, some eighty times the testnet base fee. */
const MIN_GAS_RESERVE = parseEther("0.0005");
const SEND_GAS_RESERVE = parseEther("0.0002");
const MAX_TOKENS_REMEMBERED = 12;
/** A preset the user types is at most this long, so the button that carries it stays under Telegram's 64 bytes. */
const PRESET_MAX_CHARS = 10;
/** Money holds the wallet's lock this long at most: past the function's own sixty seconds, so a killed function frees its wallet soon after. */
const LOCK_TTL_MS = 90_000;
const FAUCET_LOCK_TTL_MS = 60_000;
const FLEET_SIZE = 5;
const DEPOSIT_SIZES = ["0.01", "0.05"] as const;
const DRAW_CHOICES = ["0.005", "0.01", "0.02"] as const;
const FLEET_BUY_CHOICES = ["0.0005", "0.001"] as const;
/** The new-pools tab looks back this far: about a day of the chain at four blocks a second. */
const NEW_POOLS_BLOCKS = 350_000;
const NEW_POOLS_SHOWN = 8;

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
const parseWei = (raw: string): bigint | null => (/^\d{1,30}$/.test(raw) ? BigInt(raw) : null);
const pct = (bps: number): string => `${(bps / 100).toString()}%`;
const ADDRESS = /0x[0-9a-fA-F]{40}/;
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

const kb = (...rows: Keyboard): Keyboard => rows;
/** Telegram refuses a keyboard with callback data over 64 bytes, silently for the user; here it is loud. */
const btn = (text: string, data: string) => {
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error(`callback_data over 64 bytes: ${data}`);
  return { text, callback_data: data };
};
const back = (to = "home") => [btn("← Back", to)];

/**
 * The prompts a reply can be to. Each carries what it is about in its own
 * text (the token, the address), because Telegram hands the prompt back in
 * reply_to_message and nothing else survives between two function instances.
 */
const PROMPT = {
  buyAmount: (symbol: string, token: Address) => `how much ETH to spend on ${symbol}?\n${token}`,
  sellPercent: (symbol: string, token: Address) => `what share of your ${symbol} to sell? (a number, 1 to 100)\n${token}`,
  withdrawTo: () => "paste the address the test ETH goes to",
  withdrawAmount: (to: Address) => `how much ETH to send?\nto ${to}`,
  token: () => "paste the token's contract address",
  buyPresets: () => "your three buy amounts in ETH, like: 0.001 0.005 0.01",
  sellPresets: () => "your three sell shares in percent, like: 25 50 100",
  buySlippage: () => "buy slippage in percent, 0.5 to 20",
  sellSlippage: () => "sell slippage in percent, 0.5 to 20",
} as const;
type PromptKey = keyof typeof PROMPT;
/** What the reply field shows while empty; Telegram allows 64 characters. */
const PLACEHOLDER: Record<PromptKey, string> = {
  buyAmount: "ETH amount, like 0.002",
  sellPercent: "share in percent, like 50",
  withdrawTo: "0x… (42 characters)",
  withdrawAmount: "ETH amount, like 0.01",
  token: "0x… (42 characters)",
  buyPresets: "0.001 0.005 0.01",
  sellPresets: "25 50 100",
  buySlippage: "3",
  sellSlippage: "3",
};
const promptKind = (replied: string): PromptKey | undefined => {
  const first = replied.split("\n")[0] ?? "";
  if (first.startsWith("how much ETH to spend on")) return "buyAmount";
  if (first.startsWith("what share of your")) return "sellPercent";
  if (first === PROMPT.withdrawTo()) return "withdrawTo";
  if (first === "how much ETH to send?") return "withdrawAmount";
  if (first === PROMPT.token()) return "token";
  if (first === PROMPT.buyPresets()) return "buyPresets";
  if (first === PROMPT.sellPresets()) return "sellPresets";
  if (first === PROMPT.buySlippage()) return "buySlippage";
  if (first === PROMPT.sellSlippage()) return "sellSlippage";
  return undefined;
};

type FaucetResult = "sent" | "pending" | "wait" | "budget" | "busy" | "dry" | "off" | "failed";

export class ChitBot {
  readonly #d: BotDeps;
  readonly #faucetWei: bigint;
  readonly #faucetEveryMs: number;
  readonly #faucetDailyWei: bigint;
  readonly #site: string;
  readonly #now: () => Date;
  #sealCheck: Promise<string | undefined> | undefined;
  /** Messages known to be banner cards, `chatId:messageId`, learned from each callback before it is handled. */
  readonly #bannerMessages = new Set<string>();

  constructor(deps: BotDeps) {
    this.#d = deps;
    this.#faucetWei = deps.faucetWei ?? parseEther("0.02");
    this.#faucetEveryMs = deps.faucetEveryMs ?? 24 * 3600 * 1000;
    this.#faucetDailyWei = deps.faucetDailyWei ?? parseEther("0.5");
    this.#site = (deps.siteUrl ?? "https://chit.tools").replace(/\/+$/, "");
    this.#now = deps.now ?? (() => new Date());
  }

  /** One Telegram update in, zero or more messages out. Never throws at the caller: a failure is a message. */
  async handle(update: Update): Promise<void> {
    const chatId = String(update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? "");
    try {
      if (update.update_id !== undefined && !(await this.#d.store.claimUpdate(update.update_id, this.#now()))) return;
      const sealFault = await this.#verifySeal();
      if (sealFault) {
        console.error(`chit bot: sealing secret check failed (${sealFault}); refusing to serve`);
        if (chatId) await this.#say(chatId, "the bot is being repaired: its sealing secret does not match the wallets it holds. nothing is lost; the operator has to restore BOT_KEY_SECRET.");
        return;
      }
      if (update.callback_query) await this.#callback(update.callback_query);
      else if (update.message?.text) await this.#message(update.message);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown";
      console.error("chit bot:", detail);
      if (chatId) await this.#say(chatId, this.#failureText(error), kb(back()));
    }
  }

  /** What a user is told: the chain's own words for a chain failure, a plain line for anything internal (the detail stays in the log). */
  #failureText(error: unknown): string {
    if (error instanceof SealError) {
      return error.code === "secret_mismatch"
        ? "this wallet was sealed under a secret this deployment does not hold. nothing is lost; the operator has to restore BOT_KEY_SECRET."
        : "this wallet's sealed key does not open as stored. the operator has to look; nothing was sent.";
    }
    const chain = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof chain === "string" && chain) return `the chain said: <code>${esc(chain.split("\n")[0] ?? chain)}</code>. try again in a moment.`;
    return "something broke on our side. try again in a moment.";
  }

  /**
   * Once per instance: the store's canary must open under this secret. A
   * rotated or mistyped BOT_KEY_SECRET is caught here, before a Start makes
   * a wallet nobody can open or a trade fails on a bad tag.
   */
  #verifySeal(): Promise<string | undefined> {
    this.#sealCheck ??= (async () => {
      let canary = await this.#d.store.getMeta(CANARY_KEY);
      if (!canary) {
        await this.#d.store.setMeta(CANARY_KEY, sealCanary(this.#d.keySecret));
        canary = await this.#d.store.getMeta(CANARY_KEY);
      }
      if (!canary) return "canary_unreadable";
      try {
        return checkCanary(canary, this.#d.keySecret) ? undefined : "canary_mismatch";
      } catch (error) {
        return error instanceof SealError ? error.code : "canary_error";
      }
    })().catch((error: unknown) => {
      this.#sealCheck = undefined;
      throw error;
    });
    return this.#sealCheck;
  }

  // ---------- sending ----------

  async #say(chatId: string, text: string, keyboard?: Keyboard): Promise<void> {
    await this.#d.telegram.deliver({ kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}) });
  }
  async #ask(chatId: string, key: PromptKey, text: string): Promise<void> {
    await this.#d.telegram.deliver({ kind: "send", chatId, text, ask: PLACEHOLDER[key] });
  }
  /**
   * A card, in place when it can be: text over text, banner over banner. A
   * text message cannot become a photo nor a photo a text, so those cross
   * the line as a fresh message; a caption that would not fit goes as text.
   */
  async #out(chatId: string, messageId: number | undefined, text: string, keyboard?: Keyboard, banner?: BannerKey): Promise<void> {
    const photo = banner ? this.#d.banners?.[banner] : undefined;
    const overBanner = messageId !== undefined && this.#bannerMessages.has(`${chatId}:${messageId}`);
    const kbd = keyboard ? { keyboard } : {};
    let out: Outgoing;
    if (photo && text.length <= CAPTION_MAX_CHARS) {
      out = messageId && overBanner ? { kind: "editPhoto", chatId, messageId, photo, text, ...kbd } : { kind: "photo", chatId, photo, text, ...kbd };
    } else {
      out = messageId && !overBanner ? { kind: "edit", chatId, messageId, text, ...kbd } : { kind: "send", chatId, text, ...kbd };
    }
    await this.#d.telegram.deliver(out);
  }

  // ---------- keys ----------

  #walletKey(wallet: BotWallet): Hex {
    return openKey(wallet.sealedKey, this.#d.keySecret, walletAad(wallet.tgId));
  }
  #fleetOf(wallet: BotWallet): FleetRecordLike | undefined {
    if (!wallet.fleet) return undefined;
    return JSON.parse(open(wallet.fleet, this.#d.keySecret, fleetAad(wallet.tgId)).toString("utf8")) as FleetRecordLike;
  }
  async #saveFleet(tgId: string, record: FleetRecordLike | null): Promise<void> {
    await this.#d.store.patch(tgId, { fleet: record ? seal(Buffer.from(JSON.stringify(record), "utf8"), this.#d.keySecret, fleetAad(tgId)) : null });
  }

  /** Money, one thing at a time per wallet, across every instance: the store's lock, held for the transaction's life. */
  async #locked(chatId: string, tgId: string, fn: () => Promise<void>): Promise<void> {
    const key = `wallet:${tgId}`;
    if (!(await this.#d.store.lock(key, this.#now(), LOCK_TTL_MS))) {
      return this.#say(chatId, "one thing at a time: the last transaction is still landing. wait for its reply.");
    }
    try {
      await fn();
    } finally {
      await this.#d.store.unlock(key);
    }
  }

  // ---------- routing ----------

  async #message(m: NonNullable<Update["message"]>): Promise<void> {
    const chatId = String(m.chat.id);
    const text = (m.text ?? "").trim();
    const tgId = String(m.from?.id ?? "");
    const isPrivate = m.chat.type === "private";
    const [rawCmd = ""] = text.split(/\s+/);
    const [cmd = "", at] = rawCmd.toLowerCase().split("@");
    // /pool@some_other_bot is somebody else's.
    if (at && at !== this.#d.botUsername.toLowerCase()) return;

    if (!isPrivate) {
      // In a group the bot answers its own commands and nothing else: /raid,
      // /report, /ban and the rest belong to other bots in the same room.
      if (cmd === "/pool") return this.#pool(chatId);
      if (cmd === "/start" || cmd === "/help") {
        return this.#say(chatId, `the playground is in private: <a href="https://t.me/${esc(this.#d.botUsername)}?start=go">open the bot</a> and press Start. testnet, test ETH, nothing to lose.`);
      }
      return;
    }
    if (!tgId) return;

    // A reply to one of our prompts carries the answer; the prompt's own text says what it was about.
    const replied = m.reply_to_message?.text;
    if (replied) {
      const key = promptKind(replied);
      if (key) return this.#answer(chatId, tgId, key, replied, text);
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
    if (q.message?.photo && messageId !== undefined) this.#bannerMessages.add(`${chatId}:${messageId}`);
    const ack = (text?: string): Promise<void> => this.#d.telegram.deliver({ kind: "answer", callbackId: q.id, ...(text ? { text } : {}) });
    if (q.message?.chat.type !== "private") { await ack("open the bot in private"); return; }

    const [verb = "", a = "", b = ""] = data.split(":");
    switch (verb) {
      case "home": await ack(); return this.#home(chatId, tgId, messageId);
      case "buy": await ack(); return this.#buyMenu(chatId, tgId, a as Address | "", messageId);
      case "sell": await ack(); return this.#sellMenu(chatId, tgId, a as Address | "", messageId);
      case "positions": await ack(); return this.#positions(chatId, tgId, messageId);
      case "share": await ack("drawing…"); return this.#share(chatId, tgId, a as Address);
      case "new": await ack(); return this.#newPools(chatId, tgId, messageId);
      case "bridge": await ack(); return this.#bridge(chatId, messageId);
      case "token": await ack(); return a ? this.#tokenCard(chatId, tgId, a as Address, messageId) : this.#ask(chatId, "token", PROMPT.token());
      case "fleet": await ack(); return this.#fleet(chatId, tgId, messageId);
      case "fl": await ack(a === "status" || a === "bal" || a === "new" ? undefined : "working…"); return this.#fleetAction(chatId, tgId, a, b, q.id);
      case "sessions": await ack(); return this.#sessions(chatId, messageId);
      case "refer": await ack(); return this.#refer(chatId, tgId, messageId);
      case "settings": await ack(); return this.#settings(chatId, tgId, messageId);
      case "set": await ack(); return this.#setting(chatId, tgId, a, messageId);
      case "withdraw": await ack(); return this.#ask(chatId, "withdrawTo", PROMPT.withdrawTo());
      case "faucet": await ack(); return this.#faucet(chatId, tgId);
      case "help": await ack(); return this.#help(chatId, messageId);
      case "b": await ack("buying…"); return this.#buy(chatId, tgId, a as Address, parseWei(b), false);
      case "bc": await ack("buying…"); return this.#buy(chatId, tgId, a as Address, parseWei(b), true);
      case "s": await ack("selling…"); return this.#sell(chatId, tgId, a as Address, Number(b), false);
      case "sc": await ack("selling…"); return this.#sell(chatId, tgId, a as Address, Number(b), true);
      case "ask": await ack(); return this.#askFor(chatId, tgId, a, b as Address);
      case "w": await ack("sending…"); return this.#withdrawShare(chatId, tgId, a, b as Address);
      default: await ack("unknown button");
    }
  }

  /** Opens the reply field for a custom amount; the prompt names the token or the address so any instance can answer it. */
  async #askFor(chatId: string, tgId: string, what: string, target: Address): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(target)) return this.#say(chatId, "that is not an address.", kb(back()));
    if (what === "buy" || what === "sell") {
      const info = await this.#d.chain.tokenInfo(target);
      const key = what === "buy" ? "buyAmount" : "sellPercent";
      return this.#ask(chatId, key, PROMPT[key](info.symbol, target));
    }
    if (what === "wto") return this.#ask(chatId, "withdrawAmount", PROMPT.withdrawAmount(target));
  }

  async #answer(chatId: string, tgId: string, key: PromptKey, replied: string, text: string): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    // The prompt's second line is the token or the address it was about; a prompt without one is not guessed at.
    const named = ADDRESS.exec(replied.split("\n").slice(1).join("\n"))?.[0] as Address | undefined;
    switch (key) {
      case "buyAmount": {
        if (!named) return this.#say(chatId, "that prompt lost its token. open the token's card and tap Buy custom again.", kb([btn("💰 Buy", "buy:")], back()));
        const amount = parseEth(text);
        if (!amount) return this.#say(chatId, "an amount like 0.002.", kb([btn("Buy custom", `ask:buy:${named}`)], back()));
        return this.#buy(chatId, tgId, named, amount, false);
      }
      case "sellPercent": {
        if (!named) return this.#say(chatId, "that prompt lost its token. open the token's card and tap Sell custom again.", kb([btn("💸 Sell", "sell:")], back()));
        return this.#sell(chatId, tgId, named, Number(text.replace("%", "")), false);
      }
      case "withdrawTo": {
        const to = ADDRESS.exec(text)?.[0] as Address | undefined;
        if (!to) return this.#say(chatId, "that is not an address. paste one like 0x… (42 characters).", kb([btn("Withdraw", "withdraw")], back()));
        const bal = await this.#d.chain.ethBalance(wallet.address);
        const spendable = bal > MIN_GAS_RESERVE ? bal - MIN_GAS_RESERVE : 0n;
        return this.#say(chatId, `to <code>${to}</code>. you have <code>${eth(bal)} ETH</code>; pick or type an amount.`, kb(
          [btn(`half (${eth(spendable / 2n)})`, `w:h:${to}`), btn(`all but gas (${eth(spendable)})`, `w:a:${to}`)],
          [btn("custom amount", `ask:wto:${to}`)],
          back(),
        ));
      }
      case "withdrawAmount": {
        if (!named) return this.#ask(chatId, "withdrawTo", PROMPT.withdrawTo());
        const amount = parseEth(text);
        if (!amount) return this.#say(chatId, "an amount like 0.01.", kb([btn("custom amount", `ask:wto:${named}`)], back()));
        return this.#withdraw(chatId, tgId, named, amount);
      }
      case "token": {
        const t = ADDRESS.exec(text)?.[0];
        if (!t) return this.#say(chatId, "that is not an address. paste the token's contract, 0x… (42 characters).", kb(back()));
        return this.#tokenCard(chatId, tgId, t as Address);
      }
      case "buyPresets": {
        const parts = text.split(/[\s,]+/).filter(Boolean);
        const parsed = parts.map(parseEth);
        if (parts.length !== 3 || parts.some((p) => p.length > PRESET_MAX_CHARS) || parsed.some((p) => p === null || p === 0n || p > MAX_BUY)) {
          return this.#say(chatId, `three amounts in ETH, each above zero and at most ${eth(MAX_BUY)}, at most ${PRESET_MAX_CHARS} characters each: like 0.001 0.005 0.01`, kb(back("settings")));
        }
        return this.#saveSettings(chatId, tgId, { ...wallet.settings, buyPresets: parts });
      }
      case "sellPresets": {
        const parts = text.split(/[\s,]+/).filter(Boolean).map((p) => Number(p.replace("%", "")));
        if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p) || p < 1 || p > 100)) {
          return this.#say(chatId, "three whole percentages, 1 to 100: like 25 50 100", kb(back("settings")));
        }
        return this.#saveSettings(chatId, tgId, { ...wallet.settings, sellPresets: parts });
      }
      case "buySlippage":
      case "sellSlippage": {
        const value = Number(text.replace("%", ""));
        if (!Number.isFinite(value) || value < 0.5 || value > 20) return this.#say(chatId, "a percentage between 0.5 and 20.", kb(back("settings")));
        const bps = Math.round(value * 100);
        return this.#saveSettings(chatId, tgId, key === "buySlippage" ? { ...wallet.settings, buySlippageBps: bps } : { ...wallet.settings, sellSlippageBps: bps });
      }
    }
  }

  // ---------- start and the home card ----------

  async #start(chatId: string, tgId: string, firstName?: string, startParam?: string): Promise<void> {
    let wallet = await this.#d.store.get(tgId);
    let fresh = false;
    if (!wallet) {
      const key = generatePrivateKey();
      // A referral link is t.me/<bot>?start=r-<code>; you cannot refer yourself, and the code has to exist.
      const code = startParam?.startsWith("r-") ? startParam.slice(2) : undefined;
      for (let attempt = 0; attempt < 3 && !wallet; attempt += 1) {
        const refCode = refCodeOf(tgId, this.#d.keySecret, attempt);
        let referredBy: string | null = null;
        if (code && code !== refCode && (await this.#d.store.byRefCode(code))) referredBy = code;
        const candidate = withDefaults({
          tgId, address: privateKeyToAccount(key).address, sealedKey: sealKey(key, this.#d.keySecret, walletAad(tgId)),
          createdAt: this.#now().toISOString(), refCode, referredBy,
        });
        try {
          // On a race the store hands back the first writer's row; only the writer's wallet is fresh and gets the faucet.
          wallet = await this.#d.store.create(candidate);
          fresh = wallet.sealedKey === candidate.sealedKey;
        } catch (error) {
          if (!(error instanceof RefCodeTaken)) throw error;
        }
      }
      if (!wallet) throw new Error("could not find a free referral code");
    }
    // A deep link from a partner's page or a group button: t.me/<bot>?start=t-<contract>, straight to that token's card.
    const linked = startParam?.startsWith("t-") ? startParam.slice(2) : undefined;
    if (fresh) {
      const topped = await this.#tryFaucet(wallet);
      await this.#say(chatId,
        `gm${firstName ? ` ${esc(firstName)}` : ""}. made you a wallet on <b>Robinhood Chain testnet</b>. test ETH, test tokens, nothing real, and we hold this key so you can try things in one tap. on mainnet, which is next and not live, the key will stay with you; that is the whole point of Chit.\n\n` +
        this.#faucetLine(topped) +
        (wallet.referredBy ? "\n\nyou came through a referral link; that is on your card." : ""));
    } else if (!linked) {
      await this.#say(chatId, `welcome back${firstName ? ` ${esc(firstName)}` : ""}.`);
    }
    if (linked && isAddress(linked)) return this.#tokenCard(chatId, tgId, linked);
    await this.#home(chatId, tgId);
  }

  #faucetLine(result: FaucetResult): string {
    switch (result) {
      case "sent": return `topped it up with <code>${eth(this.#faucetWei)} test ETH</code>.`;
      case "pending": return `the faucet sent <code>${eth(this.#faucetWei)} test ETH</code>; it is still landing, refresh the card in a minute.`;
      case "off": return "this deployment has no faucet; send test ETH to the address on the card.";
      case "wait": return "the faucet is once a day per wallet.";
      case "budget": return "the faucet has paid out its daily budget; again tomorrow.";
      case "busy": return "the faucet is busy; tap Faucet on the card in a moment.";
      case "dry": return "the faucet is dry right now; tap Faucet on the card in a while.";
      case "failed": return "the faucet's send did not land; tap Faucet on the card in a moment.";
    }
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
    lines.push(`<i>testnet playground: this key is ours, the ETH is test ETH. never do this with real money. on mainnet, next and not live, Chit will use session keys and never hold yours.</i>`);
    return lines.join("\n");
  }

  #homeKeyboard(): Keyboard {
    return kb(
      [btn("💰 Buy", "buy:"), btn("💸 Sell", "sell:")],
      [btn("📊 Positions", "positions"), btn("🆕 New", "new")],
      [btn("🚀 Fleet", "fleet"), btn("🔑 Sessions", "sessions")],
      [btn("🤝 Refer", "refer"), ...(this.#d.bridge ? [btn("🌉 Bridge", "bridge")] : [])],
      [btn("⚙️ Settings", "settings"), btn("🏦 Withdraw", "withdraw")],
      [...(this.#d.chain.hasFaucet ? [btn("🚰 Faucet", "faucet")] : []), btn("❓ Help", "help"), btn("↻ Refresh", "home")],
    );
  }

  async #home(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    await this.#out(chatId, messageId, await this.#card(wallet), this.#homeKeyboard(), "home");
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
    await this.#d.store.patch(wallet.tgId, { tokens: wallet.tokens });
  }

  async #holdings(wallet: BotWallet): Promise<Array<{ info: TokenInfo; balance: bigint }>> {
    const rows = await Promise.all(this.#tokensOf(wallet).map(async (token) => {
      const [info, balance] = await Promise.all([this.#d.chain.tokenInfo(token), this.#d.chain.tokenBalance(token, wallet.address)]);
      return { info, balance };
    }));
    return rows.filter((r) => r.balance > 0n);
  }

  /** A buy button: the token and the amount in wei, at most 62 bytes; a preset that will not fit goes through the reply field instead. */
  #buyButton(token: Address, preset: string) {
    const wei = parseEth(preset);
    return wei && wei > 0n && wei <= MAX_BUY ? btn(`Buy ${preset} ETH`, `b:${token}:${wei}`) : btn(`Buy ${preset} ETH`, `ask:buy:${token}`);
  }

  async #tokenCard(chatId: string, tgId: string, token: Address, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(token)) return this.#say(chatId, "that is not an address.", kb(back()));
    // Orus is asked alongside the chain reads and given the same patience; a card never waits on it alone.
    const [info, balance, ethBal, scan, hey] = await Promise.all([this.#d.chain.tokenInfo(token), this.#d.chain.tokenBalance(token, wallet.address), this.#d.chain.ethBalance(wallet.address), this.#d.orus?.scan(token), this.#d.hey?.scan(token)]);
    if (!info.hasPool) {
      return this.#out(chatId, messageId, `<b>${esc(info.symbol)}</b> <code>${token}</code>\nno ETH pool on the venue for this token, so nothing to buy it with here.`, kb(back()));
    }
    await this.#remember(wallet, token);
    const s = wallet.settings;
    const text = [
      `<b>${esc(info.symbol)}</b> · <code>${token}</code> <i>(tap to copy)</i>`,
      `price: <code>${fmt(info.perEth, info.decimals, 2)} ${esc(info.symbol)}</code> per ETH · pool: <code>${eth(info.poolEth, 4)} ETH</code>`,
      ...(scan && this.#d.orus ? [`orus: ${orusLine(scan, this.#d.orus.link(token))}`] : []),
      ...(hey ? [`hey research lab: ${heyLine(hey)}`] : []),
      `you hold: <code>${fmt(balance, info.decimals, 4)} ${esc(info.symbol)}</code> · wallet: <code>${eth(ethBal)} ETH</code>`,
      "",
      info.hooked
        ? `<i>hooked pool (a launchpad's): the hook's own fee is not in the quote, your guard is the limit. buys guarded at ${pct(s.buySlippageBps)}, sells at ${pct(s.sellSlippageBps)}${s.confirmTrades ? "; every trade asks first" : ""}. the reply carries the hash.</i>`
        : `<i>quotes from the pool with fee and impact; buys guarded at ${pct(s.buySlippageBps)}, sells at ${pct(s.sellSlippageBps)}${s.confirmTrades ? "; every trade asks first" : ""}. the reply carries the hash.</i>`,
    ].join("\n");
    // The buttons always carry the plain verb: confirm trades and sell protection are applied by the handler, never skipped by a button.
    await this.#out(chatId, messageId, text, kb(
      s.buyPresets.map((p) => this.#buyButton(token, p)),
      [btn("Buy custom", `ask:buy:${token}`)],
      s.sellPresets.map((p) => btn(`Sell ${p}%`, `s:${token}:${p}`)),
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
    await this.#out(chatId, messageId, `<b>buy</b>\npick a token, or paste any token's contract address.`, kb(...rows, [btn("paste a contract address", "token:")], back()), "buy");
  }

  #faucetOffer(): Keyboard[number] {
    return this.#d.chain.hasFaucet ? [btn("🚰 Faucet", "faucet")] : [];
  }

  async #buy(chatId: string, tgId: string, token: Address, amount: bigint | null, confirmed: boolean): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(token)) return this.#say(chatId, "that is not a token address.", kb(back()));
    if (!amount || amount === 0n) return this.#say(chatId, "an amount like 0.002.", kb([btn("Buy custom", `ask:buy:${token}`)], back()));
    if (amount > MAX_BUY) return this.#say(chatId, `keep it under ${eth(MAX_BUY)} ETH a trade on the playground.`, kb(back(`token:${token}`)));
    const s = wallet.settings;
    if (s.confirmTrades && !confirmed) {
      const info = await this.#d.chain.tokenInfo(token);
      return this.#say(chatId, `buy <code>${eth(amount)} ETH</code> of ${esc(info.symbol)}?`, kb([btn("✅ Confirm", `bc:${token}:${amount}`), btn("✖ Cancel", `token:${token}`)]));
    }
    await this.#locked(chatId, tgId, async () => {
      const [bal, quote, info] = await Promise.all([this.#d.chain.ethBalance(wallet.address), this.#d.chain.quoteBuy(token, amount), this.#d.chain.tokenInfo(token)]);
      if (bal < amount + MIN_GAS_RESERVE) return this.#say(chatId, `not enough: you have <code>${eth(bal)} ETH</code> and a trade needs the amount plus a little gas.`, kb(this.#faucetOffer(), back(`token:${token}`)));
      if (quote === null || quote === 0n) return this.#say(chatId, "no price in the pool right now.", kb(back(`token:${token}`)));
      const minOut = minOutFor(quote, s.buySlippageBps);
      await this.#say(chatId, `buying ${esc(info.symbol)} with <code>${eth(amount)} ETH</code>: about <code>${fmt(quote, info.decimals, 4)}</code>, at least <code>${fmt(minOut, info.decimals, 4)}</code> or it reverts…`);
      const before = await this.#d.chain.tokenBalance(token, wallet.address);
      const landed = await this.#d.chain.buy(this.#walletKey(wallet), token, amount, minOut);
      if (landed.pending) return this.#stillLanding(chatId, landed, token);
      if (!landed.ok) return this.#say(chatId, `the buy reverted (<code>${landed.hash}</code>): the price moved past your ${pct(s.buySlippageBps)} guard, or the pool is thin. nothing was spent but gas.`, kb([btn("try again", `token:${token}`)], back()));
      const got = (await this.#d.chain.tokenBalance(token, wallet.address)) - before;
      await this.#remember(wallet, token);
      await this.#d.store.recordTrade({ tgId, token, side: "buy", ethWei: amount.toString(), tokenUnits: got.toString(), txHash: landed.hash, at: this.#now().toISOString() });
      await this.#say(chatId, `✅ bought <code>${fmt(got, info.decimals, 4)} ${esc(info.symbol)}</code> for <code>${eth(amount)} ETH</code>\ntx <code>${landed.hash}</code>`, kb([btn(`${info.symbol} card`, `token:${token}`), btn("📊 Positions", "positions")], back()));
    });
  }

  /** A transaction that was sent but has no receipt within the wait: the hash is real, and a second send would be a second trade. */
  async #stillLanding(chatId: string, landed: Landed, token?: Address): Promise<void> {
    await this.#say(chatId, `sent, still landing after a while: <code>${landed.hash}</code>. do not tap again; check Positions in a minute.`, kb([btn("📊 Positions", "positions"), ...(token ? [btn("token card", `token:${token}`)] : [])], back()));
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
    await this.#locked(chatId, tgId, async () => {
      const [bal, quote] = await Promise.all([this.#d.chain.ethBalance(wallet.address), this.#d.chain.quoteSell(token, amount)]);
      if (bal < MIN_GAS_RESERVE) return this.#say(chatId, "not enough ETH for gas.", kb(this.#faucetOffer(), back(`token:${token}`)));
      if (quote === null || quote === 0n) return this.#say(chatId, "no price in the pool right now.", kb(back(`token:${token}`)));
      const minOut = minOutFor(quote, s.sellSlippageBps);
      await this.#say(chatId, `selling <code>${fmt(amount, info.decimals, 4)} ${esc(info.symbol)}</code> (${percent}%): about <code>${eth(quote)} ETH</code>, at least <code>${eth(minOut)}</code> or it reverts… (a first sale approves the router once)`);
      const ethBefore = await this.#d.chain.ethBalance(wallet.address);
      const landed = await this.#d.chain.sell(this.#walletKey(wallet), token, amount, minOut);
      if (landed.pending) return this.#stillLanding(chatId, landed, token);
      if (!landed.ok) return this.#say(chatId, `the sale reverted (<code>${landed.hash}</code>). nothing was sold.`, kb([btn("try again", `token:${token}`)], back()));
      const ethAfter = await this.#d.chain.ethBalance(wallet.address);
      // What the sale left in the wallet after gas: a touch under the fill, so a card's number never flatters.
      await this.#d.store.recordTrade({ tgId, token, side: "sell", ethWei: (ethAfter > ethBefore ? ethAfter - ethBefore : 0n).toString(), tokenUnits: amount.toString(), txHash: landed.hash, at: this.#now().toISOString() });
      await this.#say(chatId, `✅ sold <code>${fmt(amount, info.decimals, 4)} ${esc(info.symbol)}</code>; wallet <code>${eth(ethBefore)}</code> → <code>${eth(ethAfter)} ETH</code> after gas\ntx <code>${landed.hash}</code>`, kb([btn(`${info.symbol} card`, `token:${token}`), btn("📊 Positions", "positions")], back()));
    });
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
      rows.push([btn(`${h.info.symbol}`, `token:${h.info.address}`), btn("Sell 50%", `s:${h.info.address}:50`), btn("Sell 100%", `s:${h.info.address}:100`), ...(this.#d.share ? [btn("📸", `share:${h.info.address}`)] : [])]);
    }
    if (!held.length) lines.push("no tokens yet.");
    lines.push("", "<i>\"if sold now\" is the pool's fill for the whole position, fee and impact included.</i>" + (this.#d.share && held.length ? " <i>📸 draws a position as a picture, your referral link on it.</i>" : ""));
    await this.#out(chatId, messageId, lines.join("\n"), kb(...rows, [btn("💰 Buy", "buy:"), btn("↻ Refresh", "positions")], back()));
  }

  /**
   * A position as a picture: what it cost (the buys this bot made, less what
   * its sales returned), what it would fetch now, and the referral link. A
   * position the bot never bought has no cost to draw, so there is no card;
   * the numbers on a card are always the bot's own records.
   */
  async #share(chatId: string, tgId: string, token: Address): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const draw = this.#d.share;
    if (!draw) return this.#positions(chatId, tgId);
    if (!isAddress(token)) return this.#say(chatId, "that is not a token address.", kb(back("positions")));
    const [info, held, trades] = await Promise.all([this.#d.chain.tokenInfo(token), this.#d.chain.tokenBalance(token, wallet.address), this.#d.store.tradesOf(tgId, token)]);
    if (held === 0n) return this.#say(chatId, `you hold no ${esc(info.symbol)} right now; a card needs a position.`, kb(back("positions")));
    if (!trades.some((t) => t.side === "buy")) return this.#say(chatId, `no ${esc(info.symbol)} was bought through this bot, so there is no cost to put on a card. buy some here and the card is one tap.`, kb([btn(`buy ${info.symbol}`, `buy:${token}`)], back("positions")));
    const paid = trades.reduce((sum, t) => sum + (t.side === "buy" ? BigInt(t.ethWei) : -BigInt(t.ethWei)), 0n);
    const worth = (await this.#d.chain.quoteSell(token, held)) ?? 0n;
    const link = `t.me/${this.#d.botUsername}?start=r-${wallet.refCode}`;
    const png = await draw({
      symbol: info.symbol, costEth: Number(formatUnits(paid, 18)), valueEth: Number(formatUnits(worth, 18)), held: fmt(held, info.decimals, 2),
      chainLabel: "robinhood chain", testnet: this.#d.chain.chainId !== 4663, refLink: link,
    });
    const pnl = paid > 0n ? `${worth >= paid ? "+" : ""}${((Number(formatUnits(worth - paid, 18)) / Number(formatUnits(paid, 18))) * 100).toFixed(1)}%` : "free ride";
    await this.#d.telegram.deliver({
      kind: "photo", chatId, photo: png,
      text: `<b>$${esc(info.symbol)}</b> · ${esc(pnl)}\nin <code>${eth(paid > 0n ? paid : 0n)} ETH</code> · now <code>${eth(worth)} ETH</code> · read from the pool just now\nforward it anywhere; your link is on it: <code>${esc(link)}</code>`,
      keyboard: kb([btn("📊 Positions", "positions"), btn(`${info.symbol} card`, `token:${token}`)], back()),
    });
  }

  /**
   * The way in from another chain, and the way to CHIT from anywhere: the
   * routes Relay quotes at this moment, each a link into Relay's app with
   * the fields filled in. A route that does not quote is not shown.
   */
  async #bridge(chatId: string, messageId?: number): Promise<void> {
    const bridge = this.#d.bridge;
    if (!bridge) return this.#home(chatId, "", messageId);
    const routes = await bridge.routes();
    const live = routes.filter((r) => r.eth || r.chit);
    const lines = [
      `<b>bridge</b> · from another chain into Robinhood Chain, one transaction through Relay`,
      `bring ETH here, or land straight in <b>$CHIT</b>. the transaction is yours, from your own wallet, in Relay's app; this bot never touches it.`,
      "",
    ];
    for (const r of live) lines.push(`· <b>${esc(r.origin.name)}</b> (${esc(r.origin.native)}): ${r.eth ? "ETH ✓" : "ETH ✖"} · ${r.chit ? "CHIT ✓" : "CHIT ✖"}`);
    const missing = routes.filter((r) => !r.eth && !r.chit).map((r) => r.origin.name);
    if (missing.length) lines.push("", `<i>no route right now from ${esc(missing.join(", "))}; Relay opens them one by one and this card follows.</i>`);
    if (!live.length) lines.push("Relay quotes no route into Robinhood Chain at this moment; try again in a while.");
    lines.push("", `<i>mainnet, real money. this playground is testnet; the bridge is for the real thing. quotes checked just now.</i>`);
    const rows: Keyboard = live.map((r) => [
      ...(r.eth ? [{ text: `ETH from ${r.origin.name}`, url: r.ethUrl }] : []),
      ...(r.chit ? [{ text: `CHIT from ${r.origin.name}`, url: r.chitUrl }] : []),
    ]);
    await this.#out(chatId, messageId, lines.join("\n"), kb(...rows, [btn("↻ Refresh", "bridge"), btn("← Back", "home")]));
  }

  /** The venue's newest ETH pools: what just launched, and whether a tap here can buy it. */
  async #newPools(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const pools = await this.#d.chain.newPools(NEW_POOLS_BLOCKS);
    const shown = pools.slice(0, NEW_POOLS_SHOWN);
    const infos = await Promise.all(shown.map((p) => this.#d.chain.tokenInfo(p.token).catch((): TokenInfo => ({ address: p.token, symbol: "?", decimals: 18, hasPool: false, perEth: 0n, poolEth: 0n, hooked: false, fee: 0 }))));
    const head = pools[0]?.block ?? 0n;
    const lines = [`<b>new on the venue</b> · ${pools.length} ETH pool${pools.length === 1 ? "" : "s"} opened in about a day`];
    const rows: Keyboard = [];
    shown.forEach((p, i) => {
      const info = infos[i]!;
      const age = head > p.block ? `${Number(head - p.block)} blocks ago` : "just now";
      const hooked = p.hooks !== "0x0000000000000000000000000000000000000000";
      const line = info.hasPool
        ? `<b>${esc(info.symbol)}</b> · pool <code>${eth(info.poolEth, 4)} ETH</code> · ${age}${hooked ? " · hooked" : ""}`
        : `<b>${esc(info.symbol)}</b> · ${age} · <i>no liquidity yet</i>`;
      lines.push(line);
      if (info.hasPool) rows.push([btn(`${info.symbol} · buy`, `token:${p.token}`)]);
    });
    if (!pools.length) lines.push("nothing opened lately.");
    lines.push("", "<i>read from the pool manager's own events just now. \"hooked\": a launchpad's pool; the hook takes its own fee, your guard is the limit.</i>");
    await this.#out(chatId, messageId, lines.join("\n"), kb(...rows, [btn("↻ Refresh", "new"), btn("← Back", "home")]));
  }

  /** Half or all-but-gas of the balance, read now, to the address the button carries. */
  async #withdrawShare(chatId: string, tgId: string, share: string, to: Address): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(to)) return this.#say(chatId, "that is not an address.", kb(back()));
    const bal = await this.#d.chain.ethBalance(wallet.address);
    const spendable = bal > MIN_GAS_RESERVE ? bal - MIN_GAS_RESERVE : 0n;
    const amount = share === "h" ? spendable / 2n : share === "a" ? spendable : 0n;
    if (amount === 0n) return this.#say(chatId, `nothing to send: you have <code>${eth(bal)} ETH</code>.`, kb(back()));
    return this.#withdraw(chatId, tgId, to, amount);
  }

  async #withdraw(chatId: string, tgId: string, to: Address, amount: bigint): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    if (!isAddress(to)) return this.#say(chatId, "that is not an address.", kb(back()));
    if (amount <= 0n) return this.#say(chatId, "an amount like 0.01.", kb([btn("custom amount", `ask:wto:${to}`)], back()));
    const bal = await this.#d.chain.ethBalance(wallet.address);
    if (bal < amount + SEND_GAS_RESERVE) return this.#say(chatId, `you have <code>${eth(bal)} ETH</code>; leave a little for gas.`, kb(back()));
    await this.#locked(chatId, tgId, async () => {
      const landed = await this.#d.chain.send(this.#walletKey(wallet), to, amount);
      if (landed.pending) return this.#stillLanding(chatId, landed);
      await this.#say(chatId, landed.ok ? `✅ sent <code>${eth(amount)} ETH</code> to <code>${to}</code>\ntx <code>${landed.hash}</code>` : `the send reverted (<code>${landed.hash}</code>).`, kb(back()));
    });
  }

  /**
   * The faucet, guarded three ways before the key signs: the wallet's own
   * once-a-day stamp (claimed atomically, given back if nothing was sent),
   * the day's budget across everyone, and one send at a time across every
   * instance so the faucet key's nonce is never raced.
   */
  async #tryFaucet(wallet: BotWallet): Promise<FaucetResult> {
    if (!this.#d.chain.hasFaucet) return "off";
    const now = this.#now();
    const claim = await this.#d.store.claimFaucet(wallet.tgId, now, this.#faucetEveryMs);
    if (!claim.claimed) return "wait";
    const day = utcDay(now);
    const giveBack = async (): Promise<void> => {
      await this.#d.store.restoreFaucet(wallet.tgId, claim.previous);
      await this.#d.store.refundFaucetBudget(day, this.#faucetWei);
    };
    if (!(await this.#d.store.spendFaucetBudget(day, this.#faucetWei, this.#faucetDailyWei))) {
      await this.#d.store.restoreFaucet(wallet.tgId, claim.previous);
      return "budget";
    }
    if (!(await this.#d.store.lock("faucet", now, FAUCET_LOCK_TTL_MS))) { await giveBack(); return "busy"; }
    try {
      const available = await this.#d.chain.faucetBalance().catch(() => 0n);
      if (available < this.#faucetWei * 2n) { await giveBack(); return "dry"; }
      let landed: Landed;
      try {
        landed = await this.#d.chain.faucet(wallet.address, this.#faucetWei);
      } catch (error) {
        console.error("chit bot faucet:", error instanceof Error ? error.message.split("\n")[0] : String(error));
        await giveBack();
        return "busy";
      }
      if (landed.pending) return "pending";
      if (!landed.ok) { await giveBack(); return "failed"; }
      return "sent";
    } finally {
      await this.#d.store.unlock("faucet");
    }
  }

  async #faucet(chatId: string, tgId: string): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const result = await this.#tryFaucet(wallet);
    if (result === "wait") {
      const last = wallet.faucetAt ? Date.parse(wallet.faucetAt) : 0;
      const wait = Math.max(0, last + this.#faucetEveryMs - this.#now().getTime());
      return this.#say(chatId, `the faucet is once a day per wallet. again in about ${Math.max(1, Math.ceil(wait / 3_600_000))}h.`, kb(back()));
    }
    await this.#say(chatId, result === "sent" ? `sent <code>${eth(this.#faucetWei)} test ETH</code> to your wallet.` : this.#faucetLine(result), kb(back()));
  }

  // ---------- settings ----------

  async #saveSettings(chatId: string, tgId: string, settings: BotSettings, messageId?: number): Promise<void> {
    await this.#d.store.patch(tgId, { settings });
    return this.#settings(chatId, tgId, messageId);
  }

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
    const s = wallet.settings;
    switch (which) {
      case "buyPresets": return this.#ask(chatId, "buyPresets", PROMPT.buyPresets());
      case "sellPresets": return this.#ask(chatId, "sellPresets", PROMPT.sellPresets());
      case "buySlippage": return this.#ask(chatId, "buySlippage", PROMPT.buySlippage());
      case "sellSlippage": return this.#ask(chatId, "sellSlippage", PROMPT.sellSlippage());
      case "confirmTrades": return this.#saveSettings(chatId, tgId, { ...s, confirmTrades: !s.confirmTrades }, messageId);
      case "sellProtection": return this.#saveSettings(chatId, tgId, { ...s, sellProtection: !s.sellProtection }, messageId);
      case "reset": return this.#saveSettings(chatId, tgId, { ...DEFAULT_SETTINGS }, messageId);
      default: return this.#settings(chatId, tgId, messageId);
    }
  }

  // ---------- referral ----------

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
    ].filter(Boolean).join("\n"), kb(back()), "refer");
  }

  // ---------- the fleet: Chit's own product, from the chat ----------

  #driver(wallet: BotWallet): FleetDriver | undefined {
    if (!this.#d.fleetApi) return undefined;
    const account = privateKeyToAccount(this.#walletKey(wallet));
    return new FleetDriver(this.#d.fleetApi, wallet.address, (message) => account.signMessage({ message }), this.#now);
  }

  /** The claim, as FR-015 allows it and no further. */
  static readonly FLEET_INTRO = [
    `<b>fleet</b>: the thing Chit is for.`,
    `one deposit into a shared pool, a fleet of five wallets funded from it after a random wait, one buy through the router from every wallet. your main wallet never funds the fleet: the chain shows a deposit into Chit and fleets funded by Chit, with no transaction linking them. the operator can link them, and says so. private, not anonymous; while the pool is small, amounts and timing can be guessed at.`,
  ];

  #depositRow(): Keyboard[number] {
    return this.#d.chain.pool ? DEPOSIT_SIZES.map((size) => btn(`① deposit ${size}`, `fl:dep:${parseEther(size)}`)) : [];
  }

  async #fleet(chatId: string, tgId: string, messageId?: number): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const intro = ChitBot.FLEET_INTRO;
    if (!this.#d.fleetApi) {
      return this.#out(chatId, messageId, [...intro, "", `from this chat it is not wired yet. today it lives in the app: <a href="${esc(this.#site)}/app/balance.html">Balance</a> → <a href="${esc(this.#site)}/app/fleet.html">Set up</a> → <a href="${esc(this.#site)}/app/trade.html">Trade</a> → <a href="${esc(this.#site)}/app/fleet-dashboard.html">Control Room</a>.`].join("\n"), kb(back()), "fleet");
    }
    const record = this.#fleetOf(wallet);
    const phase = fleetPhase(record);
    const lines = [...intro, ""];
    const rows: Keyboard = [];
    if (record) {
      lines.push(`your fleet: <code>${esc(record.campaign)}</code> · <b>${esc(record.state || phase)}</b>` + (record.fleet.length ? ` · ${record.fleet.length} wallets` : "") + (record.draw ? ` · draw <code>${eth(BigInt(record.draw))} ETH</code>` : ""));
    }
    switch (phase) {
      case "none":
      case "closed":
        lines.push(record ? "closed; the unspent draw went back to your pool balance. start another when you like." : "step 1: put ETH in the pool from your wallet, a published size. step 2: create the fleet and activate it with a draw; after a random wait of up to fifteen minutes the pool funds the five wallets. step 3: buy.");
        if (!this.#d.chain.pool) lines.push("<i>this deployment has no pool address, so deposits are not offered here.</i>");
        rows.push(this.#depositRow(), [btn("② create a fleet of 5 and activate it", "fl:new")]);
        break;
      case "created":
        lines.push("created, not activated yet. activate it with a draw from your pool balance; the pool funds the five wallets after a random wait of up to fifteen minutes. an un-activated fleet holds no money, so starting over costs nothing.");
        rows.push([btn("③ activate with a draw", "fl:new")], [btn("start over", "fl:drop")]);
        break;
      case "activating":
        lines.push("activating: the draw is open and the wait is running. refresh in a few minutes.");
        rows.push([btn("↻ status", "fl:status")]);
        break;
      case "active":
        lines.push("funded. one buy from every wallet through the router, principal sent just in time. pause holds it; close returns the unspent draw to your balance.");
        rows.push(FLEET_BUY_CHOICES.map((size) => btn(`④ buy ${size} each`, `fl:buy:${parseEther(size)}`)), [btn("⏸ pause", "fl:pause"), btn("✖ close", "fl:close")], [btn("↻ status", "fl:status")]);
        break;
      case "paused":
        rows.push([btn("▶ resume", "fl:resume"), btn("✖ close", "fl:close")], [btn("↻ status", "fl:status")]);
        break;
      case "ended":
        lines.push(`${esc(record?.state ?? "ended")}: this fleet is done; close returns the unspent draw to your pool balance, then start another.`);
        rows.push([btn("✖ close", "fl:close"), btn("↻ status", "fl:status")]);
        break;
    }
    rows.push([btn("pool balance", "fl:bal"), btn("← Back", "home")]);
    await this.#out(chatId, messageId, lines.join("\n"), kb(...rows.filter((r) => r.length)), "fleet");
  }

  /** The draws that fit: at least what five wallets need for gas, at most the pool balance the service reports. */
  #drawsThatFit(available: bigint): bigint[] {
    return DRAW_CHOICES.map((d) => parseEther(d)).filter((d) => d >= minimumDraw(FLEET_SIZE) && d <= available);
  }

  async #fleetAction(chatId: string, tgId: string, verb: string, arg: string, scope: string): Promise<void> {
    const wallet = await this.#d.store.get(tgId);
    if (!wallet) return this.#start(chatId, tgId);
    const driver = this.#driver(wallet);
    if (!driver) return this.#fleet(chatId, tgId);
    try {
      switch (verb) {
        case "bal": {
          const b = await driver.balance();
          await this.#say(chatId, `<b>pool balance</b>\navailable <code>${eth(BigInt(String(b["available"] ?? "0")))} ETH</code> · in open fleets <code>${eth(BigInt(String(b["openDraws"] ?? "0")))}</code> · deposited <code>${eth(BigInt(String(b["deposited"] ?? "0")))}</code> · spent <code>${eth(BigInt(String(b["spent"] ?? "0")))}</code>`, kb(back("fleet")));
          return;
        }
        case "new": {
          // Which draw: only the ones the pool balance covers, read now.
          const b = await driver.balance();
          const available = BigInt(String(b["available"] ?? "0"));
          const draws = this.#drawsThatFit(available);
          if (!draws.length) {
            return this.#say(chatId, `your pool balance is <code>${eth(available)} ETH</code>; a fleet of five needs a draw of at least <code>${eth(minimumDraw(FLEET_SIZE))}</code>. deposit first.`, kb(this.#depositRow(), back("fleet")));
          }
          return this.#say(chatId, `pick the draw for the fleet of five: it is held for the fleet and the unspent part comes back on close. the wallets are funded after a random wait of up to fifteen minutes.`, kb(draws.map((d) => btn(`draw ${eth(d)} ETH`, `fl:go:${d}`)), back("fleet")));
        }
        case "status": {
          const record = this.#fleetOf(wallet);
          if (!record) return this.#fleet(chatId, tgId);
          const s = await driver.status(record.campaign);
          const next = { ...record, state: s.state || record.state, ...(s.draw ? { draw: s.draw.amount } : {}) };
          await this.#saveFleet(tgId, next);
          const draw = s.draw;
          const due = draw?.dueAt ? Date.parse(draw.dueAt) : NaN;
          await this.#say(chatId, `<b>${esc(next.state)}</b>` +
            (draw ? ` · draw <code>${eth(BigInt(draw.amount))} ETH</code>, spent <code>${eth(BigInt(draw.spent))}</code>, remaining <code>${eth(BigInt(draw.remaining))}</code>` : "") +
            (draw?.state === "Pending" && Number.isFinite(due) ? `\nfunds after ${new Date(due).toISOString().slice(11, 16)} UTC` : "") +
            (next.fleet.length ? `\nwallets: ${next.fleet.map((a) => `<code>${short(a)}</code>`).join(" ")}` : ""));
          return this.#fleet(chatId, tgId);
        }
        case "drop": {
          const record = this.#fleetOf(wallet);
          if (record && fleetPhase(record) !== "created" && fleetPhase(record) !== "closed") return this.#say(chatId, "that fleet has a draw open; close it instead.", kb(back("fleet")));
          await this.#saveFleet(tgId, null);
          await this.#say(chatId, "forgotten. an un-activated fleet holds no money.");
          return this.#fleet(chatId, tgId);
        }
      }
      await this.#locked(chatId, tgId, async () => {
        switch (verb) {
          case "dep": {
            const wei = parseWei(arg);
            if (!wei || !DEPOSIT_SIZES.some((s) => parseEther(s) === wei)) return this.#say(chatId, `a published size: ${DEPOSIT_SIZES.join(", ")} or 0.1.`, kb(back("fleet")));
            if (!this.#d.chain.pool) return this.#say(chatId, "this deployment has no pool address.", kb(back("fleet")));
            const bal = await this.#d.chain.ethBalance(wallet.address);
            if (bal < wei + MIN_GAS_RESERVE) return this.#say(chatId, `not enough: you have <code>${eth(bal)} ETH</code>.`, kb(this.#faucetOffer(), back("fleet")));
            const landed = await this.#d.chain.deposit(this.#walletKey(wallet), wei);
            if (landed.pending) return this.#stillLanding(chatId, landed);
            if (!landed.ok) return this.#say(chatId, `the deposit reverted (<code>${landed.hash}</code>): the pool takes ${DEPOSIT_SIZES.join(", ")} or 0.1 and refuses above its caps.`, kb(back("fleet")));
            await this.#say(chatId, `✅ deposited <code>${eth(wei)} ETH</code> into the pool. it carries no fleet marker.\ntx <code>${landed.hash}</code>`);
            return this.#fleet(chatId, tgId);
          }
          case "go": {
            const draw = parseWei(arg);
            if (!draw || draw < minimumDraw(FLEET_SIZE)) return this.#fleet(chatId, tgId);
            // Re-read under the lock: a fleet with a draw open is never overwritten.
            const current = await this.#d.store.get(tgId);
            let record = current ? this.#fleetOf(current) : undefined;
            const phase = fleetPhase(record);
            if (record && phase !== "created" && phase !== "closed") {
              return this.#say(chatId, `you already have a fleet <code>${esc(record.campaign)}</code> (<b>${esc(record.state)}</b>); close it first.`, kb(back("fleet")));
            }
            if (!record || phase === "closed") {
              const accounts = FleetDriver.generateAccounts(FLEET_SIZE, (key) => sealKey(key, this.#d.keySecret, fleetKeyAad(tgId)));
              await this.#say(chatId, "creating a fleet of five: fresh keys, sealed here; the service sees addresses and salts, never keys…");
              record = await driver.createFleet({
                accounts, chainId: this.#d.chain.chainId, router: this.#d.chain.router, fn: "execute(bytes,bytes[],uint256)",
                maxTradeValue: parseEther("0.001"), perAccountGas: parseEther("0.0002"), days: 7,
              }, scope);
              await this.#saveFleet(tgId, record);
              await this.#say(chatId, `✅ fleet <code>${esc(record.campaign)}</code> created: <b>${esc(record.state)}</b>. its keys are sealed here and the service holds their commitment.`);
            }
            try {
              const r = await driver.activate(record.campaign, draw, scope);
              record = { ...record, state: r.state || "Activating", fleet: r.accounts.length ? r.accounts : record.fleet, draw: draw.toString() };
              await this.#saveFleet(tgId, record);
              await this.#say(chatId, `✅ activated with a draw of <code>${eth(draw)} ETH</code>: <b>${esc(record.state)}</b>. the pool funds the wallets after a random wait; the funding transaction does not name your deposit.`);
            } catch (error) {
              if (!(error instanceof FleetError)) throw error;
              await this.#say(chatId, `created, but activating failed: the service said <code>${esc(error.code)}</code> (${error.status}).` +
                (error.code === "insufficient_balance" ? " deposit more, or pick a smaller draw." : "") +
                (error.code === "state_invalid" || error.status === 404 ? " the service may have forgotten an un-activated fleet; starting over costs nothing." : ""), kb(back("fleet")));
            }
            return this.#fleet(chatId, tgId);
          }
          case "buy": {
            const value = parseWei(arg);
            const record = this.#fleetOf(wallet);
            if (!value || !record) return this.#fleet(chatId, tgId);
            if (!record.fleet.length) return this.#say(chatId, "the fleet's wallets are not known yet; refresh the status first.", kb([btn("↻ status", "fl:status")], back("fleet")));
            const r = await driver.buy(record.campaign, record.fleet, this.#d.chain.defaultToken, value, scope);
            const results = (r["results"] as Array<{ account: Address; status: string; txHash?: string; reason?: string }> | undefined) ?? [];
            const ok = results.filter((x) => x.status === "sponsored").length;
            await this.#say(chatId, `bought from <b>${ok}</b> of ${results.length} wallets, <code>${eth(value)} ETH</code> each, through the router.\n` + results.map((x) => `${x.status === "sponsored" ? "✅" : "✖"} <code>${short(x.account)}</code>${x.txHash ? ` <code>${short(x.txHash)}</code>` : ""}${x.reason ? ` ${esc(x.reason)}` : ""}`).join("\n"));
            return this.#fleet(chatId, tgId);
          }
          case "pause": case "resume": case "close": {
            const record = this.#fleetOf(wallet);
            if (!record) return this.#fleet(chatId, tgId);
            const r = await driver.control(verb, record.campaign, scope);
            const next = { ...record, state: String(r["state"] ?? verb) };
            await this.#saveFleet(tgId, next);
            await this.#say(chatId, `✅ ${verb}: <b>${esc(next.state)}</b>` + (verb === "close" ? ". the unspent draw is back in your pool balance." : ""));
            return this.#fleet(chatId, tgId);
          }
          default:
            return this.#fleet(chatId, tgId);
        }
      });
    } catch (error) {
      if (error instanceof FleetError) {
        return this.#say(chatId, `the service said <code>${esc(error.code)}</code> (${error.status}).` + (error.status === 503 ? " it is not wired to the pool yet, or the chain is slow; try again in a minute." : ""), kb(back("fleet")));
      }
      throw error;
    }
  }

  async #sessions(chatId: string, messageId?: number): Promise<void> {
    await this.#out(chatId, messageId, [
      `<b>session keys</b>: how this bot will work on mainnet.`,
      `Trojan gives you speed by taking your key. Chit gives you speed without it: you keep your wallet, grant the bot a session once (which router, how much per trade, how much in all, until when), and the bot signs only inside that. pull the key from your wallet in one transaction.`,
      ``,
      `the contract and its page are written and tested against the live router on testnet, on their way into the app. the buttons here become sessions there. not live yet, and we say so.`,
    ].join("\n"), kb(back()));
  }

  async #pool(chatId: string): Promise<void> {
    const p = await this.#d.chain.poolNumbers();
    if (!p) return this.#say(chatId, "the pool is not configured on this bot yet.");
    await this.#say(chatId, `<b>the pool</b> · <code>${short(p.address)}</code>\nholds <code>${eth(p.heldWei)} ETH</code> · <code>${eth(p.totalDeposited)} ETH</code> ever deposited · ${p.campaigns} draw${p.campaigns === 1n ? "" : "s"} opened${p.paused ? " · <b>paused</b>" : ""}\n<i>read from the chain just now. testnet.</i>`);
  }

  async #help(chatId: string, messageId?: number): Promise<void> {
    await this.#out(chatId, messageId, [
      `<b>Chit Bot</b>, Robinhood Chain testnet`,
      `• Start makes you a testnet wallet${this.#d.chain.hasFaucet ? " and tops it up" : ""}.`,
      `• Buy and Sell go through the real Uniswap v4 router, quoted from the pool with fee and impact, guarded by your slippage. every reply has the transaction hash.`,
      `• paste any token's contract address to get its card with buy and sell buttons.`,
      `• Positions shows what you hold and what it would fetch now.`,
      `• Withdraw moves test ETH to an address you paste.${this.#d.chain.hasFaucet ? " Faucet tops you up once a day." : ""}`,
      `• Settings: your amounts, shares, slippage, a confirmation step, sell protection.`,
      `• Fleet runs Chit's own product from here; Sessions explains the mainnet plan.`,
      ``,
      `<i>everything here is testnet and test tokens. the bot holds this playground key; on mainnet, next and not live, it will never hold yours.</i>`,
    ].join("\n"), kb(back()));
  }
}

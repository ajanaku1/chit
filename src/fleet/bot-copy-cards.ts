/**
 * The copy desk's cards in the mainnet bot: the leaders list, a leader's
 * card with the follow prompt, "my follows" with the unfollow buttons, and
 * the two taps that open or close a leader. Everything a user reads about
 * following is here, so the session bot itself only routes the taps and
 * calls `afterBuy` once a leader's buy has landed.
 *
 * What every card says, because it is the whole promise: a mirrored buy is
 * sized to the smaller of the leader's amount and the follower's cap, runs
 * on the follower's own session account inside the caps the follower
 * granted (the contract refuses past them, with no gas spent), passes
 * orus's read first (a honeypot or no read at all is skipped), spends the
 * follower's own daily allowance from the bot like a tap of theirs would,
 * unfollow is one tap here and revoke is one transaction on the Sessions
 * page. And what is not mirrored, said just as plainly: only a buy the
 * leader taps in this bot is; their limit buys and DCA fire from the
 * orders' cron without the desk (bot-orders.ts) and are neither posted nor
 * mirrored, and their sells are never mirrored, so the exit from a
 * mirrored position is the follower's own. The leader hears the same when
 * they open, so nobody is promised a feed of buys the desk never sees. A
 * leader may lead from their own wallet instead: "⭐ Become a leader" asks
 * which, and the wallet choice mints a nonce and sends the Sessions page
 * with `?lead=`, where the wallet signs one message (bot-copy.ts,
 * claimLeadWallet, through api/bot/lead.js); such a leader's card shows the
 * wallet, the list marks them "trades from their own wallet", and the words
 * about what is mirrored change with the kind: every ETH buy that wallet
 * makes on the venue, read from the chain by the watcher, sells never.
 *
 * After a leader's landed buy the order is: mirrors first, in their fixed
 * order, then the feed's one message, then one line to the leader. The feed
 * after the mirrors, because a message before them is a list of buys about
 * to land for anyone in the group to run ahead of. Whatever fails in there
 * fails after the leader's own buy landed, so it is caught here and logged;
 * the leader is told; the request never fails over it.
 *
 * Callbacks owned here (all under Telegram's 64 bytes):
 *   leaders            the open leaders, a follow button each
 *   fl:<tgId>          one leader's card, "set a cap and follow"
 *   askf:<tgId>        the reply prompt for the cap in ETH per mirrored buy
 *   follows            who I follow, an unfollow button each
 *   unf:<tgId>         unfollow
 *   lead:on, lead:off  become a leader (asks from where: the account or
 *                      the wallet) and close it again
 *   lead:acct          from the session account (the Telegram @username is
 *                      the handle; a first name that passes as a plain name
 *                      is next; asked once when there is neither)
 *   lead:wallet        from their own wallet: the nonce and the Sessions
 *                      page's lead link
 */

import { type Address, type Hex, isAddress } from "viem";
import type { TokenInfo } from "./bot-chain.js";
import { type CopyDesk, HANDLE_MAX, MAX_FOLLOW_CAP_WEI, plainHandleOk } from "./bot-copy.js";
import type { HeyScanner } from "./bot-hey.js";
import type { OrusScanner } from "./bot-orus.js";
import { esc, type Keyboard, type Telegram } from "./bot-telegram.js";

export type CopyCardsDeps = {
  copy: CopyDesk;
  telegram: Telegram;
  siteUrl: string;
  orus?: OrusScanner;
  hey?: HeyScanner;
  /** The session bot's charge to a follower's daily allowance (bot-session.ts): the refusal, or null once one execute is counted. */
  budget?: (followerTgId: string) => string | null;
};

/** Who tapped: what Telegram sent about them, enough for a handle. */
export type Tapper = { username?: string; first_name?: string };

const VERBS = new Set(["leaders", "fl", "askf", "follows", "unf", "lead"]);

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: bigint): string => {
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
  return `${w}${f ? "." + f : ""}`;
};
const toWei = (s: string): bigint | null => {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) return null;
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
};
const btn = (text: string, data: string) => ({ text, callback_data: data });
const url = (text: string, href: string) => ({ text, url: href });

/**
 * The handle followers see: the @username when there is one (Telegram's
 * own, unique, never typed here), else the first name when it passes as a
 * plain name (a first name is any text, so one that starts with @ or reads
 * as the project is not taken), else nothing, and the bot asks.
 */
export const handleOf = (t: Tapper): string | undefined => {
  if (t.username && /^[A-Za-z0-9_]{1,32}$/.test(t.username)) return `@${t.username}`;
  const name = t.first_name?.trim().slice(0, HANDLE_MAX) ?? "";
  return plainHandleOk(name) ? name : undefined;
};

const GUARDS = "every mirrored buy passes orus's read first (a honeypot, or no read at all, is skipped and you are told), then your own session's caps (the contract refuses past them, no gas spent), and spends your own daily allowance of buys from the bot like a tap of yours would.";
/** What is mirrored, by the kind of leader: the words must match what the desk does for each. */
const SCOPE = {
  account: "only a buy they tap in this bot is mirrored: their limit buys and dca fire from the clock and are not, and their sells are never mirrored, so getting out of a mirrored position is yours alone, from the token card or the Sessions page.",
  wallet: "they trade from their own wallet: every ETH buy that wallet makes on the venue is mirrored, read from the chain within a few minutes of landing, and their sells are never mirrored, so getting out of a mirrored position is yours alone, from the token card or the Sessions page.",
};
const EXIT = "unfollow is one tap here; revoke the session in one transaction on the Sessions page and nothing can run.";
const gateFor = (kind: "account" | "wallet"): string => [GUARDS, SCOPE[kind], EXIT].join(" ");
const GATE = gateFor("account");
/** The one line under a leader's name that says where their buys come from. */
const WALLET_MARK = "trades from their own wallet";

type Pending = { kind: "cap"; leaderTgId: string } | { kind: "handle" };

export class CopyCards {
  readonly #d: CopyCardsDeps;
  readonly #pending = new Map<string, Pending>();

  constructor(d: CopyCardsDeps) { this.#d = d; }

  /** Whether a callback verb is one of these cards'. */
  owns(verb: string): boolean { return VERBS.has(verb); }

  #say(chatId: string, text: string, keyboard?: Keyboard, ask?: string): Promise<void> {
    return this.#d.telegram.deliver({ kind: "send", chatId, text, ...(keyboard ? { keyboard } : {}), ...(ask ? { ask } : {}) });
  }

  /** The rows the linked home card adds: the list, my follows, and the leader switch as it stands for this user. */
  async homeRows(tgId: string): Promise<Keyboard> {
    const me = await this.#d.copy.leader(tgId);
    return [
      [btn("📣 Leaders", "leaders"), btn("👥 My follows", "follows")],
      [me ? btn("close leader", "lead:off") : btn("⭐ Become a leader", "lead:on")],
    ];
  }

  /** /start f-<leaderAccount>: the feed's "follow" door lands on that leader's card. The door names the account, never the Telegram id. */
  start(chatId: string, tgId: string, param: string): Promise<void> | undefined {
    if (!param.startsWith("f-")) return undefined;
    return this.#fromFeed(chatId, tgId, param.slice(2));
  }

  async #fromFeed(chatId: string, tgId: string, account: string): Promise<void> {
    const l = isAddress(account) ? await this.#d.copy.leaderAt(account as Address) : undefined;
    if (!l) return this.#notOpen(chatId);
    return this.#leaderCard(chatId, tgId, l.tgId);
  }

  #notOpen(chatId: string): Promise<void> {
    return this.#say(chatId, "that leader is not open to followers right now. the list has the ones who are.", [[btn("📣 Leaders", "leaders"), btn("← Back", "home")]]);
  }

  async callback(chatId: string, tgId: string, verb: string, arg: string | undefined, from: Tapper): Promise<void> {
    switch (verb) {
      case "leaders": return this.#leaders(chatId, tgId);
      case "fl": return arg ? this.#leaderCard(chatId, tgId, arg) : this.#leaders(chatId, tgId);
      case "askf": return arg ? this.#askCap(chatId, tgId, arg) : this.#leaders(chatId, tgId);
      case "follows": return this.#follows(chatId, tgId);
      case "unf": return arg ? this.#unfollow(chatId, tgId, arg) : this.#follows(chatId, tgId);
      case "lead":
        if (arg === "off") return this.#closeLeader(chatId, tgId);
        if (arg === "acct") return this.#becomeLeader(chatId, tgId, from);
        if (arg === "wallet") return this.#leadFromWallet(chatId, tgId, from);
        return this.#whichLeader(chatId);
    }
  }

  /** A reply to one of these cards' prompts (the cap, the handle). True when it was consumed. */
  async reply(chatId: string, tgId: string, text: string, isReply: boolean): Promise<boolean> {
    const p = this.#pending.get(tgId);
    if (!p || !isReply) return false;
    this.#pending.delete(tgId);
    if (p.kind === "cap") await this.#follow(chatId, tgId, p.leaderTgId, text);
    else await this.#typedHandle(chatId, tgId, text.trim());
    return true;
  }

  /**
   * The leader's own buy landed: the mirrors in their fixed order, then the
   * feed, then one line to the leader saying how many followed. The partners
   * are asked again here (their scanners keep an answer a minute, so the
   * card's read is reused, not repeated). Nothing in here may throw out: the
   * leader's buy is already on chain, and a failure that reached Telegram
   * as a 5xx would have the same tap delivered again. `until` is the epoch
   * ms by which the mirrors, receipts included, must be through so the feed
   * and the leader's line still fit in the request (bot-session.ts).
   */
  async afterBuy(chatId: string, tgId: string, token: Address, ethWei: bigint, hash: Hex, info: TokenInfo, until?: number): Promise<void> {
    try {
      if (!(await this.#d.copy.leader(tgId))) return;
      const mirrors = await this.#d.copy.mirror(tgId, token, ethWei, { ...(this.#d.budget ? { budget: this.#d.budget } : {}), ...(until !== undefined ? { until } : {}) });
      const [scan, hey] = await Promise.all([this.#d.orus?.scan(token), this.#d.hey?.scan(token)]);
      await this.#d.copy.announce(tgId, token, ethWei, hash, info, scan, hey, mirrors);
      if (!mirrors.length) return;
      const skipped = mirrors.filter((m) => m.outcome === "skipped").length;
      const went = mirrors.length - skipped;
      await this.#say(chatId, `mirrored to ${went} of ${mirrors.length} follower${mirrors.length === 1 ? "" : "s"}${skipped ? `, ${skipped} skipped (each was told why)` : ""}.`);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown";
      console.error("copy afterBuy:", tgId, detail);
      await this.#say(chatId, "your buy landed. the feed or a mirror broke on our side after it; every follower who was reached was told, the rest were not mirrored this time.").catch(() => undefined);
    }
  }

  // ---------- cards ----------

  async #leaders(chatId: string, tgId: string): Promise<void> {
    const leaders = await this.#d.copy.leaders();
    const counts = await Promise.all(leaders.map((l) => this.#d.copy.followersOf(l.tgId)));
    const lines = [
      "<b>leaders</b>",
      `people who opened their buys to followers. follow one with a cap per mirrored buy: when a buy they tap in this bot lands, the same token is bought on your own session account, sized to the smaller of their amount and your cap. one marked "${WALLET_MARK}" is copied from the chain instead: every ETH buy that wallet makes on the venue.`,
      GATE,
      "",
      ...(leaders.length ? leaders.map((l, i) => `<b>${esc(l.handle)}</b> · <code>${short(l.account)}</code>${l.kind === "wallet" ? ` · ${WALLET_MARK}` : ""} · ${counts[i]!.length} follower${counts[i]!.length === 1 ? "" : "s"}`) : ["no open leaders yet. be the first: ⭐ Become a leader on your card."]),
    ];
    const rows: Keyboard = leaders.filter((l) => l.tgId !== tgId).map((l) => [btn(`follow ${l.handle}`, `fl:${l.tgId}`)]);
    await this.#say(chatId, lines.join("\n"), [...rows, [btn("👥 My follows", "follows"), btn("← Back", "home")]]);
  }

  async #leaderCard(chatId: string, tgId: string, leaderTgId: string): Promise<void> {
    const l = await this.#d.copy.leader(leaderTgId);
    if (!l) return this.#notOpen(chatId);
    if (l.tgId === tgId) return this.#say(chatId, "that is you. your followers see this card; you cannot follow yourself.", [[btn("📣 Leaders", "leaders"), btn("← Back", "home")]]);
    const followers = await this.#d.copy.followersOf(leaderTgId);
    const mine = (await this.#d.copy.followsOf(tgId)).find((f) => f.leaderTgId === leaderTgId);
    const lines = [
      `<b>follow ${esc(l.handle)}</b>`,
      `${l.kind === "wallet" ? `wallet <code>${l.account}</code> · ${WALLET_MARK}` : `account <code>${l.account}</code>`} · ${followers.length} follower${followers.length === 1 ? "" : "s"} · leading since ${l.since.slice(0, 10)}`,
      "",
      l.kind === "wallet"
        ? "when that wallet buys a token with ETH on the venue, the same token is bought on your session account within a few minutes, sized to the smaller of their amount and your cap."
        : "when a buy they tap in this bot lands, the same token is bought on your session account, sized to the smaller of their amount and your cap.",
      gateFor(l.kind),
      ...(mine ? ["", `you follow them at <code>${eth(mine.capWei)} ETH</code> a buy; a new cap replaces it.`] : []),
    ];
    await this.#say(chatId, lines.join("\n"), [[btn(mine ? "change my cap" : "set a cap and follow", `askf:${leaderTgId}`)], ...(mine ? [[btn(`unfollow ${l.handle}`, `unf:${leaderTgId}`)]] : []), [btn("📣 Leaders", "leaders"), btn("← Back", "home")]]);
  }

  async #askCap(chatId: string, tgId: string, leaderTgId: string): Promise<void> {
    const l = await this.#d.copy.leader(leaderTgId);
    if (!l) return this.#say(chatId, "that leader is not open to followers right now.", [[btn("📣 Leaders", "leaders")]]);
    this.#pending.set(tgId, { kind: "cap", leaderTgId });
    await this.#say(chatId, `how much ETH at most per buy mirrored from <b>${esc(l.handle)}</b>? reply with a number, like 0.01 (up to ${eth(MAX_FOLLOW_CAP_WEI)}). your session's own per-trade cap still applies on top.`, undefined, "ETH per mirrored buy");
  }

  async #follow(chatId: string, tgId: string, leaderTgId: string, amount: string): Promise<void> {
    const wei = toWei(amount.trim());
    if (wei === null || wei <= 0n) return this.#say(chatId, "the cap must be a number of ETH, like 0.01. tap follow again to retry.", [[btn("← Leader", `fl:${leaderTgId}`)]]);
    try {
      const f = await this.#d.copy.follow(tgId, leaderTgId, wei);
      const l = await this.#d.copy.leader(leaderTgId);
      await this.#say(chatId, [
        `following <b>${esc(l?.handle ?? leaderTgId)}</b> at <code>${eth(f.capWei)} ETH</code> a buy.`,
        l?.kind === "wallet"
          ? "their next ETH buy from their wallet on the venue is mirrored on your account within a few minutes, inside your session's caps and behind orus's read; their sells are not, so the exit is yours. unfollow is one tap, revoke is one tx."
          : "their next tapped buy that lands through this bot is mirrored on your account, inside your session's caps and behind orus's read; their orders and their sells are not, so the exit is yours. unfollow is one tap, revoke is one tx.",
      ].join("\n"), [[btn("👥 My follows", "follows"), btn("← Back", "home")]]);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const fix = /link/.test(why) ? " connect your wallet from your card first." : /leader/.test(why) ? " the list has the ones who are." : " tap follow again and reply with a smaller one.";
      await this.#say(chatId, `not followed: ${esc(why)}.${fix}`, [[btn("📣 Leaders", "leaders"), btn("← Back", "home")]]);
    }
  }

  async #follows(chatId: string, tgId: string): Promise<void> {
    const follows = await this.#d.copy.followsOf(tgId);
    const leaders = await Promise.all(follows.map((f) => this.#d.copy.leader(f.leaderTgId)));
    const name = (i: number) => leaders[i]?.handle ?? follows[i]!.leaderTgId;
    const lines = [
      "<b>my follows</b>",
      ...(follows.length
        ? follows.map((f, i) => `<b>${esc(name(i))}</b> · <code>${eth(f.capWei)} ETH</code> a buy${leaders[i] ? "" : " · closed, nothing is mirrored"}`)
        : ["you follow nobody yet. the leaders list is a tap away."]),
      "",
      "unfollow is one tap here; to shut every mirrored buy out at once, pause or revoke the session on the Sessions page.",
    ];
    const rows: Keyboard = follows.map((f, i) => [btn(`unfollow ${name(i)}`, `unf:${f.leaderTgId}`)]);
    await this.#say(chatId, lines.join("\n"), [...rows, [btn("📣 Leaders", "leaders"), url("🔑 Sessions page", `${this.#d.siteUrl}/app/sessions.html`)], [btn("← Back", "home")]]);
  }

  async #unfollow(chatId: string, tgId: string, leaderTgId: string): Promise<void> {
    const l = await this.#d.copy.leader(leaderTgId);
    await this.#d.copy.unfollow(tgId, leaderTgId);
    await this.#say(chatId, `unfollowed <b>${esc(l?.handle ?? leaderTgId)}</b>. nothing more is mirrored from them.`, [[btn("👥 My follows", "follows"), btn("← Back", "home")]]);
  }

  /** ⭐ Become a leader: from where do the buys come? The account the bot trades, or the wallet they already trade from. */
  #whichLeader(chatId: string): Promise<void> {
    return this.#say(chatId, [
      "<b>become a leader</b>",
      "where do you trade from?",
      "",
      "<b>my session account</b>: every buy you tap in this bot that lands is posted to the feed and mirrored into your followers' accounts.",
      "<b>my own wallet</b>: you sign one message on the Sessions page with the wallet you trade from (no account, no session, no key handed over), and every ETH buy that wallet makes on the venue is read from the chain within a few minutes, posted and mirrored the same way.",
      "either way your sells and your standing orders are never mirrored, and close leader stops it any time.",
    ].join("\n"), [[btn("from my session account", "lead:acct"), btn("from my own wallet", "lead:wallet")], [btn("← Back", "home")]]);
  }

  /**
   * The wallet choice: a nonce of this user's (the link store's, fifteen
   * minutes) and the Sessions page with `?lead=`; the name Telegram gave
   * us goes along as a hint the page fills in, without the @ (a page cannot
   * prove a username, so a wallet leader's name is a plain one).
   */
  async #leadFromWallet(chatId: string, tgId: string, from: Tapper): Promise<void> {
    const nonce = await this.#d.copy.leadNonce(tgId);
    const hint = handleOf(from)?.replace(/^@/, "");
    const href = `${this.#d.siteUrl}/app/sessions.html?lead=${nonce}${hint ? `&handle=${encodeURIComponent(hint)}` : ""}`;
    await this.#say(chatId, [
      "<b>lead from your own wallet</b>",
      "",
      "1. open the Sessions page from the button below (the only link this bot ever sends is chit.tools).",
      "2. connect the wallet you trade from, check your name, and press <b>Lead from this wallet</b>: one signature, no transaction, nothing moves. the link is good for 15 minutes.",
      "",
      "from then on every ETH buy that wallet makes on the venue is read from the chain within a few minutes, posted to the feed with the hash and mirrored into your followers' accounts, each inside their own caps and behind orus's read. your sells are never mirrored, and the wallet's own trades are never touched. close leader on your card stops the feed and the mirrors, any time.",
    ].join("\n"), [[url("🔑 Open the Sessions page", href)], [btn("↻ I signed it", "home")]]);
  }

  async #becomeLeader(chatId: string, tgId: string, from: Tapper): Promise<void> {
    const handle = handleOf(from);
    if (!handle) {
      this.#pending.set(tgId, { kind: "handle" });
      return this.#say(chatId, "what should followers call you? reply with a name (letters and numbers, up to 32).", undefined, "your name on the leaders list");
    }
    return this.#open(chatId, tgId, handle);
  }

  /** A name typed in reply is a plain one: never an @ (that is Telegram's, and only Telegram hands it in), never the project's. */
  async #typedHandle(chatId: string, tgId: string, name: string): Promise<void> {
    if (!name) return this.#say(chatId, "a leader needs a name. tap ⭐ Become a leader again and reply with one.", [[btn("← Back", "home")]]);
    if (!plainHandleOk(name)) return this.#say(chatId, `that name will not do: letters, digits, spaces, _ . - and up to ${HANDLE_MAX}, no @, not the project's name. tap ⭐ Become a leader again and reply with another.`, [[btn("← Back", "home")]]);
    return this.#open(chatId, tgId, name);
  }

  async #open(chatId: string, tgId: string, handle: string): Promise<void> {
    try {
      const l = await this.#d.copy.becomeLeader(tgId, handle);
      await this.#say(chatId, [
        `you are a leader as <b>${esc(l.handle)}</b>.`,
        `your account <code>${l.account}</code> is public on the leaders list and on the feed's follow button now (your telegram id never is), and every buy you tap here that lands is posted to the feed and mirrored into your followers' accounts, each inside their own caps and behind orus's read.`,
        "a limit buy or a dca of yours that fires from the clock, and a sell, is yours alone: not posted, not mirrored. close leader on your card stops the feed and the mirrors, any time.",
      ].join("\n"), [[btn("📣 Leaders", "leaders"), btn("← Back", "home")]]);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (/name/.test(why)) return this.#say(chatId, `not a leader yet: ${esc(why)}. tap ⭐ Become a leader again and reply with another.`, [[btn("← Back", "home")]]);
      await this.#say(chatId, `not a leader yet: ${esc(why)}. connect your wallet from your card, then tap again.`, [[btn("🔗 Connect your wallet", "connect"), btn("← Back", "home")]]);
    }
  }

  async #closeLeader(chatId: string, tgId: string): Promise<void> {
    await this.#d.copy.closeLeader(tgId);
    await this.#say(chatId, "leader closed. nothing more of yours is posted or mirrored; your followers keep their follows in case you open again.", [[btn("← Back", "home")]]);
  }
}

/**
 * Copy trading without custody. A leader is a linked user who chose to be
 * followed: their account is public on their card. A follower is a linked
 * user who chose a leader and set a cap for it. When a leader's buy lands
 * through the bot, the same buy is mirrored into every follower's own
 * session account, sized to the follower's cap, executed by the bot's key
 * inside the session the follower granted. Nobody hands over a key; a
 * follower stops following in one tap and revokes the session in one tx.
 *
 * The guards, because a copy feed is the easiest thing in crypto to abuse:
 *  - orus is asked before every mirrored buy; a honeypot, no read at all,
 *    or no orus wired into this bot, and everyone is skipped and told.
 *    unknown is not safe, and a bot without the scanner knows nothing.
 *  - a per-follow cap: at most this much ETH per mirrored buy.
 *  - an aggregate cap per token per day across all followers, so fifty
 *    followers cannot be walked into a 1 ETH pool behind one leader.
 *  - the follower's own daily allowance of executes and gas from the bot,
 *    the same one their own taps spend (the session bot hands the charge
 *    in), so a leader with many followers cannot burn the bot's gas many
 *    times over.
 *  - fixed order (followers in the order they followed) and a public log
 *    of every mirror, hash included, so the operator cannot quietly
 *    front-run its own followers without it being visible.
 *  - the leader's own trade lands first; mirrors go after, never before;
 *    the feed's message goes after the mirrors, never before, so the
 *    group never reads a stream of follower buys that have not landed yet.
 *  - one follower's failed send is that follower's alone: it is logged,
 *    the day's room is given back, the next follower runs.
 *  - a time budget: mirrors stop being started once it is spent and the
 *    rest are told, because the request that runs them has a limit of its
 *    own and a request cut off mid-way tells nobody. The budget counts the
 *    receipts too, not only the sends: the session bot hands in the moment
 *    the request must be done with its mirrors (`until`, measured from the
 *    request's start, so the leader's own receipt wait is already out of
 *    it), each mirror waits for its receipt only as long as is left after
 *    a send's own allowance, and none is started with less than that.
 *
 * Two kinds of leader. An account leader trades through the bot, so the
 * bot sees the buy the moment it lands and mirrors it in the same request.
 * That is a buy the leader taps: a limit buy or a DCA of theirs fires from
 * the orders' cron in a function of its own (bot-orders.ts), without the
 * desk, and is neither posted nor mirrored, and a sell is never mirrored,
 * so a follower gets out of a mirrored position on their own; every card
 * says both. A wallet leader trades from their own wallet, outside the bot
 * (a whale does not move their fleet into a session account to be
 * followed): they prove the wallet once with a signature on the Sessions
 * page (`chit-bot-lead|<chainId>|<wallet>|<nonce>`, the link's own nonce
 * store and its fifteen minutes, one claim per nonce, one leader per
 * wallet), and the venue's swap logs are read by the watcher (bot-watch.ts,
 * its cron) which hands every ETH buy to `onVenueBuy`: a buy by a claimed,
 * open wallet leader is mirrored with the same guards and posted the same
 * way, and the leader is told in private how many followed. The buy is
 * never the leader's session account trading through the bot (that path
 * mirrors from the bot's own buy, and its sender is the bot's signer, not
 * the wallet). A wallet costs one signature, and the watcher hands over
 * whatever swapped, so the venue path has guards of its own before a buy
 * is worth a message: it is at least VENUE_MIN_ETH_WEI (dust is not a
 * signal, and is read as nothing); it went through the token's own pool on
 * the venue, the one the followers buy through (the watcher resolves any
 * pool it sees, so a pool the leader opened and provides for themselves
 * would otherwise trigger mirrors at no cost to them); the leader has not
 * had VENUE_BUYS_PER_DAY buys read today (past that the day is silent and
 * the leader was told on the last one); and orus clears the token before
 * anything is posted, so a token the desk would refuse to mirror is not
 * advertised either, and the followers are not messaged for it. A
 * transaction is claimed in the store before the first send
 * (`claimVenueBuy`, one row per hash, one statement), so two overlapping
 * watcher runs in two instances cannot both mirror it; this instance's own
 * seen set is only the fast answer. The reads come before the claim, so a
 * chain or scanner that fails leaves the hash unclaimed and a delivery
 * again is read again; after the claim each step is caught on its own (a
 * mirror run that throws, a feed that refuses), the claim stands (money
 * moves at most once, a lost mirror is told, not repeated) and the leader
 * hears what happened. A follower's daily allowance is one ledger for both
 * paths (`bot_copy_user_days`): the session bot notes each tap into it and
 * asks it before a tap, every mirror charges it, so the watcher's function
 * and the webhook's count the same day. Mirroring the orders' fires and a
 * queue of mirrors that outlives one request stay for later.
 *
 * The feed is the group's window on the same thing: one message once a
 * leader's buy has landed and its mirrors are through, with the hash, the
 * partners' lines, how many followers it reached, and two doors into the
 * bot (buy this token, follow this leader). The follow door carries the
 * leader's account, the one thing they agreed to show when they opened,
 * never their Telegram id: a group can read a button's link. Only landed
 * buys are posted, one message each; a buy that did not land, or a buy by
 * someone who is not an open leader, posts nothing.
 *
 * A handle is either the Telegram @username, taken from Telegram and never
 * typed, or a plain name: letters, digits, spaces and _ . - , no leading @,
 * nothing that reads as the project or its staff, and no name already on
 * the list. The list is what followers trust; it must not be forgeable.
 */

import { type Address, type Hex, getAddress, isAddress, isHex, recoverMessageAddress } from "viem";
import type { BotChain, TokenInfo } from "./bot-chain.js";
import { heyLine, type HeyScan, type HeyScanner } from "./bot-hey.js";
import { NONCE_TTL_MS, issueNonce, type BotLinkStore } from "./bot-link.js";
import { orusLine, type OrusScan, type OrusScanner } from "./bot-orus.js";
import type { SessionChain } from "./bot-session-chain.js";
import { esc, type Keyboard } from "./bot-telegram.js";
import { poolIdOf } from "./pool-registry.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, minOutFor, venuePoolKey } from "./v4-swap.js";

export type Leader = {
  tgId: string;
  /** The address on the card and behind the feed's follow door, the one thing the leader agreed to show: the session account of an account leader, the proven wallet of a wallet leader. */
  account: Address;
  handle: string;
  since: string;
  open: boolean;
  /** How their buys reach the desk: 'account', tapped in the bot and mirrored from the landed buy; 'wallet', made from their own wallet on the venue and mirrored from the swap logs. */
  kind: "account" | "wallet";
  /** The wallet they proved with its own signature; set once claimed, kept if they lead from the account again. */
  wallet?: Address;
};
export type Follow = { followerTgId: string; leaderTgId: string; capWei: bigint; since: string };
export type Mirror = { leaderTgId: string; followerTgId: string; token: Address; ethWei: bigint; hash: Hex | null; outcome: "landed" | "sent" | "skipped"; why: string; at: string };

/**
 * One ETH buy on the venue, as the watcher reads it from the PoolManager's
 * Swap logs (bot-watch.ts exports the same shape; the desk names it here so
 * the two modules build apart, and the import can point there once they
 * meet). `buyer` is the transaction's sender; `ethInWei` what they paid.
 */
export type VenueBuy = { block: bigint; txHash: Hex; buyer: Address; token: Address; ethInWei: bigint; tokensOut: bigint; poolId: Hex };

export interface CopyStore {
  putLeader(l: Leader): Promise<void>;
  getLeader(tgId: string): Promise<Leader | undefined>;
  leaders(): Promise<Leader[]>;
  /** The leader, open or closed, who claimed this wallet: a wallet is one leader's. */
  leaderByWallet(wallet: Address): Promise<Leader | undefined>;
  putFollow(f: Follow): Promise<void>;
  removeFollow(followerTgId: string, leaderTgId: string): Promise<void>;
  followsOf(followerTgId: string): Promise<Follow[]>;
  /** In the order they followed: the mirror order is fixed and visible. */
  followersOf(leaderTgId: string): Promise<Follow[]>;
  /** ETH already mirrored into `token` today across every follower, for the aggregate cap. Atomic add. */
  addTokenDay(day: string, token: Address, wei: bigint): Promise<bigint>;
  log(m: Mirror): Promise<void>;
  recent(leaderTgId: string, n: number): Promise<Mirror[]>;
  /**
   * The follower's ledger of buys from the bot today, taps and mirrors of both paths alike: adds `executes` (zero reads) and
   * returns the day's total. Atomic add, so two functions charging the same account at once both see the sum.
   */
  addUserDay(day: string, tgId: string, executes: number): Promise<number>;
  /** Takes a venue transaction for this leader in one statement: true when this call was the first, false when another run has it. */
  claimVenueBuy(txHash: Hex, leaderTgId: string, at: Date): Promise<boolean>;
  /** Venue buys of this leader's claimed since `since`: the per-leader count for the day. */
  venueBuysSince(leaderTgId: string, since: Date): Promise<number>;
}

export type CopyDeps = {
  store: CopyStore;
  links: BotLinkStore;
  reads: BotChain;
  session: SessionChain;
  orus?: OrusScanner;
  /** The builder line on a venue buy's feed message; the cards' path brings its own. */
  hey?: HeyScanner;
  /** ETH into one token per UTC day across all followers; default 2 ETH. */
  tokenDayCapWei?: bigint;
  /** A follower's daily allowance from the bot, counted from the store's ledger (`addUserDay`), which the session bot writes its taps into; the defaults are the session bot's. */
  dailyExecutes?: number;
  dailyGasWei?: bigint;
  /** Below this a wallet leader's venue buy is read as nothing; default 0.01 ETH. */
  venueMinEthWei?: bigint;
  /** Venue buys read for one wallet leader per UTC day, posted and mirrored; past it the day is silent. Default 20. */
  venueBuysPerDay?: number;
  /** How long after a mirror run starts new sends are still started; default 30 seconds. */
  mirrorBudgetMs?: number;
  buySlippageBps?: number;
  now?: () => Date;
  /** Told about each mirror, to message the follower. */
  tell?: (followerTgId: string, text: string) => Promise<void>;
  /** The group the leaders' landed buys are posted to; absent means no feed. */
  feed?: CopyFeed;
  /** The bot's @username without the @, for the feed's deep links into it. */
  botUsername?: string;
};

export type CopyFeed = { chatId: string; post(text: string, keyboard: Keyboard): Promise<void> };

export const MAX_FOLLOW_CAP_WEI = 10n ** 18n;
const DEFAULT_TOKEN_DAY_CAP = 2n * 10n ** 18n;
const DEFAULT_MIRROR_BUDGET_MS = 30_000;
/** The session bot's daily limits (bot-session.ts DEFAULTS) and its charge per execute, for the ledger's count. */
const DAILY_DEFAULTS = { executes: 200, gasWei: 2_000_000_000_000_000n };
const EXECUTE_GAS_WEI = 700_000n * 1_000_000_000n;
/** A wallet leader's venue buy under this is dust and is read as nothing; the cards say the size. */
export const VENUE_MIN_ETH_WEI = 10n ** 16n;
/** Venue buys read for one wallet leader in a UTC day; a wallet is one signature, so the feed and the followers are not theirs to flood. */
export const VENUE_BUYS_PER_DAY = 20;
/** How many transaction hashes this instance remembers as mirrored; older ones fall out, the store's claim is the guard between instances. */
const SEEN_MAX = 2_000;
export const HANDLE_MAX = 32;
/** A plain name: starts with a letter or digit; letters, digits, spaces, _ . - after; never an @. */
const PLAIN_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,31}$/;
const TELEGRAM_HANDLE = /^@[A-Za-z0-9_]{1,32}$/;
/** Names that read as the project or its staff, refused so nobody leads as us. */
const RESERVED = /chit|admin|support|official|orus|hey research/i;

/** Whether a typed name may be a handle. The @ form is Telegram's own and is never accepted from a reply. */
export const plainHandleOk = (h: string): boolean => PLAIN_HANDLE.test(h) && !RESERVED.test(h);

/** What the mirror run is handed by the session bot: the charge to each follower's daily allowance, and the request's cut-off. */
export type MirrorOptions = {
  /** Counts one execute against the follower's day and returns null, or the refusal in the follower's words and counts nothing. May read a store, so it may answer late. */
  budget?: (followerTgId: string) => string | null | Promise<string | null>;
  /** Epoch ms by which the mirrors must be through, receipts included: the request's cut-off less what the feed and the leader's line need. Absent, `mirrorBudgetMs` from the run's start alone. */
  until?: number;
};
/** What one mirror needs besides its receipt wait: the send itself, the log line and the follower's message. No mirror starts with less left, and every receipt wait is what is left above it. */
export const MIRROR_SEND_MS = 5_000;

const eth = (wei: bigint): string => {
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
  return `${w}${f ? "." + f : ""}`;
};

/** The exact text a wallet leader signs. The chain id is in it so a claim signed for the testnet never leads on mainnet; the wallet is checksummed so the page and the desk spell it the same. */
export const leadMessage = (chainId: number, wallet: Address, nonce: string): string => `chit-bot-lead|${chainId}|${getAddress(wallet)}|${nonce}`;

/** A refused claim, with the status the route answers; the message is in the leader's words and says what to do next. */
export class LeadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type LeadRequest = {
  nonce: unknown; wallet: unknown; signature: unknown; handle: unknown;
  /** When known (the desk's own call), it must be the nonce's; the route learns it from the nonce. */
  tgId?: string;
};

/**
 * A wallet leader's claim, verified and stored: the same shape as
 * bot-link.ts's verifyLink, over the link store's nonces (one table, one
 * fifteen minutes, one use) and the copy store's leaders. Cheap checks
 * first, the signature next, the nonce consumed only once everything else
 * holds, so a stranger's signature cannot burn a good nonce. The handle is
 * a plain name (the @ form is Telegram's own and only the bot hands it in,
 * from the account path); an empty one keeps the name the leader already
 * has. One wallet leads for one Telegram id; a second claim of the same
 * wallet by the same id is a renewal. The leader's public address is the
 * wallet from here on.
 */
export const claimLeadWallet = async (store: CopyStore, links: BotLinkStore, chainId: number, req: LeadRequest, now: Date): Promise<Leader> => {
  const { nonce, wallet, signature, handle } = req;
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) throw new LeadError(400, "nonce is not one of ours: open the link from the bot again");
  if (typeof wallet !== "string" || !isAddress(wallet)) throw new LeadError(400, "wallet must be a 0x address");
  if (typeof signature !== "string" || !isHex(signature) || signature.length !== 132) throw new LeadError(400, "signature must be 65 bytes of hex");
  if (typeof handle !== "string") throw new LeadError(400, "handle must be text");
  const n = await links.getNonce(nonce);
  if (!n || (req.tgId !== undefined && n.tgId !== req.tgId)) throw new LeadError(404, "nonce unknown: open the link from the bot again");
  if (n.usedAt) throw new LeadError(409, "this link was already used: ask the bot for a new one");
  if (now.getTime() - Date.parse(n.issuedAt) > NONCE_TTL_MS) throw new LeadError(410, "this link expired: ask the bot for a new one");
  const existing = await store.getLeader(n.tgId);
  const name = handle.trim() || existing?.handle || "";
  if (!name) throw new LeadError(400, "a leader needs a name: letters, digits, spaces, _ . - and up to 32");
  // The @ form is refused from here whatever it says: a page cannot prove a Telegram username, the bot's account path takes it from Telegram itself.
  if (!plainHandleOk(name)) throw new LeadError(400, "that name will not do: letters, digits, spaces, _ . - and up to 32, not the project's name, no @");
  const taken = (await store.leaders()).some((l) => l.tgId !== n.tgId && l.handle.toLowerCase() === name.toLowerCase());
  if (taken) throw new LeadError(409, "that name is already on the leaders list: choose another");
  let signer: Address;
  try { signer = await recoverMessageAddress({ message: leadMessage(chainId, wallet, nonce), signature: signature as Hex }); }
  catch { throw new LeadError(400, "the signature does not decode"); }
  const proven = getAddress(wallet);
  if (getAddress(signer) !== proven) throw new LeadError(403, "the signature is not this wallet's: sign with the wallet you named");
  const holder = await store.leaderByWallet(proven);
  if (holder && holder.tgId !== n.tgId) throw new LeadError(409, "this wallet already leads for another telegram account");
  if (!(await links.useNonce(nonce, now))) throw new LeadError(409, "this link was already used: ask the bot for a new one");
  const leader: Leader = { tgId: n.tgId, account: proven, wallet: proven, kind: "wallet", handle: name, since: existing?.since ?? now.toISOString(), open: true };
  await store.putLeader(leader);
  return leader;
};

export class CopyDesk {
  readonly #d: CopyDeps;
  /** Transaction hashes this instance has posted or mirrored, in the order seen; a venue buy with a hash in here is not mirrored again. */
  readonly #seen = new Set<string>();
  constructor(d: CopyDeps) { this.#d = d; }
  get #now(): Date { return this.#d.now ? this.#d.now() : new Date(); }

  /** Remembers a hash; true when it was new. Bounded, the oldest forgotten first. */
  #see(hash: Hex): boolean {
    const k = hash.toLowerCase();
    if (this.#seen.has(k)) return false;
    this.#seen.add(k);
    if (this.#seen.size > SEEN_MAX) { const first = this.#seen.values().next().value; if (first !== undefined) this.#seen.delete(first); }
    return true;
  }

  /**
   * A linked user opens their account to followers. Their account address
   * becomes public on the leader list. The handle is checked here, whoever
   * typed it: the plain form or Telegram's @ form, and not one another open
   * leader already has, so the list cannot carry two of the same name.
   */
  async becomeLeader(tgId: string, handle: string): Promise<Leader> {
    const link = await this.#d.links.getLink(tgId);
    if (!link) throw new Error("link your account first");
    if (!(TELEGRAM_HANDLE.test(handle) || plainHandleOk(handle))) throw new Error("that name will not do: letters, digits, spaces, _ . - and up to 32, not the project's name, no @");
    const taken = (await this.#d.store.leaders()).some((l) => l.tgId !== tgId && l.handle.toLowerCase() === handle.toLowerCase());
    if (taken) throw new Error("that name is already on the leaders list");
    const existing = await this.#d.store.getLeader(tgId);
    // A wallet leader who opens from the account again keeps the wallet they proved, but their buys are read from the bot from here on.
    const leader: Leader = existing ? { ...existing, open: true, account: link.account, handle, kind: "account" } : { tgId, account: link.account, handle, since: this.#now.toISOString(), open: true, kind: "account" };
    await this.#d.store.putLeader(leader);
    return leader;
  }

  /**
   * A user claims the wallet they trade from, outside the bot, as the one
   * their followers copy: the proof is the wallet's own signature over the
   * lead message, on a nonce the bot minted for them (`leadNonce`) and the
   * Sessions page carried. The full check is `claimLeadWallet`; this is the
   * desk's door to it, with the Telegram id it expects the nonce to name.
   */
  claimWallet(tgId: string, handle: string, wallet: unknown, signature: unknown, nonce: unknown, chainId: number, now: Date = this.#now): Promise<Leader> {
    return claimLeadWallet(this.#d.store, this.#d.links, chainId, { nonce, wallet, signature, handle, tgId }, now);
  }
  /** Mints the nonce the lead link carries: the link store's own, so one table holds every one-time code the bot hands out. */
  leadNonce(tgId: string): Promise<string> { return issueNonce(this.#d.links, tgId, this.#now); }
  /** The leader, open or closed, who proved this wallet; undefined for a wallet nobody claimed. */
  leaderByWallet(wallet: Address): Promise<Leader | undefined> { return this.#d.store.leaderByWallet(wallet); }
  async closeLeader(tgId: string): Promise<void> {
    const l = await this.#d.store.getLeader(tgId);
    if (l) await this.#d.store.putLeader({ ...l, open: false });
  }
  /** The open leader behind a Telegram id, or undefined: closed and never-opened read the same to the feed and the mirrors. */
  async leader(tgId: string): Promise<Leader | undefined> {
    const l = await this.#d.store.getLeader(tgId);
    return l && l.open ? l : undefined;
  }
  /** The open leader behind a session account (the feed's follow door names it), or undefined. */
  async leaderAt(account: Address): Promise<Leader | undefined> {
    return (await this.#d.store.leaders()).find((l) => l.account.toLowerCase() === account.toLowerCase());
  }
  leaders(): Promise<Leader[]> { return this.#d.store.leaders(); }
  followsOf(followerTgId: string): Promise<Follow[]> { return this.#d.store.followsOf(followerTgId); }
  followersOf(leaderTgId: string): Promise<Follow[]> { return this.#d.store.followersOf(leaderTgId); }

  // ---------- the day's ledger ----------
  // One count of buys from the bot into an account per UTC day, in the store, so the webhook's taps and mirrors and the
  // watcher's mirrors are the same day: the session bot's own memory sees only its instance's requests.

  get #day(): string { return this.#now.toISOString().slice(0, 10); }
  /** The refusal for a day that holds `n` buys already, in the follower's words, or null. */
  #dayRefusal(n: number): string | null {
    const executes = this.#d.dailyExecutes ?? DAILY_DEFAULTS.executes;
    if (n >= executes) return `that is ${executes} buys today from your account; again tomorrow`;
    if (BigInt(n) * EXECUTE_GAS_WEI >= (this.#d.dailyGasWei ?? DAILY_DEFAULTS.gasWei)) return "the bot has fronted its daily gas for your account; again tomorrow";
    return null;
  }
  /**
   * Counts one execute against the account's day and returns null, or the refusal and the account is over. The add comes
   * first, so two mirrors charging at once cannot both pass on the last slot; the count left over by a refusal only
   * tightens the day. MirrorOptions.budget's shape, for both paths' mirrors.
   */
  async chargeDay(tgId: string): Promise<string | null> {
    const n = await this.#d.store.addUserDay(this.#day, tgId, 1);
    return this.#dayRefusal(n - 1);
  }
  /** The session bot's own tap, after its send: counted here so a mirror from the watcher's function sees it; never refused, the tap passed its own check. */
  async noteDay(tgId: string): Promise<void> { await this.#d.store.addUserDay(this.#day, tgId, 1); }
  /** What the ledger alone would refuse a tap with right now, or null: the session bot asks before a tap, for the mirrors its memory never saw. */
  async overDay(tgId: string): Promise<string | null> { return this.#dayRefusal(await this.#d.store.addUserDay(this.#day, tgId, 0)); }

  /**
   * A leader's buy landed and its mirrors are through: one message to the
   * group. The hash so anyone can check it, orus's and HEY's lines so the
   * group sees what the leader saw, how many followers it reached, and two
   * doors into the bot: buy the same token, or follow this leader, by the
   * leader's account (public since they opened) and never their Telegram id,
   * which the group would otherwise read off the button's link. True when
   * posted; false when there is no feed or the buyer is not an open leader,
   * and nothing was sent. Posted after the mirrors on purpose: a message
   * before them would tell the group exactly which buys are about to land.
   */
  async announce(leaderTgId: string, token: Address, ethWei: bigint, hash: Hex, info: TokenInfo, scan: OrusScan | undefined, hey: HeyScan | undefined, mirrors: Mirror[] = []): Promise<boolean> {
    // Remembered whichever path brought it, feed or no feed: the watcher delivering this transaction later mirrors nothing.
    this.#see(hash);
    const feed = this.#d.feed;
    if (!feed) return false;
    const leader = await this.leader(leaderTgId);
    if (!leader) return false;
    const who = esc(leader.handle);
    const went = mirrors.filter((m) => m.outcome !== "skipped").length;
    const lines = [
      `<b>${who}</b> bought <code>${eth(ethWei)} ETH</code> of <b>${esc(info.symbol)}</b> · <a href="https://robinhoodchain.blockscout.com/tx/${hash}">${hash.slice(0, 10)}…</a>`,
      ...(scan && this.#d.orus ? [`orus: ${orusLine(scan, this.#d.orus.link(token))}`] : []),
      ...(hey ? [`hey research lab: ${heyLine(hey)}`] : []),
      ...(mirrors.length ? [`mirrored into ${went} of ${mirrors.length} follower account${mirrors.length === 1 ? "" : "s"}, already landed or sent`] : []),
    ];
    const bot = `https://t.me/${this.#d.botUsername ?? ""}`;
    await feed.post(lines.join("\n"), [[{ text: "buy this", url: `${bot}?start=t-${token}` }, { text: `follow ${leader.handle}`, url: `${bot}?start=f-${leader.account}` }]]);
    return true;
  }

  /** A linked user follows an open leader with a cap per mirrored buy. A follower never follows themselves. */
  async follow(followerTgId: string, leaderTgId: string, capWei: bigint): Promise<Follow> {
    if (followerTgId === leaderTgId) throw new Error("you cannot follow yourself");
    if (capWei <= 0n || capWei > MAX_FOLLOW_CAP_WEI) throw new Error(`cap must be between 1 wei and ${eth(MAX_FOLLOW_CAP_WEI)} ETH`);
    if (!(await this.#d.links.getLink(followerTgId))) throw new Error("link your account first");
    const leader = await this.#d.store.getLeader(leaderTgId);
    if (!leader || !leader.open) throw new Error("that leader is not open to followers");
    const f: Follow = { followerTgId, leaderTgId, capWei, since: this.#now.toISOString() };
    await this.#d.store.putFollow(f);
    return f;
  }
  unfollow(followerTgId: string, leaderTgId: string): Promise<void> { return this.#d.store.removeFollow(followerTgId, leaderTgId); }

  /**
   * The leader's buy landed; mirror it. Runs the followers in their fixed
   * order and returns every outcome. A skip is a mirror too, with its reason
   * in the log, so a follower can see why they did not get a fill. A send
   * that throws for one follower is logged for that follower and the run
   * goes on; once the time budget is spent the rest are skipped and told.
   * The budget is the smaller of the run's own and the request's `until`,
   * and it bounds the receipts as well as the sends: a mirror is started
   * only with MIRROR_SEND_MS left and waits for its receipt only for the
   * rest, so a slow block is a mirror reported as sent, not a request the
   * host kills with the log, the feed and the followers' lines unwritten.
   */
  async mirror(leaderTgId: string, token: Address, leaderEthWei: bigint, opts: MirrorOptions = {}): Promise<Mirror[]> {
    const leader = await this.#d.store.getLeader(leaderTgId);
    if (!leader || !leader.open) return [];
    const followers = await this.#d.store.followersOf(leaderTgId);
    if (!followers.length) return [];
    const now = this.#now, day = now.toISOString().slice(0, 10);
    const budgetUntil = Math.min(now.getTime() + (this.#d.mirrorBudgetMs ?? DEFAULT_MIRROR_BUDGET_MS), opts.until ?? Number.POSITIVE_INFINITY);
    const out: Mirror[] = [];
    const record = async (m: Mirror) => { out.push(m); await this.#d.store.log(m); if (this.#d.tell) await this.#d.tell(m.followerTgId, this.#tellText(leader, m)); };
    // The gate is asked once for the token, not once per follower: same answer, less traffic.
    const [info, scan] = await Promise.all([this.#d.reads.tokenInfo(token), this.#d.orus?.scan(token)]);
    const base = { leaderTgId, token, at: now.toISOString(), hash: null as Hex | null };
    if (!info.hasPool) { for (const f of followers) await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: "no ETH pool on the venue" }); return out; }
    // No scanner wired is the same as no read: every card promises orus is asked first, and a bot without orus cannot keep that.
    if (!scan) { for (const f of followers) await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: this.#d.orus ? "orus had no read; unknown is not safe" : "orus is not wired into this bot; unknown is not safe" }); return out; }
    if (scan.honeypot !== false) { for (const f of followers) await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: scan.honeypot ? "orus says honeypot" : "orus could not rule out a honeypot" }); return out; }
    const cap = this.#d.tokenDayCapWei ?? DEFAULT_TOKEN_DAY_CAP;
    for (const f of followers) {
      const link = await this.#d.links.getLink(f.followerTgId);
      if (!link) { await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: "follower is not linked" }); continue; }
      // Sized to the leader's buy, never above the follower's cap.
      const wei = leaderEthWei < f.capWei ? leaderEthWei : f.capWei;
      const left = budgetUntil - this.#now.getTime();
      if (left < MIRROR_SEND_MS) { await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: "this run ran out of time before your turn; nothing was sent for you" }); continue; }
      const soFar = await this.#d.store.addTokenDay(day, token, wei);
      if (soFar > cap) { await this.#d.store.addTokenDay(day, token, -wei); await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: `today's cap into this token across all followers (${eth(cap)} ETH) is reached` }); continue; }
      const can = await this.#d.session.canExecute(link.account, this.#d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, wei);
      if (!can.ok) { await this.#d.store.addTokenDay(day, token, -wei); await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: `your session says no: ${can.why}` }); continue; }
      const quote = await this.#d.reads.quoteBuy(token, wei);
      if (quote === null) { await this.#d.store.addTokenDay(day, token, -wei); await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: "no quote right now" }); continue; }
      // The follower's own daily allowance, last, so a skip for any other reason costs them nothing.
      const refused = opts.budget ? await opts.budget(f.followerTgId) : null;
      if (refused) { await this.#d.store.addTokenDay(day, token, -wei); await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: refused }); continue; }
      const minOut = minOutFor(quote, this.#d.buySlippageBps ?? 300);
      const deadline = BigInt(Math.floor(now.getTime() / 1000) + 3600);
      const data = encodeV4EthBuy({ token, amountIn: wei, minOut, deadline, ...(info.poolKey ? { poolKey: info.poolKey } : {}) });
      let r: { hash: Hex; landed: boolean };
      try {
        // The receipt is waited for only with the time that is left after the send's own allowance; slower than that is "sent".
        r = await this.#d.session.execute(link.account, this.#d.reads.router, wei, data, left - MIRROR_SEND_MS);
      } catch (error) {
        // The send itself failed (the signer, the rpc): nothing was broadcast for this follower, the day's room is theirs again, the next follower runs.
        const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown";
        console.error("copy mirror:", f.followerTgId, detail);
        await this.#d.store.addTokenDay(day, token, -wei);
        await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: "the send failed on our side; nothing was spent for you" });
        continue;
      }
      await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, hash: r.hash, outcome: r.landed ? "landed" : "sent", why: r.landed ? "" : "sent, not confirmed as landed" });
    }
    return out;
  }

  /**
   * The watcher read an ETH buy on the venue. When the buyer is the wallet
   * an open wallet leader proved, the buy is at least the minimum, the
   * leader has not had their day's count of buys read, it went through the
   * token's own pool on the venue and orus clears the token, it is mirrored
   * exactly as a landed buy from the bot is (the same gate, caps, order and
   * log; the followers' daily allowance from the same ledger the webhook
   * charges), then posted to the feed, then the leader is told in private
   * how many followed. Anyone else's buy, a closed leader's, an account
   * leader's own wallet, dust, a day already full, or a hash claimed
   * before, here or in another instance: nothing, and undefined says so. A
   * buy that is the leader's but not for the feed (another pool, a token
   * orus will not clear) is claimed and counted, the leader is told why
   * and what buy would be read, and [] says so. The reads come before the
   * claim, so a failure there leaves the hash for the next delivery; after
   * the claim, a mirror run or a feed that throws is caught, logged and
   * told, never repeated. The mirrors get the desk's own time budget; the
   * watcher's run bounds the whole pass.
   */
  async onVenueBuy(b: VenueBuy): Promise<Mirror[] | undefined> {
    const leader = await this.#d.store.leaderByWallet(b.buyer);
    if (!leader || !leader.open || leader.kind !== "wallet") return undefined;
    if (b.ethInWei < (this.#d.venueMinEthWei ?? VENUE_MIN_ETH_WEI)) return undefined;
    if (this.#seen.has(b.txHash.toLowerCase())) return undefined;
    const now = this.#now, dayStart = new Date(now.toISOString().slice(0, 10));
    const perDay = this.#d.venueBuysPerDay ?? VENUE_BUYS_PER_DAY;
    const before = await this.#d.store.venueBuysSince(leader.tgId, dayStart);
    if (before >= perDay) return undefined;
    const [info, scan, hey] = await Promise.all([this.#d.reads.tokenInfo(b.token), this.#d.orus?.scan(b.token), this.#d.hey?.scan(b.token)]);
    if (!(await this.#d.store.claimVenueBuy(b.txHash, leader.tgId, now))) return undefined;
    this.#see(b.txHash);
    const link = `<a href="https://robinhoodchain.blockscout.com/tx/${b.txHash}">${b.txHash.slice(0, 10)}…</a>`;
    const what = `your buy of <code>${eth(b.ethInWei)} ETH</code> of <b>${esc(info.symbol)}</b> from your wallet (${link})`;
    // The last buy read today says so, and the ones after it are silent until tomorrow.
    const last = before + 1 >= perDay ? ` that is ${perDay} buys read from your wallet today; the next ones are read again tomorrow.` : "";
    const tellLeader = async (text: string) => {
      if (!this.#d.tell) return;
      try { await this.#d.tell(leader.tgId, text + last); } catch (error) { console.error("copy venue tell:", leader.tgId, (error instanceof Error ? error.message : String(error)).split("\n")[0]); }
    };
    // The pool must be the token's own on the venue, the one the followers buy through; a pool the leader opened for themselves is theirs alone.
    const pool = poolIdOf(info.poolKey ?? venuePoolKey(b.token));
    if (pool.toLowerCase() !== b.poolId.toLowerCase()) {
      await tellLeader(`${what} went through a pool that is not the token's pool on the venue, so it was not posted or mirrored. a buy through the venue's own pool for the token, the one the bot quotes, is.`);
      return [];
    }
    // The gate before the feed as before the mirrors: a token orus will not clear is advertised nowhere, and the followers are not messaged for it.
    const gate = !scan ? (this.#d.orus ? "orus had no read; unknown is not safe" : "orus is not wired into this bot; unknown is not safe") : scan.honeypot !== false ? (scan.honeypot ? "orus says honeypot" : "orus could not rule out a honeypot") : null;
    if (gate) {
      await tellLeader(`${what} was not posted or mirrored: ${gate}. a token orus clears is.`);
      return [];
    }
    let mirrors: Mirror[] = [], broke = false;
    try { mirrors = await this.mirror(leader.tgId, b.token, b.ethInWei, { budget: (tgId) => this.chargeDay(tgId) }); }
    catch (error) { broke = true; console.error("copy venue mirror:", leader.tgId, (error instanceof Error ? error.message : String(error)).split("\n")[0]); }
    let posted = false, feedBroke = false;
    try { posted = await this.announce(leader.tgId, b.token, b.ethInWei, b.txHash, info, scan, hey, mirrors); }
    catch (error) { feedBroke = true; console.error("copy venue feed:", leader.tgId, (error instanceof Error ? error.message : String(error)).split("\n")[0]); }
    const went = mirrors.filter((m) => m.outcome !== "skipped").length, skipped = mirrors.length - went;
    const reach = broke ? "a mirror broke on our side, every follower who was reached was told and the rest were not mirrored this time"
      : mirrors.length ? `mirrored to ${went} of ${mirrors.length} follower${mirrors.length === 1 ? "" : "s"}${skipped ? `, ${skipped} skipped (each was told why)` : ""}` : "nobody follows you yet";
    const feed = posted ? "posted to the feed" : feedBroke ? "not posted, the feed broke on our side" : null;
    const did = feed ? (mirrors.length ? `${feed} and ${reach}` : `${feed}; ${reach}`) : (mirrors.length || broke ? reach : `seen; ${reach}`);
    await tellLeader(`${what} was ${did}.`);
    return mirrors;
  }

  #tellText(leader: Leader, m: Mirror): string {
    const who = `<b>${leader.handle.replace(/[<>&]/g, "")}</b>`;
    if (m.outcome === "skipped") return `copy from ${who}: skipped. ${m.why}.`;
    const link = `<a href="https://robinhoodchain.blockscout.com/tx/${m.hash}">${m.hash!.slice(0, 10)}…</a>`;
    return m.outcome === "landed" ? `copied ${who}: <code>${eth(m.ethWei)} ETH</code> into <code>${m.token}</code>, landed ${link}.` : `copied ${who}: <code>${eth(m.ethWei)} ETH</code> sent ${link}, not confirmed as landed; the floor protects the fill.`;
  }
}

/**
 * Puts the desk's venue handler into the watcher's registry, so every ETH
 * buy the watcher reads is offered to the desk. The registry is the watcher
 * runtime's (bot-watch-runtime.ts, built on its own branch); the bot
 * runtime looks it up and calls this when it is there. The handler rejects
 * only from before the desk's claim (a store or a chain read that failed),
 * when nothing was done and a delivery again is right; after the claim the
 * desk catches its own steps.
 */
export const registerCopyWatch = (desk: CopyDesk, registry: { push(handler: (b: VenueBuy) => Promise<void>): void }): void => {
  registry.push(async (b) => { await desk.onVenueBuy(b); });
};

/** One instance's memory. */
export class MemoryCopyStore implements CopyStore {
  readonly leadersMap = new Map<string, Leader>();
  readonly follows: Follow[] = [];
  readonly days = new Map<string, bigint>();
  readonly userDays = new Map<string, number>();
  readonly venueBuys = new Map<string, { leaderTgId: string; at: string }>();
  readonly mirrors: Mirror[] = [];
  async putLeader(l: Leader) { this.leadersMap.set(l.tgId, { ...l }); }
  async getLeader(tgId: string) { const l = this.leadersMap.get(tgId); return l ? { ...l } : undefined; }
  async leaders() { return [...this.leadersMap.values()].filter((l) => l.open).map((l) => ({ ...l })); }
  async leaderByWallet(wallet: Address) { const w = wallet.toLowerCase(); const l = [...this.leadersMap.values()].find((x) => x.wallet?.toLowerCase() === w); return l ? { ...l } : undefined; }
  async putFollow(f: Follow) { await this.removeFollow(f.followerTgId, f.leaderTgId); this.follows.push({ ...f }); }
  async removeFollow(a: string, b: string) { const i = this.follows.findIndex((f) => f.followerTgId === a && f.leaderTgId === b); if (i >= 0) this.follows.splice(i, 1); }
  async followsOf(a: string) { return this.follows.filter((f) => f.followerTgId === a).map((f) => ({ ...f })); }
  async followersOf(b: string) { return this.follows.filter((f) => f.leaderTgId === b).map((f) => ({ ...f })); }
  async addTokenDay(day: string, token: Address, wei: bigint) { const k = `${day}|${token.toLowerCase()}`; const v = (this.days.get(k) ?? 0n) + wei; this.days.set(k, v); return v; }
  async log(m: Mirror) { this.mirrors.push({ ...m }); }
  async recent(leaderTgId: string, n: number) { return this.mirrors.filter((m) => m.leaderTgId === leaderTgId).slice(-n).reverse(); }
  async addUserDay(day: string, tgId: string, executes: number) { const k = `${day}|${tgId}`; const v = (this.userDays.get(k) ?? 0) + executes; this.userDays.set(k, v); return v; }
  async claimVenueBuy(txHash: Hex, leaderTgId: string, at: Date) { const k = txHash.toLowerCase(); if (this.venueBuys.has(k)) return false; this.venueBuys.set(k, { leaderTgId, at: at.toISOString() }); return true; }
  async venueBuysSince(leaderTgId: string, since: Date) { return [...this.venueBuys.values()].filter((v) => v.leaderTgId === leaderTgId && Date.parse(v.at) >= since.getTime()).length; }
}

type Row = Record<string, unknown>;
export type CopySql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_leaders (tg_id TEXT PRIMARY KEY, account TEXT NOT NULL, handle TEXT NOT NULL, since TIMESTAMPTZ NOT NULL, open BOOLEAN NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_follows (follower_tg_id TEXT NOT NULL, leader_tg_id TEXT NOT NULL, cap_wei NUMERIC(40,0) NOT NULL, since TIMESTAMPTZ NOT NULL, PRIMARY KEY (follower_tg_id, leader_tg_id))`,
  `CREATE TABLE IF NOT EXISTS bot_copy_days (day TEXT NOT NULL, token TEXT NOT NULL, wei NUMERIC(40,0) NOT NULL, PRIMARY KEY (day, token))`,
  `CREATE TABLE IF NOT EXISTS bot_mirrors (id BIGSERIAL PRIMARY KEY, leader_tg_id TEXT NOT NULL, follower_tg_id TEXT NOT NULL, token TEXT NOT NULL, eth_wei NUMERIC(40,0) NOT NULL, tx_hash TEXT, outcome TEXT NOT NULL, why TEXT NOT NULL, at TIMESTAMPTZ NOT NULL)`,
  // Wallet leaders came after the table: the rows from before are account leaders.
  `ALTER TABLE bot_leaders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'account'`,
  `ALTER TABLE bot_leaders ADD COLUMN IF NOT EXISTS wallet TEXT`,
  `CREATE INDEX IF NOT EXISTS bot_leaders_wallet ON bot_leaders (wallet)`,
  // The day's ledger of buys from the bot per account, both paths; and the venue transactions claimed, one row per hash.
  `CREATE TABLE IF NOT EXISTS bot_copy_user_days (day TEXT NOT NULL, tg_id TEXT NOT NULL, executes INTEGER NOT NULL, PRIMARY KEY (day, tg_id))`,
  `CREATE TABLE IF NOT EXISTS bot_venue_buys (tx_hash TEXT PRIMARY KEY, leader_tg_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bot_venue_buys_leader_at ON bot_venue_buys (leader_tg_id, at)`,
];
const rowLeader = (r: Row): Leader => ({
  tgId: String(r.tg_id), account: String(r.account) as Address, handle: String(r.handle), since: new Date(String(r.since)).toISOString(), open: Boolean(r.open),
  kind: r.kind === "wallet" ? "wallet" : "account", ...(r.wallet ? { wallet: getAddress(String(r.wallet)) } : {}),
});
const rowFollow = (r: Row): Follow => ({ followerTgId: String(r.follower_tg_id), leaderTgId: String(r.leader_tg_id), capWei: BigInt(String(r.cap_wei)), since: new Date(String(r.since)).toISOString() });
const rowMirror = (r: Row): Mirror => ({ leaderTgId: String(r.leader_tg_id), followerTgId: String(r.follower_tg_id), token: String(r.token) as Address, ethWei: BigInt(String(r.eth_wei)), hash: r.tx_hash ? (String(r.tx_hash) as Hex) : null, outcome: String(r.outcome) as Mirror["outcome"], why: String(r.why), at: new Date(String(r.at)).toISOString() });

export class NeonCopyStore implements CopyStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: CopySql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async putLeader(l: Leader) { await this.#init(); await this.sql.query(`INSERT INTO bot_leaders (tg_id, account, handle, since, open, kind, wallet) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tg_id) DO UPDATE SET account = EXCLUDED.account, handle = EXCLUDED.handle, open = EXCLUDED.open, kind = EXCLUDED.kind, wallet = EXCLUDED.wallet`, [l.tgId, l.account, l.handle, l.since, l.open, l.kind, l.wallet ? getAddress(l.wallet) : null]); }
  async getLeader(tgId: string) { await this.#init(); const [r] = await this.sql.query(`SELECT * FROM bot_leaders WHERE tg_id = $1`, [tgId]); return r ? rowLeader(r) : undefined; }
  async leaders() { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_leaders WHERE open ORDER BY since`)).map(rowLeader); }
  async leaderByWallet(wallet: Address) { await this.#init(); const [r] = await this.sql.query(`SELECT * FROM bot_leaders WHERE wallet = $1`, [getAddress(wallet)]); return r ? rowLeader(r) : undefined; }
  async putFollow(f: Follow) { await this.#init(); await this.sql.query(`INSERT INTO bot_follows (follower_tg_id, leader_tg_id, cap_wei, since) VALUES ($1,$2,$3,$4) ON CONFLICT (follower_tg_id, leader_tg_id) DO UPDATE SET cap_wei = EXCLUDED.cap_wei`, [f.followerTgId, f.leaderTgId, f.capWei.toString(), f.since]); }
  async removeFollow(a: string, b: string) { await this.#init(); await this.sql.query(`DELETE FROM bot_follows WHERE follower_tg_id = $1 AND leader_tg_id = $2`, [a, b]); }
  async followsOf(a: string) { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_follows WHERE follower_tg_id = $1 ORDER BY since`, [a])).map(rowFollow); }
  async followersOf(b: string) { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_follows WHERE leader_tg_id = $1 ORDER BY since`, [b])).map(rowFollow); }
  async addTokenDay(day: string, token: Address, wei: bigint) {
    await this.#init();
    const [r] = await this.sql.query(`INSERT INTO bot_copy_days (day, token, wei) VALUES ($1,$2,$3) ON CONFLICT (day, token) DO UPDATE SET wei = bot_copy_days.wei + EXCLUDED.wei RETURNING wei`, [day, token.toLowerCase(), wei.toString()]);
    return BigInt(String(r!.wei));
  }
  async log(m: Mirror) { await this.#init(); await this.sql.query(`INSERT INTO bot_mirrors (leader_tg_id, follower_tg_id, token, eth_wei, tx_hash, outcome, why, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [m.leaderTgId, m.followerTgId, m.token, m.ethWei.toString(), m.hash, m.outcome, m.why, m.at]); }
  async recent(leaderTgId: string, n: number) { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_mirrors WHERE leader_tg_id = $1 ORDER BY id DESC LIMIT $2`, [leaderTgId, n])).map(rowMirror); }
  async addUserDay(day: string, tgId: string, executes: number) {
    await this.#init();
    const [r] = await this.sql.query(`INSERT INTO bot_copy_user_days (day, tg_id, executes) VALUES ($1,$2,$3) ON CONFLICT (day, tg_id) DO UPDATE SET executes = bot_copy_user_days.executes + EXCLUDED.executes RETURNING executes`, [day, tgId, executes]);
    return Number(r!.executes);
  }
  /** One statement: the row is inserted only when no run has it; the conflict inserts nothing and returns nothing, so the second run reads false. */
  async claimVenueBuy(txHash: Hex, leaderTgId: string, at: Date) {
    await this.#init();
    const rows = await this.sql.query(`INSERT INTO bot_venue_buys (tx_hash, leader_tg_id, at) VALUES ($1,$2,$3) ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash`, [txHash.toLowerCase(), leaderTgId, at.toISOString()]);
    return rows.length === 1;
  }
  async venueBuysSince(leaderTgId: string, since: Date) { await this.#init(); const [r] = await this.sql.query(`SELECT count(*) AS n FROM bot_venue_buys WHERE leader_tg_id = $1 AND at >= $2`, [leaderTgId, since.toISOString()]); return Number(r?.n ?? 0); }
}

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
 *  - orus is asked before every mirrored buy; a honeypot, or no read at
 *    all, is skipped and the follower is told. unknown is not safe.
 *  - a per-follow cap: at most this much ETH per mirrored buy.
 *  - an aggregate cap per token per day across all followers, so fifty
 *    followers cannot be walked into a 1 ETH pool behind one leader.
 *  - fixed order (followers in the order they followed) and a public log
 *    of every mirror, hash included, so the operator cannot quietly
 *    front-run its own followers without it being visible.
 *  - the leader's own trade lands first; mirrors go after, never before.
 *
 * The first slice: leaders trade through the bot, so the bot sees the buy
 * the moment it lands and mirrors it in the same request. Watching an
 * outside wallet is the second slice.
 *
 * The feed is the group's window on the same thing: one message the second
 * a leader's buy lands, with the hash, the partners' lines, and two doors
 * into the bot (buy this token, follow this leader). Only landed buys are
 * posted, one message each; a buy that did not land, or a buy by someone
 * who is not an open leader, posts nothing.
 */

import type { Address, Hex } from "viem";
import type { BotChain, TokenInfo } from "./bot-chain.js";
import { heyLine, type HeyScan } from "./bot-hey.js";
import type { BotLinkStore } from "./bot-link.js";
import { orusLine, type OrusScan, type OrusScanner } from "./bot-orus.js";
import type { SessionChain } from "./bot-session-chain.js";
import { esc, type Keyboard } from "./bot-telegram.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeV4EthBuy, minOutFor } from "./v4-swap.js";

export type Leader = { tgId: string; account: Address; handle: string; since: string; open: boolean };
export type Follow = { followerTgId: string; leaderTgId: string; capWei: bigint; since: string };
export type Mirror = { leaderTgId: string; followerTgId: string; token: Address; ethWei: bigint; hash: Hex | null; outcome: "landed" | "sent" | "skipped"; why: string; at: string };

export interface CopyStore {
  putLeader(l: Leader): Promise<void>;
  getLeader(tgId: string): Promise<Leader | undefined>;
  leaders(): Promise<Leader[]>;
  putFollow(f: Follow): Promise<void>;
  removeFollow(followerTgId: string, leaderTgId: string): Promise<void>;
  followsOf(followerTgId: string): Promise<Follow[]>;
  /** In the order they followed: the mirror order is fixed and visible. */
  followersOf(leaderTgId: string): Promise<Follow[]>;
  /** ETH already mirrored into `token` today across every follower, for the aggregate cap. Atomic add. */
  addTokenDay(day: string, token: Address, wei: bigint): Promise<bigint>;
  log(m: Mirror): Promise<void>;
  recent(leaderTgId: string, n: number): Promise<Mirror[]>;
}

export type CopyDeps = {
  store: CopyStore;
  links: BotLinkStore;
  reads: BotChain;
  session: SessionChain;
  orus?: OrusScanner;
  /** ETH into one token per UTC day across all followers; default 2 ETH. */
  tokenDayCapWei?: bigint;
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

const eth = (wei: bigint): string => {
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 5).replace(/0+$/, "");
  return `${w}${f ? "." + f : ""}`;
};

export class CopyDesk {
  readonly #d: CopyDeps;
  constructor(d: CopyDeps) { this.#d = d; }
  get #now(): Date { return this.#d.now ? this.#d.now() : new Date(); }

  /** A linked user opens their account to followers. Their account address becomes public on the leader list. */
  async becomeLeader(tgId: string, handle: string): Promise<Leader> {
    const link = await this.#d.links.getLink(tgId);
    if (!link) throw new Error("link your account first");
    const existing = await this.#d.store.getLeader(tgId);
    const leader: Leader = existing ? { ...existing, open: true, account: link.account, handle } : { tgId, account: link.account, handle, since: this.#now.toISOString(), open: true };
    await this.#d.store.putLeader(leader);
    return leader;
  }
  async closeLeader(tgId: string): Promise<void> {
    const l = await this.#d.store.getLeader(tgId);
    if (l) await this.#d.store.putLeader({ ...l, open: false });
  }
  /** The open leader behind a Telegram id, or undefined: closed and never-opened read the same to the feed and the mirrors. */
  async leader(tgId: string): Promise<Leader | undefined> {
    const l = await this.#d.store.getLeader(tgId);
    return l && l.open ? l : undefined;
  }
  leaders(): Promise<Leader[]> { return this.#d.store.leaders(); }
  followsOf(followerTgId: string): Promise<Follow[]> { return this.#d.store.followsOf(followerTgId); }
  followersOf(leaderTgId: string): Promise<Follow[]> { return this.#d.store.followersOf(leaderTgId); }

  /**
   * A leader's buy landed: one message to the group, the second it is
   * known. The hash so anyone can check it, orus's and HEY's lines so the
   * group sees what the leader saw, and two doors into the bot: buy the same
   * token, or follow this leader. True when posted; false when there is no
   * feed or the buyer is not an open leader, and nothing was sent.
   */
  async announce(leaderTgId: string, token: Address, ethWei: bigint, hash: Hex, info: TokenInfo, scan: OrusScan | undefined, hey: HeyScan | undefined): Promise<boolean> {
    const feed = this.#d.feed;
    if (!feed) return false;
    const leader = await this.leader(leaderTgId);
    if (!leader) return false;
    const who = esc(leader.handle);
    const lines = [
      `<b>${who}</b> bought <code>${eth(ethWei)} ETH</code> of <b>${esc(info.symbol)}</b> · <a href="https://robinhoodchain.blockscout.com/tx/${hash}">${hash.slice(0, 10)}…</a>`,
      ...(scan && this.#d.orus ? [`orus: ${orusLine(scan, this.#d.orus.link(token))}`] : []),
      ...(hey ? [`hey research lab: ${heyLine(hey)}`] : []),
    ];
    const bot = `https://t.me/${this.#d.botUsername ?? ""}`;
    await feed.post(lines.join("\n"), [[{ text: "buy this", url: `${bot}?start=t-${token}` }, { text: `follow ${leader.handle}`, url: `${bot}?start=f-${leaderTgId}` }]]);
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
   * in the log, so a follower can see why they did not get a fill.
   */
  async mirror(leaderTgId: string, token: Address, leaderEthWei: bigint): Promise<Mirror[]> {
    const leader = await this.#d.store.getLeader(leaderTgId);
    if (!leader || !leader.open) return [];
    const followers = await this.#d.store.followersOf(leaderTgId);
    if (!followers.length) return [];
    const now = this.#now, day = now.toISOString().slice(0, 10);
    const out: Mirror[] = [];
    const record = async (m: Mirror) => { out.push(m); await this.#d.store.log(m); if (this.#d.tell) await this.#d.tell(m.followerTgId, this.#tellText(leader, m)); };
    // The gate is asked once for the token, not once per follower: same answer, less traffic.
    const [info, scan] = await Promise.all([this.#d.reads.tokenInfo(token), this.#d.orus?.scan(token)]);
    const base = { leaderTgId, token, at: now.toISOString(), hash: null as Hex | null };
    if (!info.hasPool) { for (const f of followers) await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: "no ETH pool on the venue" }); return out; }
    if (this.#d.orus && !scan) { for (const f of followers) await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: "orus had no read; unknown is not safe" }); return out; }
    if (scan && scan.honeypot !== false) { for (const f of followers) await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: scan.honeypot ? "orus says honeypot" : "orus could not rule out a honeypot" }); return out; }
    const cap = this.#d.tokenDayCapWei ?? DEFAULT_TOKEN_DAY_CAP;
    for (const f of followers) {
      const link = await this.#d.links.getLink(f.followerTgId);
      if (!link) { await record({ ...base, followerTgId: f.followerTgId, ethWei: 0n, outcome: "skipped", why: "follower is not linked" }); continue; }
      // Sized to the leader's buy, never above the follower's cap.
      const wei = leaderEthWei < f.capWei ? leaderEthWei : f.capWei;
      const soFar = await this.#d.store.addTokenDay(day, token, wei);
      if (soFar > cap) { await this.#d.store.addTokenDay(day, token, -wei); await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: `today's cap into this token across all followers (${eth(cap)} ETH) is reached` }); continue; }
      const can = await this.#d.session.canExecute(link.account, this.#d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, wei);
      if (!can.ok) { await this.#d.store.addTokenDay(day, token, -wei); await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: `your session says no: ${can.why}` }); continue; }
      const quote = await this.#d.reads.quoteBuy(token, wei);
      if (quote === null) { await this.#d.store.addTokenDay(day, token, -wei); await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, outcome: "skipped", why: "no quote right now" }); continue; }
      const minOut = minOutFor(quote, this.#d.buySlippageBps ?? 300);
      const deadline = BigInt(Math.floor(now.getTime() / 1000) + 3600);
      const data = encodeV4EthBuy({ token, amountIn: wei, minOut, deadline, ...(info.poolKey ? { poolKey: info.poolKey } : {}) });
      const r = await this.#d.session.execute(link.account, this.#d.reads.router, wei, data);
      await record({ ...base, followerTgId: f.followerTgId, ethWei: wei, hash: r.hash, outcome: r.landed ? "landed" : "sent", why: r.landed ? "" : "sent, not confirmed as landed" });
    }
    return out;
  }

  #tellText(leader: Leader, m: Mirror): string {
    const who = `<b>${leader.handle.replace(/[<>&]/g, "")}</b>`;
    if (m.outcome === "skipped") return `copy from ${who}: skipped. ${m.why}.`;
    const link = `<a href="https://robinhoodchain.blockscout.com/tx/${m.hash}">${m.hash!.slice(0, 10)}…</a>`;
    return m.outcome === "landed" ? `copied ${who}: <code>${eth(m.ethWei)} ETH</code> into <code>${m.token}</code>, landed ${link}.` : `copied ${who}: <code>${eth(m.ethWei)} ETH</code> sent ${link}, not confirmed as landed; the floor protects the fill.`;
  }
}

/** One instance's memory. */
export class MemoryCopyStore implements CopyStore {
  readonly leadersMap = new Map<string, Leader>();
  readonly follows: Follow[] = [];
  readonly days = new Map<string, bigint>();
  readonly mirrors: Mirror[] = [];
  async putLeader(l: Leader) { this.leadersMap.set(l.tgId, { ...l }); }
  async getLeader(tgId: string) { const l = this.leadersMap.get(tgId); return l ? { ...l } : undefined; }
  async leaders() { return [...this.leadersMap.values()].filter((l) => l.open).map((l) => ({ ...l })); }
  async putFollow(f: Follow) { await this.removeFollow(f.followerTgId, f.leaderTgId); this.follows.push({ ...f }); }
  async removeFollow(a: string, b: string) { const i = this.follows.findIndex((f) => f.followerTgId === a && f.leaderTgId === b); if (i >= 0) this.follows.splice(i, 1); }
  async followsOf(a: string) { return this.follows.filter((f) => f.followerTgId === a).map((f) => ({ ...f })); }
  async followersOf(b: string) { return this.follows.filter((f) => f.leaderTgId === b).map((f) => ({ ...f })); }
  async addTokenDay(day: string, token: Address, wei: bigint) { const k = `${day}|${token.toLowerCase()}`; const v = (this.days.get(k) ?? 0n) + wei; this.days.set(k, v); return v; }
  async log(m: Mirror) { this.mirrors.push({ ...m }); }
  async recent(leaderTgId: string, n: number) { return this.mirrors.filter((m) => m.leaderTgId === leaderTgId).slice(-n).reverse(); }
}

type Row = Record<string, unknown>;
export type CopySql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_leaders (tg_id TEXT PRIMARY KEY, account TEXT NOT NULL, handle TEXT NOT NULL, since TIMESTAMPTZ NOT NULL, open BOOLEAN NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_follows (follower_tg_id TEXT NOT NULL, leader_tg_id TEXT NOT NULL, cap_wei NUMERIC(40,0) NOT NULL, since TIMESTAMPTZ NOT NULL, PRIMARY KEY (follower_tg_id, leader_tg_id))`,
  `CREATE TABLE IF NOT EXISTS bot_copy_days (day TEXT NOT NULL, token TEXT NOT NULL, wei NUMERIC(40,0) NOT NULL, PRIMARY KEY (day, token))`,
  `CREATE TABLE IF NOT EXISTS bot_mirrors (id BIGSERIAL PRIMARY KEY, leader_tg_id TEXT NOT NULL, follower_tg_id TEXT NOT NULL, token TEXT NOT NULL, eth_wei NUMERIC(40,0) NOT NULL, tx_hash TEXT, outcome TEXT NOT NULL, why TEXT NOT NULL, at TIMESTAMPTZ NOT NULL)`,
];
const rowLeader = (r: Row): Leader => ({ tgId: String(r.tg_id), account: String(r.account) as Address, handle: String(r.handle), since: new Date(String(r.since)).toISOString(), open: Boolean(r.open) });
const rowFollow = (r: Row): Follow => ({ followerTgId: String(r.follower_tg_id), leaderTgId: String(r.leader_tg_id), capWei: BigInt(String(r.cap_wei)), since: new Date(String(r.since)).toISOString() });
const rowMirror = (r: Row): Mirror => ({ leaderTgId: String(r.leader_tg_id), followerTgId: String(r.follower_tg_id), token: String(r.token) as Address, ethWei: BigInt(String(r.eth_wei)), hash: r.tx_hash ? (String(r.tx_hash) as Hex) : null, outcome: String(r.outcome) as Mirror["outcome"], why: String(r.why), at: new Date(String(r.at)).toISOString() });

export class NeonCopyStore implements CopyStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: CopySql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async putLeader(l: Leader) { await this.#init(); await this.sql.query(`INSERT INTO bot_leaders (tg_id, account, handle, since, open) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tg_id) DO UPDATE SET account = EXCLUDED.account, handle = EXCLUDED.handle, open = EXCLUDED.open`, [l.tgId, l.account, l.handle, l.since, l.open]); }
  async getLeader(tgId: string) { await this.#init(); const [r] = await this.sql.query(`SELECT * FROM bot_leaders WHERE tg_id = $1`, [tgId]); return r ? rowLeader(r) : undefined; }
  async leaders() { await this.#init(); return (await this.sql.query(`SELECT * FROM bot_leaders WHERE open ORDER BY since`)).map(rowLeader); }
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
}

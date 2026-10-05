/**
 * The trading competition's entries (2026-10-01): `/join <nickname>` in the
 * mainnet bot. An entry is the Telegram id (what winners are reached by, in
 * the bot), the @username Telegram sent with the message (none for users
 * without one; it can change, so it is never what ranks or pays), and the
 * nickname the leaderboard shows. No wallet is ever shown: the scoring
 * script reads the linked account behind the id (scripts/comp-score.ts).
 */

export type CompEntry = { tgId: string; username: string | null; nickname: string; joinedAt: string };

/** "taken": another entrant has that nickname, in any case. */
export type JoinOutcome = "joined" | "renamed" | "taken";

export type CompStore = {
  join(entry: CompEntry): Promise<JoinOutcome>;
  all(): Promise<CompEntry[]>;
};

export const NICKNAME = /^[A-Za-z0-9_.-]{3,20}$/;
const key = (nickname: string): string => nickname.toLowerCase();

export class MemoryCompStore implements CompStore {
  readonly entries = new Map<string, CompEntry>();
  async join(e: CompEntry): Promise<JoinOutcome> {
    const holder = [...this.entries.values()].find((x) => key(x.nickname) === key(e.nickname));
    if (holder && holder.tgId !== e.tgId) return "taken";
    const had = this.entries.get(e.tgId);
    // A rename keeps the first join's time; the username is the latest Telegram sent.
    this.entries.set(e.tgId, { ...e, joinedAt: had?.joinedAt ?? e.joinedAt });
    return had ? "renamed" : "joined";
  }
  async all() { return [...this.entries.values()].map((e) => ({ ...e })); }
}

type Row = Record<string, unknown>;
export type CompSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_comp_entries (tg_id TEXT PRIMARY KEY, username TEXT, nickname TEXT NOT NULL, nickname_key TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bot_comp_entries_nickname ON bot_comp_entries (nickname_key)`,
];

/** Postgres's unique_violation: two entrants raced for one nickname. */
const isUniqueViolation = (e: unknown): boolean => (e as { code?: unknown }).code === "23505" || /duplicate key/i.test(String((e as Error).message ?? e));

export class NeonCompStore implements CompStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: CompSql) {}
  #init(): Promise<void> {
    return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; }));
  }
  async join(e: CompEntry): Promise<JoinOutcome> {
    await this.#init();
    const [holder] = await this.sql.query(`SELECT tg_id FROM bot_comp_entries WHERE nickname_key = $1`, [key(e.nickname)]);
    if (holder && String(holder.tg_id) !== e.tgId) return "taken";
    try {
      const [r] = await this.sql.query(
        `INSERT INTO bot_comp_entries (tg_id, username, nickname, nickname_key, joined_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username, nickname = EXCLUDED.nickname, nickname_key = EXCLUDED.nickname_key
         RETURNING (xmax = 0) AS inserted`,
        [e.tgId, e.username, e.nickname, key(e.nickname), e.joinedAt],
      );
      return r?.inserted ? "joined" : "renamed";
    } catch (error) {
      if (isUniqueViolation(error)) return "taken";
      throw error;
    }
  }
  async all() {
    await this.#init();
    return (await this.sql.query(`SELECT * FROM bot_comp_entries ORDER BY joined_at, tg_id`)).map((r) => ({
      tgId: String(r.tg_id), username: r.username === null || r.username === undefined ? null : String(r.username),
      nickname: String(r.nickname), joinedAt: new Date(String(r.joined_at)).toISOString(),
    }));
  }
}

const RULE = "a nickname is 3 to 20 letters, digits or _ . -, like <code>/join moonboy</code>.";

/** What `/join` answers: the entry made or changed, or how to make one. Linked or not decides the last line. */
export const joinReply = async (store: CompStore, from: { tgId: string; username?: string }, arg: string | undefined, linked: boolean, now: Date): Promise<string> => {
  const nickname = arg?.trim().replace(/^@/, "");
  if (!nickname) return `to enter the trading competition, send /join and the nickname the leaderboard shows. ${RULE} your wallet is never shown.`;
  if (!NICKNAME.test(nickname)) return `that nickname won't work. ${RULE}`;
  const outcome = await store.join({ tgId: from.tgId, username: from.username ?? null, nickname, joinedAt: now.toISOString() });
  if (outcome === "taken") return `<b>${nickname}</b> is taken. pick another with /join.`;
  const head = outcome === "renamed" ? `your nickname is now <b>${nickname}</b>.` : `you're in as <b>${nickname}</b>.`;
  const tail = linked ? "only trades you make in this bot during the competition count." : "connect your account with /link first: only trades you make in this bot count.";
  return `${head} ${tail}`;
};

// ---------- bug reports (/bug) ----------

export type BugReport = { tgId: string; text: string; at: string };
export type BugStore = { add(report: BugReport): Promise<void>; count(tgId: string): Promise<number> };

export class MemoryBugStore implements BugStore {
  readonly reports: BugReport[] = [];
  async add(r: BugReport) { this.reports.push({ ...r }); }
  async count(tgId: string) { return this.reports.filter((r) => r.tgId === tgId).length; }
}

export class NeonBugStore implements BugStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: CompSql) {}
  #init(): Promise<void> {
    return (this.#ready ??= this.sql.query(`CREATE TABLE IF NOT EXISTS bot_bug_reports (id BIGSERIAL PRIMARY KEY, tg_id TEXT NOT NULL, text TEXT NOT NULL, at TIMESTAMPTZ NOT NULL)`).then(() => undefined).catch((e) => { this.#ready = undefined; throw e; }));
  }
  async add(r: BugReport) { await this.#init(); await this.sql.query(`INSERT INTO bot_bug_reports (tg_id, text, at) VALUES ($1, $2, $3)`, [r.tgId, r.text, r.at]); }
  async count(tgId: string) { await this.#init(); const [r] = await this.sql.query(`SELECT count(*)::int AS n FROM bot_bug_reports WHERE tg_id = $1`, [tgId]); return Number(r?.n ?? 0); }
}

export const BUG_MAX_CHARS = 1500;

/** What /bug answers, and what the operator chat is told (undefined when nothing was filed). */
export const bugReply = async (store: BugStore, from: { tgId: string; username?: string }, text: string, nickname: string | undefined, now: Date): Promise<{ reply: string; forward?: string }> => {
  const body = text.trim();
  if (!body) return { reply: "found something broken? send /bug and what happened, in one message: what you did, what you expected, what you got. the best report of the competition takes $150." };
  if (body.length > BUG_MAX_CHARS) return { reply: `that is over ${BUG_MAX_CHARS} characters. the first message is the report; send the rest as a second /bug if it matters.` };
  await store.add({ tgId: from.tgId, text: body, at: now.toISOString() });
  const n = await store.count(from.tgId);
  const who = nickname ?? (from.username ? `@${from.username}` : `tg ${from.tgId}`);
  return {
    reply: `filed, thank you. that is your ${n === 1 ? "first" : `${n}th`} report. we read every one; the best of the week takes $150.`,
    forward: `🐞 bug from ${who} (tg ${from.tgId}, report ${n}):\n${body}`,
  };
};

// ---------- the board (/board) ----------

export type BoardLike = { ended: boolean; end: string; entrants: number; trades: number; minTrades: number; pnl: { nickname: string; pct: number; trades: number; qualified: boolean }[]; ongoing: { nickname: string; symbol: string; pct: number }[]; awards?: { prize: string; usd: number; nickname: string }[] };

const sign = (pct: number): string => `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;

/** The board as a Telegram message: top five of each, the unranked with their count toward five, the winners once it has ended. */
export const boardText = (b: BoardLike, boardUrl: string): string => {
  const lines: string[] = [b.ended ? "<b>competition over</b>" : `<b>competition · if it ended now</b>`, `${b.entrants} in, ${b.trades} trades counted`, ""];
  if (b.ended && b.awards) {
    lines.push("<b>winners</b>", ...b.awards.map((a) => `$${a.usd} ${a.prize}: <b>${esc(a.nickname)}</b>`), "");
  }
  lines.push("<b>best pnl · $500</b>");
  lines.push(...(b.pnl.length ? b.pnl.slice(0, 5).map((r, i) => `${i + 1}. ${esc(r.nickname)} <code>${sign(r.pct)}</code>${r.qualified ? "" : ` (${r.trades}/${b.minTrades} trades)`}`) : ["nobody has a counted trade yet"]));
  lines.push("", "<b>best open trade · $350</b>");
  lines.push(...(b.ongoing.length ? b.ongoing.slice(0, 5).map((r, i) => `${i + 1}. ${esc(r.nickname)} <code>${sign(r.pct)}</code> ${esc(r.symbol)}`) : ["nobody is holding a counted position yet"]));
  lines.push("", `<a href="${boardUrl}">the full board</a>`);
  return lines.join("\n");
};

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

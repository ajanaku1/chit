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

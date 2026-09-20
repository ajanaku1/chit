/**
 * One Telegram update, acted on once, for the mainnet bot. Telegram
 * redelivers an update whenever the webhook does not answer 2xx in time: a
 * function killed at its limit, a throw halfway through a request, a slow
 * receipt all look the same to it, and the same `b:<token>:<amount>` tap
 * would then run the buy again from the owner's account, and again on the
 * next retry. So the update id is claimed before anything else happens, in
 * the store every instance shares; the second delivery finds the claim and
 * does nothing. The playground bot keeps the same rule inside its wallet
 * store; this is the same table, so one bot with two floors has one claim
 * per update wherever it is routed.
 *
 * Telegram never redelivers after a day; rows older than two are dropped in
 * passing.
 */

export interface UpdateClaims {
  /** True the first time this update id is seen; false on every delivery after. Atomic. */
  claim(updateId: number, now: Date): Promise<boolean>;
}

/** One instance's memory: tests, one machine, and the floor every bot stands on when no store is wired. */
export class MemoryUpdateClaims implements UpdateClaims {
  readonly #seen = new Set<number>();
  async claim(updateId: number): Promise<boolean> {
    if (this.#seen.has(updateId)) return false;
    this.#seen.add(updateId);
    if (this.#seen.size > 10_000) this.#seen.delete(this.#seen.values().next().value as number);
    return true;
  }
}

type Row = Record<string, unknown>;
export type ClaimSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

export class NeonUpdateClaims implements UpdateClaims {
  #ready: Promise<void> | undefined;
  #claims = 0;
  constructor(private readonly sql: ClaimSql) {}
  #init(): Promise<void> {
    return (this.#ready ??= this.sql.query(`CREATE TABLE IF NOT EXISTS bot_updates (update_id BIGINT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL)`).then(() => undefined).catch((e) => { this.#ready = undefined; throw e; }));
  }
  async claim(updateId: number, now: Date): Promise<boolean> {
    await this.#init();
    const rows = await this.sql.query(`INSERT INTO bot_updates (update_id, seen_at) VALUES ($1, $2) ON CONFLICT (update_id) DO NOTHING RETURNING update_id`, [updateId, now.toISOString()]);
    if (++this.#claims % 200 === 0) {
      await this.sql.query(`DELETE FROM bot_updates WHERE seen_at < $1`, [new Date(now.getTime() - 2 * 86_400_000).toISOString()]).catch(() => undefined);
    }
    return rows.length > 0;
  }
}

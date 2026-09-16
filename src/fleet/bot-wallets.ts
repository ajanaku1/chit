/**
 * The bot's users: a testnet wallet each, made on Start, with their settings,
 * the tokens they touched, who referred them, and their fleet.
 *
 * This is the one place in Chit that holds a private key for somebody
 * else, and it is allowed to because the key can only ever hold test ETH on
 * Robinhood Chain testnet: the bot creates it, funds it from a faucet, and
 * says on the card that it is a playground key. On mainnet the same
 * buttons will drive a session on the user's own account
 * (docs/session-keys.md) and this store will hold no key.
 *
 * Sealing. Everything secret is AES-256-GCM under a key derived from the
 * host's secret with scrypt (so a guessed secret costs real work per guess,
 * not one hash), and every blob is bound to its row with the cipher's
 * associated data: a wallet key opens only as that Telegram id's wallet
 * key, a fleet key only as that id's fleet key. A copy of the table is
 * worthless on its own, and a row moved under another id does not open. The
 * blob carries a four-byte id of the sealing key, so a rotated or mistyped
 * secret says so instead of failing as a bad tag, and a canary row lets the
 * runtime check the secret before it serves anyone.
 *
 * Writes. The store never writes a whole row from an object a handler read
 * earlier: settings, tokens and the fleet are patched by column, the faucet
 * stamp is claimed atomically, Telegram updates are claimed by id, and one
 * lock per wallet serialises money across every function instance. Two
 * stores: memory for tests and one machine, Neon for the hosted bot, with
 * the same semantics (test/fleet/bot-wallet-store.test.ts runs both).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { Address, Hex } from "./types.js";

export type BotSettings = {
  /** Buy presets in ETH, as the user typed them ("0.005"). */
  buyPresets: string[];
  /** Sell presets in percent. */
  sellPresets: number[];
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Ask before every trade, Trojan's "confirm trades". */
  confirmTrades: boolean;
  /** Ask before selling more than three quarters of a position. */
  sellProtection: boolean;
};

export const DEFAULT_SETTINGS: BotSettings = {
  buyPresets: ["0.001", "0.005", "0.01"],
  sellPresets: [25, 50, 100],
  buySlippageBps: 300,
  sellSlippageBps: 300,
  confirmTrades: false,
  sellProtection: true,
};

export type BotWallet = {
  tgId: string;
  address: Address;
  /** The playground key, sealed with AAD `<tgId>|wallet`. */
  sealedKey: string;
  createdAt: string;
  /** When the faucet last topped this wallet up; null when never. */
  faucetAt: string | null;
  settings: BotSettings;
  /** Tokens this user bought or looked up, newest last; the venue token is implied. */
  tokens: Address[];
  /** The user's own referral code, from the tg id; and who referred them, if anyone. */
  refCode: string;
  referredBy: string | null;
  /** The fleet this wallet runs through the service, sealed as one blob with AAD `<tgId>|fleet` (bot-fleet.ts owns the shape). */
  fleet?: string;
};

/** What the bot keeps about a fleet, in the clear only inside a handler. */
export type FleetRecordLike = {
  campaign: string;
  /** Each key sealed with AAD `<tgId>|fleet-key`. */
  accounts: Array<{ ownerAddress: Address; sealedKey: string; salt: Hex }>;
  fleet: Address[];
  vaultCommitment: Hex;
  createdAt: string;
  state: string;
  /** The draw the fleet was activated with, in wei as a string; absent before activation. */
  draw?: string;
};

export type WalletPatch = {
  settings?: BotSettings;
  tokens?: Address[];
  /** A sealed blob, or null to clear; absent leaves the column alone. */
  fleet?: string | null;
};

/** The referral code a new row wanted is already somebody's. */
export class RefCodeTaken extends Error {
  constructor() {
    super("ref_code_taken");
    this.name = "RefCodeTaken";
  }
}

export interface BotWalletStore {
  get(tgId: string): Promise<BotWallet | undefined>;
  /** Inserts if absent and returns what is stored: on a race the first writer's row, so the caller carries on with the wallet that exists. */
  create(wallet: BotWallet): Promise<BotWallet>;
  /** Column-wise; never a whole row from an earlier read. */
  patch(tgId: string, patch: WalletPatch): Promise<void>;
  /** Stamps the faucet if the last stamp is older than `everyMs`; atomic, so a burst of taps wins once. `previous` lets a failed send give the stamp back. */
  claimFaucet(tgId: string, now: Date, everyMs: number): Promise<{ claimed: boolean; previous: string | null }>;
  restoreFaucet(tgId: string, previous: string | null): Promise<void>;
  /** Adds `wei` to the day's faucet spend if it stays within `capWei`; atomic. */
  spendFaucetBudget(day: string, wei: bigint, capWei: bigint): Promise<boolean>;
  refundFaucetBudget(day: string, wei: bigint): Promise<void>;
  /** True once per Telegram update id: a redelivery is refused. */
  claimUpdate(updateId: number, now: Date): Promise<boolean>;
  /** A lease on `key` until `now + ttlMs`; false while somebody else holds it. */
  lock(key: string, now: Date, ttlMs: number): Promise<boolean>;
  unlock(key: string): Promise<void>;
  /** Small named values; the sealing canary lives here. `setMeta` keeps the first value written. */
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  byRefCode(code: string): Promise<BotWallet | undefined>;
  referralsOf(refCode: string): Promise<number>;
  count(): Promise<number>;
}

// ---------- sealing ----------

export class SealError extends Error {
  readonly code: "format" | "secret_mismatch" | "tampered";
  constructor(code: "format" | "secret_mismatch" | "tampered") {
    super(`seal_${code}`);
    this.name = "SealError";
    this.code = code;
  }
}

const KDF_SALT = "chit-bot-wallets-v2";
const derived = new Map<string, Buffer>();
/** scrypt, N=2^15: about 60 ms and 32 MB once per secret per instance, and that much per guess for anyone holding a dump. */
const keyOf = (secret: string): Buffer => {
  let key = derived.get(secret);
  if (!key) {
    key = scryptSync(secret, KDF_SALT, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    derived.set(secret, key);
  }
  return key;
};
const keyIdOf = (secret: string): Buffer => createHash("sha256").update(keyOf(secret)).digest().subarray(0, 4);

/** A secret has to be long and not a keyboard mash: 32+ characters with at least twelve distinct ones. */
export const secretIsStrong = (secret: string): boolean => secret.length >= 32 && new Set(secret).size >= 12;

/** `v2.` ++ base64(keyId(4) ++ iv(12) ++ tag(16) ++ ciphertext); `aad` binds the blob to its row and purpose. */
export const seal = (plaintext: Buffer, secret: string, aad: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const out = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v2.${Buffer.concat([keyIdOf(secret), iv, cipher.getAuthTag(), out]).toString("base64")}`;
};

export const open = (sealed: string, secret: string, aad: string): Buffer => {
  if (!sealed.startsWith("v2.")) throw new SealError("format");
  const buf = Buffer.from(sealed.slice(3), "base64");
  if (buf.length < 4 + 12 + 16) throw new SealError("format");
  if (!timingSafeEqual(buf.subarray(0, 4), keyIdOf(secret))) throw new SealError("secret_mismatch");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), buf.subarray(4, 16));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(16, 32));
  try {
    return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
  } catch {
    throw new SealError("tampered");
  }
};

export const sealKey = (privateKey: Hex, secret: string, aad: string): string => seal(Buffer.from(privateKey.slice(2), "hex"), secret, aad);
export const openKey = (sealed: string, secret: string, aad: string): Hex => `0x${open(sealed, secret, aad).toString("hex")}`;

export const walletAad = (tgId: string): string => `${tgId}|wallet`;
export const fleetKeyAad = (tgId: string): string => `${tgId}|fleet-key`;
export const fleetAad = (tgId: string): string => `${tgId}|fleet`;

export const CANARY_KEY = "canary";
const CANARY_TEXT = "chit-bot-canary";
export const sealCanary = (secret: string): string => seal(Buffer.from(CANARY_TEXT, "utf8"), secret, CANARY_KEY);
/** True when `sealed` was made under `secret`; a SealError otherwise, with the reason. */
export const checkCanary = (sealed: string, secret: string): boolean => open(sealed, secret, CANARY_KEY).toString("utf8") === CANARY_TEXT;

/** A short code nobody can turn back into a Telegram id: eight hex of a keyed hash; `attempt` steps past a collision. */
export const refCodeOf = (tgId: string, secret: string, attempt = 0): string =>
  createHash("sha256").update(`chit-bot-ref-v1|${secret}|${tgId}|${attempt || ""}`).digest("hex").slice(0, 8);

export const withDefaults = (w: Partial<BotWallet> & Pick<BotWallet, "tgId" | "address" | "sealedKey" | "createdAt">): BotWallet => {
  const { settings, ...rest } = w;
  return {
    faucetAt: null,
    tokens: [],
    refCode: "",
    referredBy: null,
    ...rest,
    settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
  };
};

// ---------- memory ----------

export class MemoryBotWalletStore implements BotWalletStore {
  readonly #wallets = new Map<string, BotWallet>();
  readonly #days = new Map<string, bigint>();
  readonly #updates = new Set<number>();
  readonly #locks = new Map<string, number>();
  readonly #meta = new Map<string, string>();

  async get(tgId: string): Promise<BotWallet | undefined> {
    const w = this.#wallets.get(tgId);
    return w ? structuredClone(w) : undefined;
  }
  async create(wallet: BotWallet): Promise<BotWallet> {
    const existing = this.#wallets.get(wallet.tgId);
    if (existing) return structuredClone(existing);
    for (const w of this.#wallets.values()) if (w.refCode && w.refCode === wallet.refCode) throw new RefCodeTaken();
    this.#wallets.set(wallet.tgId, structuredClone(wallet));
    return structuredClone(wallet);
  }
  async patch(tgId: string, patch: WalletPatch): Promise<void> {
    const w = this.#wallets.get(tgId);
    if (!w) return;
    if (patch.settings) w.settings = structuredClone(patch.settings);
    if (patch.tokens) w.tokens = [...patch.tokens];
    if (patch.fleet !== undefined) {
      if (patch.fleet === null) delete w.fleet;
      else w.fleet = patch.fleet;
    }
  }
  async claimFaucet(tgId: string, now: Date, everyMs: number): Promise<{ claimed: boolean; previous: string | null }> {
    const w = this.#wallets.get(tgId);
    if (!w) return { claimed: false, previous: null };
    const previous = w.faucetAt;
    if (previous && Date.parse(previous) > now.getTime() - everyMs) return { claimed: false, previous };
    w.faucetAt = now.toISOString();
    return { claimed: true, previous };
  }
  async restoreFaucet(tgId: string, previous: string | null): Promise<void> {
    const w = this.#wallets.get(tgId);
    if (w) w.faucetAt = previous;
  }
  async spendFaucetBudget(day: string, wei: bigint, capWei: bigint): Promise<boolean> {
    const spent = this.#days.get(day) ?? 0n;
    if (spent + wei > capWei) return false;
    this.#days.set(day, spent + wei);
    return true;
  }
  async refundFaucetBudget(day: string, wei: bigint): Promise<void> {
    const spent = this.#days.get(day) ?? 0n;
    this.#days.set(day, spent > wei ? spent - wei : 0n);
  }
  async claimUpdate(updateId: number): Promise<boolean> {
    if (this.#updates.has(updateId)) return false;
    this.#updates.add(updateId);
    if (this.#updates.size > 10_000) this.#updates.delete(this.#updates.values().next().value as number);
    return true;
  }
  async lock(key: string, now: Date, ttlMs: number): Promise<boolean> {
    const until = this.#locks.get(key);
    if (until !== undefined && until > now.getTime()) return false;
    this.#locks.set(key, now.getTime() + ttlMs);
    return true;
  }
  async unlock(key: string): Promise<void> {
    this.#locks.delete(key);
  }
  async getMeta(key: string): Promise<string | undefined> {
    return this.#meta.get(key);
  }
  async setMeta(key: string, value: string): Promise<void> {
    if (!this.#meta.has(key)) this.#meta.set(key, value);
  }
  async byRefCode(code: string): Promise<BotWallet | undefined> {
    for (const w of this.#wallets.values()) if (w.refCode === code) return structuredClone(w);
    return undefined;
  }
  async referralsOf(refCode: string): Promise<number> {
    let n = 0;
    for (const w of this.#wallets.values()) if (w.referredBy === refCode) n += 1;
    return n;
  }
  async count(): Promise<number> {
    return this.#wallets.size;
  }
}

// ---------- Neon ----------

export interface BotSql {
  query(query: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]>;
}

/**
 * One statement per query: Neon's HTTP driver runs the extended protocol,
 * which takes exactly one command per request.
 */
const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS bot_wallets (
    tg_id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    sealed_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    faucet_at TIMESTAMPTZ,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
    ref_code TEXT NOT NULL,
    referred_by TEXT,
    fleet TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bot_wallets_ref_code ON bot_wallets (ref_code)`,
  `CREATE INDEX IF NOT EXISTS bot_wallets_referred_by ON bot_wallets (referred_by)`,
  `CREATE TABLE IF NOT EXISTS bot_faucet_days (day TEXT PRIMARY KEY, spent NUMERIC(40, 0) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_updates (update_id BIGINT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_locks (key TEXT PRIMARY KEY, until TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
};

const isUniqueViolation = (error: unknown, index: string): boolean => {
  const e = error as { code?: string; message?: string; constraint?: string };
  return e?.code === "23505" && (e.constraint === index || (e.message ?? "").includes(index));
};

export class NeonBotWalletStore implements BotWalletStore {
  readonly #sql: BotSql;
  #ready: Promise<void> | undefined;
  #claims = 0;
  constructor(sql: BotSql) {
    this.#sql = sql;
  }
  /** The schema, once per instance; a failure is not remembered, so the next call tries again. */
  #init(): Promise<void> {
    this.#ready ??= (async () => {
      for (const statement of SCHEMA) await this.#sql.query(statement);
    })().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }
  #row(r: Record<string, unknown>): BotWallet {
    const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
    return withDefaults({
      tgId: String(r["tg_id"]),
      address: String(r["address"]) as Address,
      sealedKey: String(r["sealed_key"]),
      createdAt: iso(r["created_at"]),
      faucetAt: r["faucet_at"] ? iso(r["faucet_at"]) : null,
      settings: json<Partial<BotSettings>>(r["settings"], {}) as BotSettings,
      tokens: json<Address[]>(r["tokens"], []),
      refCode: String(r["ref_code"] ?? ""),
      referredBy: r["referred_by"] ? String(r["referred_by"]) : null,
      ...(r["fleet"] ? { fleet: String(r["fleet"]) } : {}),
    });
  }
  async get(tgId: string): Promise<BotWallet | undefined> {
    await this.#init();
    const rows = await this.#sql.query("SELECT * FROM bot_wallets WHERE tg_id = $1", [tgId]);
    return rows[0] ? this.#row(rows[0]) : undefined;
  }
  async create(w: BotWallet): Promise<BotWallet> {
    await this.#init();
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await this.#sql.query(
        `INSERT INTO bot_wallets (tg_id, address, sealed_key, created_at, faucet_at, settings, tokens, ref_code, referred_by, fleet)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
         ON CONFLICT (tg_id) DO NOTHING
         RETURNING *`,
        [w.tgId, w.address, w.sealedKey, w.createdAt, w.faucetAt, JSON.stringify(w.settings), JSON.stringify(w.tokens), w.refCode, w.referredBy, w.fleet ?? null],
      );
    } catch (error) {
      if (isUniqueViolation(error, "bot_wallets_ref_code")) throw new RefCodeTaken();
      throw error;
    }
    if (rows[0]) return this.#row(rows[0]);
    const existing = await this.get(w.tgId);
    if (!existing) throw new Error("bot_wallets: insert did nothing and the row is missing");
    return existing;
  }
  async patch(tgId: string, patch: WalletPatch): Promise<void> {
    await this.#init();
    const sets: string[] = [];
    const params: unknown[] = [tgId];
    if (patch.settings) { params.push(JSON.stringify(patch.settings)); sets.push(`settings = $${params.length}::jsonb`); }
    if (patch.tokens) { params.push(JSON.stringify(patch.tokens)); sets.push(`tokens = $${params.length}::jsonb`); }
    if (patch.fleet !== undefined) { params.push(patch.fleet); sets.push(`fleet = $${params.length}`); }
    if (!sets.length) return;
    await this.#sql.query(`UPDATE bot_wallets SET ${sets.join(", ")} WHERE tg_id = $1`, params);
  }
  async claimFaucet(tgId: string, now: Date, everyMs: number): Promise<{ claimed: boolean; previous: string | null }> {
    await this.#init();
    const rows = await this.#sql.query(
      `WITH before AS (SELECT faucet_at FROM bot_wallets WHERE tg_id = $1),
            won AS (UPDATE bot_wallets SET faucet_at = $2 WHERE tg_id = $1 AND (faucet_at IS NULL OR faucet_at <= $3) RETURNING tg_id)
       SELECT (SELECT faucet_at FROM before) AS previous, EXISTS (SELECT 1 FROM won) AS claimed`,
      [tgId, now.toISOString(), new Date(now.getTime() - everyMs).toISOString()],
    );
    const r = rows[0];
    const previous = r?.["previous"];
    return { claimed: Boolean(r?.["claimed"]), previous: previous ? (previous instanceof Date ? previous.toISOString() : new Date(String(previous)).toISOString()) : null };
  }
  async restoreFaucet(tgId: string, previous: string | null): Promise<void> {
    await this.#init();
    await this.#sql.query("UPDATE bot_wallets SET faucet_at = $2 WHERE tg_id = $1", [tgId, previous]);
  }
  async spendFaucetBudget(day: string, wei: bigint, capWei: bigint): Promise<boolean> {
    await this.#init();
    if (wei > capWei) return false;
    const rows = await this.#sql.query(
      `INSERT INTO bot_faucet_days (day, spent) VALUES ($1, $2::numeric)
       ON CONFLICT (day) DO UPDATE SET spent = bot_faucet_days.spent + EXCLUDED.spent
       WHERE bot_faucet_days.spent + EXCLUDED.spent <= $3::numeric
       RETURNING spent`,
      [day, wei.toString(), capWei.toString()],
    );
    return rows.length > 0;
  }
  async refundFaucetBudget(day: string, wei: bigint): Promise<void> {
    await this.#init();
    await this.#sql.query("UPDATE bot_faucet_days SET spent = GREATEST(spent - $2::numeric, 0) WHERE day = $1", [day, wei.toString()]);
  }
  async claimUpdate(updateId: number, now: Date): Promise<boolean> {
    await this.#init();
    const rows = await this.#sql.query(
      "INSERT INTO bot_updates (update_id, seen_at) VALUES ($1, $2) ON CONFLICT (update_id) DO NOTHING RETURNING update_id",
      [updateId, now.toISOString()],
    );
    // Telegram never redelivers after a day; the table is kept small in passing.
    if (++this.#claims % 200 === 0) {
      await this.#sql.query("DELETE FROM bot_updates WHERE seen_at < $1", [new Date(now.getTime() - 2 * 86_400_000).toISOString()]).catch(() => undefined);
    }
    return rows.length > 0;
  }
  async lock(key: string, now: Date, ttlMs: number): Promise<boolean> {
    await this.#init();
    const rows = await this.#sql.query(
      `INSERT INTO bot_locks (key, until) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET until = EXCLUDED.until WHERE bot_locks.until <= $3
       RETURNING key`,
      [key, new Date(now.getTime() + ttlMs).toISOString(), now.toISOString()],
    );
    return rows.length > 0;
  }
  async unlock(key: string): Promise<void> {
    await this.#init();
    await this.#sql.query("DELETE FROM bot_locks WHERE key = $1", [key]);
  }
  async getMeta(key: string): Promise<string | undefined> {
    await this.#init();
    const rows = await this.#sql.query("SELECT value FROM bot_meta WHERE key = $1", [key]);
    return rows[0] ? String(rows[0]["value"]) : undefined;
  }
  async setMeta(key: string, value: string): Promise<void> {
    await this.#init();
    await this.#sql.query("INSERT INTO bot_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, value]);
  }
  async byRefCode(code: string): Promise<BotWallet | undefined> {
    await this.#init();
    const rows = await this.#sql.query("SELECT * FROM bot_wallets WHERE ref_code = $1 LIMIT 1", [code]);
    return rows[0] ? this.#row(rows[0]) : undefined;
  }
  async referralsOf(refCode: string): Promise<number> {
    await this.#init();
    const rows = await this.#sql.query("SELECT COUNT(*) AS n FROM bot_wallets WHERE referred_by = $1", [refCode]);
    return Number(rows[0]?.["n"] ?? 0);
  }
  async count(): Promise<number> {
    await this.#init();
    const rows = await this.#sql.query("SELECT COUNT(*) AS n FROM bot_wallets");
    return Number(rows[0]?.["n"] ?? 0);
  }
}

/**
 * The bot's users: a testnet wallet each, made on Start, with their settings,
 * the tokens they touched, and who referred them.
 *
 * This is the one place in Chit that holds a private key for somebody
 * else, and it is allowed to because the key can only ever hold test ETH on
 * Robinhood Chain testnet: the bot creates it, funds it from a faucet, and
 * says on the card that it is a playground key. On mainnet the same
 * buttons drive a session on the user's own account (docs/session-keys.md)
 * and this store holds no key.
 *
 * Keys are sealed at rest with AES-256-GCM under a secret the host holds,
 * so a copy of the table is worthless on its own. Two stores: memory for
 * tests and one machine, Neon for the hosted bot, so a user meets the same
 * wallet whichever function instance answers.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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
  /** The fleet this wallet runs through the service, if any (bot-fleet.ts). */
  fleet?: FleetRecordLike;
};

/** What the store keeps about a fleet; bot-fleet.ts owns the shape, this is the storage view. */
export type FleetRecordLike = {
  campaign: string;
  accounts: Array<{ ownerAddress: Address; sealedKey: string; salt: Hex }>;
  fleet: Address[];
  vaultCommitment: Hex;
  createdAt: string;
  state: string;
};

export interface BotWalletStore {
  get(tgId: string): Promise<BotWallet | undefined>;
  put(wallet: BotWallet): Promise<void>;
  byRefCode(code: string): Promise<BotWallet | undefined>;
  referralsOf(refCode: string): Promise<number>;
  count(): Promise<number>;
}

const keyOf = (secret: string): Buffer => createHash("sha256").update(`chit-bot-wallets-v1|${secret}`).digest();

/** iv(12) ++ tag(16) ++ ciphertext, base64. */
export const sealKey = (privateKey: Hex, secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const out = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), out]).toString("base64");
};

export const openKey = (sealed: string, secret: string): Hex => {
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), iv);
  decipher.setAuthTag(tag);
  return `0x${Buffer.concat([decipher.update(data), decipher.final()]).toString("hex")}`;
};

/** A short code nobody can turn back into a Telegram id: the first eight hex of a keyed hash. */
export const refCodeOf = (tgId: string, secret: string): string =>
  createHash("sha256").update(`chit-bot-ref-v1|${secret}|${tgId}`).digest("hex").slice(0, 8);

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

export class MemoryBotWalletStore implements BotWalletStore {
  readonly #wallets = new Map<string, BotWallet>();
  async get(tgId: string): Promise<BotWallet | undefined> {
    const w = this.#wallets.get(tgId);
    return w ? structuredClone(w) : undefined;
  }
  async put(wallet: BotWallet): Promise<void> {
    this.#wallets.set(wallet.tgId, structuredClone(wallet));
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

export interface BotSql {
  query(query: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_wallets (
    tg_id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    sealed_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    faucet_at TIMESTAMPTZ,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
    ref_code TEXT NOT NULL DEFAULT '',
    referred_by TEXT,
    fleet JSONB
  );
  ALTER TABLE bot_wallets ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE bot_wallets ADD COLUMN IF NOT EXISTS tokens JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE bot_wallets ADD COLUMN IF NOT EXISTS ref_code TEXT NOT NULL DEFAULT '';
  ALTER TABLE bot_wallets ADD COLUMN IF NOT EXISTS referred_by TEXT;
  ALTER TABLE bot_wallets ADD COLUMN IF NOT EXISTS fleet JSONB;
  CREATE INDEX IF NOT EXISTS bot_wallets_ref_code ON bot_wallets (ref_code);
  CREATE INDEX IF NOT EXISTS bot_wallets_referred_by ON bot_wallets (referred_by);
`;

const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
};

export class NeonBotWalletStore implements BotWalletStore {
  readonly #sql: BotSql;
  #ready: Promise<void> | undefined;
  constructor(sql: BotSql) {
    this.#sql = sql;
  }
  #init(): Promise<void> {
    this.#ready ??= this.#sql.query(SCHEMA).then(() => undefined);
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
      ...(r["fleet"] ? { fleet: json<FleetRecordLike>(r["fleet"], undefined as never) } : {}),
    });
  }
  async get(tgId: string): Promise<BotWallet | undefined> {
    await this.#init();
    const rows = await this.#sql.query("SELECT * FROM bot_wallets WHERE tg_id = $1", [tgId]);
    return rows[0] ? this.#row(rows[0]) : undefined;
  }
  async put(w: BotWallet): Promise<void> {
    await this.#init();
    await this.#sql.query(
      `INSERT INTO bot_wallets (tg_id, address, sealed_key, created_at, faucet_at, settings, tokens, ref_code, referred_by, fleet)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb)
       ON CONFLICT (tg_id) DO UPDATE SET faucet_at = EXCLUDED.faucet_at, settings = EXCLUDED.settings, tokens = EXCLUDED.tokens, referred_by = COALESCE(bot_wallets.referred_by, EXCLUDED.referred_by), fleet = EXCLUDED.fleet`,
      [w.tgId, w.address, w.sealedKey, w.createdAt, w.faucetAt, JSON.stringify(w.settings), JSON.stringify(w.tokens), w.refCode, w.referredBy, w.fleet ? JSON.stringify(w.fleet) : null],
    );
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

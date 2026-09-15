/**
 * The bot's testnet wallets: one per Telegram user, made on /start.
 *
 * This is the one place in Chit that holds a private key for somebody
 * else, and it is allowed to because the key can only ever hold test ETH on
 * Robinhood Chain testnet: the bot creates it, funds it from a faucet, and
 * says on the card that it is a playground key. On mainnet the same
 * buttons drive a session on the user's own account (docs/session-keys.md)
 * and this store has no role.
 *
 * Keys are sealed at rest with AES-256-GCM under a secret the host holds,
 * so a copy of the table is worthless on its own. Two stores: memory for
 * tests and one machine, Neon for the hosted bot, so a user meets the same
 * wallet whichever function instance answers.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { Address, Hex } from "./types.js";

export type BotWallet = {
  tgId: string;
  address: Address;
  sealedKey: string;
  createdAt: string;
  /** When the faucet last topped this wallet up; null when never. */
  faucetAt: string | null;
};

export interface BotWalletStore {
  get(tgId: string): Promise<BotWallet | undefined>;
  put(wallet: BotWallet): Promise<void>;
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

export class MemoryBotWalletStore implements BotWalletStore {
  readonly #wallets = new Map<string, BotWallet>();
  async get(tgId: string): Promise<BotWallet | undefined> {
    const w = this.#wallets.get(tgId);
    return w ? { ...w } : undefined;
  }
  async put(wallet: BotWallet): Promise<void> {
    this.#wallets.set(wallet.tgId, { ...wallet });
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
    faucet_at TIMESTAMPTZ
  );
`;

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
  async get(tgId: string): Promise<BotWallet | undefined> {
    await this.#init();
    const rows = await this.#sql.query("SELECT * FROM bot_wallets WHERE tg_id = $1", [tgId]);
    const r = rows[0];
    if (!r) return undefined;
    const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
    return {
      tgId: String(r["tg_id"]),
      address: String(r["address"]) as Address,
      sealedKey: String(r["sealed_key"]),
      createdAt: iso(r["created_at"]),
      faucetAt: r["faucet_at"] ? iso(r["faucet_at"]) : null,
    };
  }
  async put(w: BotWallet): Promise<void> {
    await this.#init();
    await this.#sql.query(
      `INSERT INTO bot_wallets (tg_id, address, sealed_key, created_at, faucet_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tg_id) DO UPDATE SET faucet_at = EXCLUDED.faucet_at`,
      [w.tgId, w.address, w.sealedKey, w.createdAt, w.faucetAt],
    );
  }
  async count(): Promise<number> {
    await this.#init();
    const rows = await this.#sql.query("SELECT COUNT(*) AS n FROM bot_wallets");
    return Number(rows[0]?.["n"] ?? 0);
  }
}

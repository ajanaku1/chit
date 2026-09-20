/**
 * The link between a Telegram user and their session account, for the bot's
 * mainnet mode (docs/bot-mainnet-mode.md, "Linking a Telegram user to their
 * account"). A session is granted to the bot's key on chain, and the contract
 * does not know Telegram ids; if the bot simply believed "my account is 0x…"
 * anyone could name another owner's account and trade from it within its
 * caps. So the link is signed by the owner:
 *
 *   1. the bot mints a nonce for the Telegram id (random, fifteen minutes)
 *      and sends the owner to the Sessions page with it;
 *   2. the page asks the wallet to sign `chit-bot-link|<chainId>|<account>|<nonce>`
 *      and posts { nonce, account, signature };
 *   3. `verifyLink` recovers the signer, checks it is the account's owner
 *      on chain, checks the nonce is fresh and unused, and stores tgId → account.
 *
 * The last valid link wins; re-linking is the same flow. Nothing here holds
 * a key: the store keeps the Telegram id, the account, and the proof.
 *
 * The store also claims Telegram update ids for the mainnet bot, the way the
 * playground's wallet store does for its own: a webhook request the host
 * kills mid-trade makes Telegram deliver the same update again, and a Sell
 * acted on twice is a share sold twice. The first claim wins; a repeat is
 * dropped without a word.
 */

import { randomBytes } from "node:crypto";
import { type Address, type Hex, getAddress, isAddress, isHex, recoverMessageAddress } from "viem";

export const NONCE_TTL_MS = 15 * 60 * 1000;

export type LinkNonce = { nonce: string; tgId: string; issuedAt: string; usedAt: string | null };
export type BotLink = { tgId: string; account: Address; owner: Address; chainId: number; nonce: string; signature: Hex; linkedAt: string };

export interface BotLinkStore {
  putNonce(n: LinkNonce): Promise<void>;
  getNonce(nonce: string): Promise<LinkNonce | undefined>;
  /** Marks the nonce used; false when it was already used (a replay). Atomic. */
  useNonce(nonce: string, at: Date): Promise<boolean>;
  putLink(link: BotLink): Promise<void>;
  getLink(tgId: string): Promise<BotLink | undefined>;
  /** Every Telegram id linked to this account, for the "which telegram" question. */
  linksTo(account: Address): Promise<BotLink[]>;
  /** Claims a Telegram update id; false when it was seen before (a redelivery). Atomic across instances. */
  claimUpdate(updateId: number, now: Date): Promise<boolean>;
}

/** The exact text the owner's wallet signs. The chain id is in it so a testnet link never opens a mainnet account. */
export const linkMessage = (chainId: number, account: Address, nonce: string): string => `chit-bot-link|${chainId}|${getAddress(account)}|${nonce}`;

export const newNonce = (): string => randomBytes(16).toString("hex");

export class LinkError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type LinkRequest = { nonce: unknown; account: unknown; signature: unknown };

/** Mint a nonce for a Telegram id and remember it. The URL the bot sends carries it. */
export const issueNonce = async (store: BotLinkStore, tgId: string, now: Date): Promise<string> => {
  const nonce = newNonce();
  await store.putNonce({ nonce, tgId, issuedAt: now.toISOString(), usedAt: null });
  return nonce;
};

/**
 * Verify a posted link and store it. `ownerOf` reads `owner()` on the account
 * (a contract that has none, or is not deployed, answers undefined). Order
 * matters: cheap checks first, the chain read last, the nonce consumed only
 * once everything else holds, so a bad signature cannot burn a good nonce.
 */
export const verifyLink = async (
  store: BotLinkStore, chainId: number, req: LinkRequest, ownerOf: (account: Address) => Promise<Address | undefined>, now: Date,
): Promise<BotLink> => {
  const { nonce, account, signature } = req;
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) throw new LinkError(400, "nonce is not one of ours");
  if (typeof account !== "string" || !isAddress(account)) throw new LinkError(400, "account must be a 0x address");
  if (typeof signature !== "string" || !isHex(signature) || signature.length !== 132) throw new LinkError(400, "signature must be 65 bytes of hex");
  const n = await store.getNonce(nonce);
  if (!n) throw new LinkError(404, "nonce unknown: open the link from the bot again");
  if (n.usedAt) throw new LinkError(409, "this link was already used: ask the bot for a new one");
  if (now.getTime() - Date.parse(n.issuedAt) > NONCE_TTL_MS) throw new LinkError(410, "this link expired: ask the bot for a new one");
  let signer: Address;
  try { signer = await recoverMessageAddress({ message: linkMessage(chainId, account, nonce), signature: signature as Hex }); }
  catch { throw new LinkError(400, "the signature does not decode"); }
  const owner = await ownerOf(getAddress(account));
  if (!owner) throw new LinkError(404, "no session account at that address on this chain");
  if (getAddress(owner) !== getAddress(signer)) throw new LinkError(403, "the signature is not the account owner's");
  if (!(await store.useNonce(nonce, now))) throw new LinkError(409, "this link was already used: ask the bot for a new one");
  const link: BotLink = { tgId: n.tgId, account: getAddress(account), owner: getAddress(owner), chainId, nonce, signature: signature as Hex, linkedAt: now.toISOString() };
  await store.putLink(link);
  return link;
};

/** One instance's memory: tests and one machine. */
export class MemoryBotLinkStore implements BotLinkStore {
  readonly nonces = new Map<string, LinkNonce>();
  readonly links = new Map<string, BotLink>();
  readonly #updates = new Set<number>();
  async putNonce(n: LinkNonce) { this.nonces.set(n.nonce, { ...n }); }
  async getNonce(nonce: string) { const n = this.nonces.get(nonce); return n ? { ...n } : undefined; }
  async useNonce(nonce: string, at: Date) {
    const n = this.nonces.get(nonce);
    if (!n || n.usedAt) return false;
    n.usedAt = at.toISOString();
    return true;
  }
  async putLink(link: BotLink) { this.links.set(link.tgId, { ...link }); }
  async getLink(tgId: string) { const l = this.links.get(tgId); return l ? { ...l } : undefined; }
  async linksTo(account: Address) { const a = getAddress(account); return [...this.links.values()].filter((l) => l.account === a).map((l) => ({ ...l })); }
  async claimUpdate(updateId: number) {
    if (this.#updates.has(updateId)) return false;
    this.#updates.add(updateId);
    if (this.#updates.size > 10_000) this.#updates.delete(this.#updates.values().next().value as number);
    return true;
  }
}

type Row = Record<string, unknown>;
export type LinkSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

const LINK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_link_nonces (nonce TEXT PRIMARY KEY, tg_id TEXT NOT NULL, issued_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS bot_links (tg_id TEXT PRIMARY KEY, account TEXT NOT NULL, owner TEXT NOT NULL, chain_id INTEGER NOT NULL, nonce TEXT NOT NULL, signature TEXT NOT NULL, linked_at TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bot_links_account ON bot_links (account)`,
  `CREATE TABLE IF NOT EXISTS bot_link_updates (update_id BIGINT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL)`,
];

const rowLink = (r: Row): BotLink => ({
  tgId: String(r.tg_id), account: getAddress(String(r.account)), owner: getAddress(String(r.owner)), chainId: Number(r.chain_id),
  nonce: String(r.nonce), signature: String(r.signature) as Hex, linkedAt: new Date(String(r.linked_at)).toISOString(),
});

/** Neon: the same tables the bot's store lives beside; the schema is applied once per instance. */
export class NeonBotLinkStore implements BotLinkStore {
  #ready: Promise<void> | undefined;
  #claims = 0;
  constructor(private readonly sql: LinkSql) {}
  #init(): Promise<void> {
    return (this.#ready ??= (async () => { for (const s of LINK_SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; }));
  }
  async putNonce(n: LinkNonce) {
    await this.#init();
    await this.sql.query(`INSERT INTO bot_link_nonces (nonce, tg_id, issued_at, used_at) VALUES ($1, $2, $3, NULL)`, [n.nonce, n.tgId, n.issuedAt]);
  }
  async getNonce(nonce: string) {
    await this.#init();
    const [r] = await this.sql.query(`SELECT nonce, tg_id, issued_at, used_at FROM bot_link_nonces WHERE nonce = $1`, [nonce]);
    return r ? { nonce: String(r.nonce), tgId: String(r.tg_id), issuedAt: new Date(String(r.issued_at)).toISOString(), usedAt: r.used_at ? new Date(String(r.used_at)).toISOString() : null } : undefined;
  }
  async useNonce(nonce: string, at: Date) {
    await this.#init();
    const rows = await this.sql.query(`UPDATE bot_link_nonces SET used_at = $2 WHERE nonce = $1 AND used_at IS NULL RETURNING nonce`, [nonce, at.toISOString()]);
    return rows.length === 1;
  }
  async putLink(l: BotLink) {
    await this.#init();
    await this.sql.query(
      `INSERT INTO bot_links (tg_id, account, owner, chain_id, nonce, signature, linked_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tg_id) DO UPDATE SET account = EXCLUDED.account, owner = EXCLUDED.owner, chain_id = EXCLUDED.chain_id, nonce = EXCLUDED.nonce, signature = EXCLUDED.signature, linked_at = EXCLUDED.linked_at`,
      [l.tgId, l.account, l.owner, l.chainId, l.nonce, l.signature, l.linkedAt],
    );
  }
  async getLink(tgId: string) {
    await this.#init();
    const [r] = await this.sql.query(`SELECT * FROM bot_links WHERE tg_id = $1`, [tgId]);
    return r ? rowLink(r) : undefined;
  }
  async linksTo(account: Address) {
    await this.#init();
    return (await this.sql.query(`SELECT * FROM bot_links WHERE account = $1`, [getAddress(account)])).map(rowLink);
  }
  async claimUpdate(updateId: number, now: Date) {
    await this.#init();
    const rows = await this.sql.query(`INSERT INTO bot_link_updates (update_id, seen_at) VALUES ($1, $2) ON CONFLICT (update_id) DO NOTHING RETURNING update_id`, [updateId, now.toISOString()]);
    // Telegram never redelivers after a day; the table is kept small in passing.
    if (++this.#claims % 200 === 0) {
      await this.sql.query(`DELETE FROM bot_link_updates WHERE seen_at < $1`, [new Date(now.getTime() - 2 * 86_400_000).toISOString()]).catch(() => undefined);
    }
    return rows.length === 1;
  }
}

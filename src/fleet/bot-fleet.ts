/**
 * The fleet from the chat: Chit's own product driven by the playground wallet.
 *
 * The app's journey, step for step, with the bot as the browser: deposit
 * into the pool (a transaction from the wallet), create a fleet (five fresh
 * accounts, a vault commitment, the signed `create` and `confirmRecovery`),
 * activate with a draw, buy through the router from every fleet wallet,
 * watch the control room, pause, resume, close. Every signed action goes
 * through the hosted service's challenge flow, signed by the playground key
 * the way the wallet signs in the browser; the service is the same one the
 * app talks to, at chit.tools, and it decides everything money-shaped.
 *
 * The fleet accounts' keys are generated here and sealed like the wallet's.
 * They matter only for recovery (withdrawing what a fleet wallet holds
 * after a close), which is a later button; the operator executes the buys.
 *
 * Idempotency keys are derived from the Telegram callback that asked, so a
 * redelivered update or a second tap on the same button replays the same
 * key and the service answers once (FR-014), instead of a fresh random key
 * per call that let every retry act again.
 */

import { keccak256, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { FleetRecordLike } from "./bot-wallets.js";
import type { Address, Hex } from "./types.js";

export type FleetRoute = "campaign" | "buy" | "control" | "balance";
export type ApiResult = { status: number; body: Record<string, unknown> };

/** The hosted fleet service, as the bot calls it. A fake in tests, fetch in production. */
export interface FleetApi {
  call(route: FleetRoute, payload: { action: string; auth?: unknown; body: unknown }, idempotencyKey?: string): Promise<ApiResult>;
}

export type FleetRecord = FleetRecordLike;

const routeOf = (action: string): FleetRoute =>
  ["pause", "resume", "revoke", "close"].includes(action) ? "control"
    : ["balance", "withdraw"].includes(action) ? "balance"
      : action === "buy" ? "buy"
        : "campaign";

const IDEMPOTENT = new Set(["create", "confirmRecovery", "fund", "activate", "topUp", "buy", "pause", "resume", "revoke", "close", "withdraw"]);

export class FleetError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`${code} (${status})`);
    this.name = "FleetError";
    this.status = status;
    this.code = code;
  }
}

export const createFetchFleetApi = (siteUrl: string): FleetApi => ({
  async call(route, payload, idempotencyKey) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const r = await fetch(`${siteUrl.replace(/\/+$/, "")}/api/fleet/${route}`, { method: "POST", headers, body: JSON.stringify(payload) });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, body };
  },
});

/**
 * Drives the service for one playground wallet. `sign` is the wallet's
 * EIP-191 signer over the challenge text, the same bytes the browser's
 * personal_sign covers.
 */
export class FleetDriver {
  readonly #api: FleetApi;
  readonly #sign: (message: string) => Promise<Hex>;
  readonly #wallet: Address;
  readonly #now: () => Date;

  constructor(api: FleetApi, wallet: Address, sign: (message: string) => Promise<Hex>, now: () => Date = () => new Date()) {
    this.#api = api;
    this.#wallet = wallet;
    this.#sign = sign;
    this.#now = now;
  }

  async quote(): Promise<Record<string, unknown>> {
    const r = await this.#api.call("campaign", { action: "quote", body: { primaryWallet: this.#wallet } });
    if (r.status !== 200) throw new FleetError(r.status, String(r.body["code"] ?? "quote_failed"));
    return r.body;
  }

  /**
   * The challenge flow: hash the body, ask for a challenge, sign it, send the
   * action with the envelope. `scope` names the tap that asked (a callback
   * id); the idempotency key is a function of it, never of the clock.
   */
  async signed(action: string, body: Record<string, unknown>, scope?: string): Promise<Record<string, unknown>> {
    const { payloadHash } = await import("./campaign-service.js");
    const hash = payloadHash(body);
    const challenge = await this.#api.call("campaign", { action: "challenge", body: { primaryWallet: this.#wallet, action, payloadHash: hash } });
    if (challenge.status !== 200) throw new FleetError(challenge.status, String(challenge.body["code"] ?? "challenge_failed"));
    const signature = await this.#sign(String(challenge.body["challenge"]));
    const auth = {
      primaryWallet: this.#wallet,
      nonce: String(challenge.body["nonce"]),
      issuedAt: String(challenge.body["issuedAt"]),
      expiresAt: String(challenge.body["expiresAt"]),
      action,
      payloadHash: hash,
      signature,
    };
    const key = IDEMPOTENT.has(action) ? `fleet-bot-${action}-${scope ?? keccak256(stringToHex(`${this.#wallet}|${action}|${hash}`)).slice(2, 18)}`.slice(0, 64) : undefined;
    const r = await this.#api.call(routeOf(action), { action, auth, body }, key);
    if (r.status < 200 || r.status >= 300) throw new FleetError(r.status, String(r.body["code"] ?? `status_${r.status}`));
    return r.body;
  }

  /** Fresh accounts, each key sealed by the caller's sealer (bound to the user's row); the service sees addresses and salts, never keys. */
  static generateAccounts(count: number, sealer: (privateKey: Hex) => string): FleetRecord["accounts"] {
    return Array.from({ length: count }, () => {
      const privateKey = generatePrivateKey();
      const salt = new Uint8Array(32);
      crypto.getRandomValues(salt);
      return {
        ownerAddress: privateKeyToAccount(privateKey).address.toLowerCase() as Address,
        sealedKey: sealer(privateKey),
        salt: `0x${[...salt].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex,
      };
    });
  }

  /** Creates and confirms a fleet: the two signed steps the wizard makes, in one go. */
  async createFleet(input: { accounts: FleetRecord["accounts"]; chainId: number; router: Address; fn: string; maxTradeValue: bigint; perAccountGas: bigint; days: number }, scope?: string): Promise<FleetRecord> {
    const quote = await this.quote();
    if (quote["eligible"] === false) throw new FleetError(403, "ineligible");
    const vaultCommitment = keccak256(stringToHex(JSON.stringify(input.accounts.map((a) => ({ o: a.ownerAddress, s: a.salt, k: a.sealedKey })))));
    const created = await this.signed("create", {
      quoteId: String(quote["quoteId"] ?? "preview"),
      policy: {
        chainId: input.chainId,
        accounts: input.accounts.length,
        router: input.router,
        function: input.fn,
        maxTradeValue: input.maxTradeValue.toString(),
        perAccountGas: input.perAccountGas.toString(),
        totalGas: (input.perAccountGas * BigInt(input.accounts.length)).toString(),
        expiry: new Date(this.#now().getTime() + input.days * 86_400_000).toISOString(),
      },
      accounts: input.accounts.map((a) => ({ ownerAddress: a.ownerAddress, salt: a.salt })),
      recoveryVaultCommitment: vaultCommitment,
    }, scope);
    const campaign = String(created["campaign"]);
    const confirmed = await this.signed("confirmRecovery", { campaign, vaultConfirmed: true }, scope);
    return { campaign, accounts: input.accounts, fleet: [], vaultCommitment, createdAt: this.#now().toISOString(), state: String(confirmed["state"] ?? created["state"] ?? "") };
  }

  async activate(campaign: string, drawWei: bigint, scope?: string): Promise<{ state: string; accounts: Address[] }> {
    const r = await this.signed("activate", { campaign, draw: drawWei.toString() }, scope);
    return { state: String(r["state"] ?? ""), accounts: ((r["accounts"] as Address[] | undefined) ?? []) };
  }

  /** What the service's status route returns: the state read from the chain, and the draw (amount, spent, remaining, dueAt, state). */
  async status(campaign: string): Promise<{ state: string; draw?: DrawView }> {
    const r = await this.#api.call("campaign", { action: "status", body: { campaign } });
    if (r.status !== 200) throw new FleetError(r.status, String(r.body["code"] ?? "status_failed"));
    const d = r.body["draw"] as Partial<DrawView> | undefined;
    return {
      state: String(r.body["state"] ?? ""),
      ...(d ? { draw: { amount: String(d.amount ?? "0"), spent: String(d.spent ?? "0"), remaining: String(d.remaining ?? "0"), dueAt: String(d.dueAt ?? ""), state: String(d.state ?? "") } } : {}),
    };
  }

  async read(campaign: string): Promise<Record<string, unknown>> {
    return this.signed("read", { campaign });
  }

  async buy(campaign: string, accounts: Address[], token: Address, valueWei: bigint, scope?: string): Promise<Record<string, unknown>> {
    return this.signed("buy", { campaign, accounts, token, value: valueWei.toString() }, scope);
  }

  async control(action: "pause" | "resume" | "close", campaign: string, scope?: string): Promise<Record<string, unknown>> {
    return this.signed(action, { campaign }, scope);
  }

  async balance(): Promise<Record<string, unknown>> {
    return this.signed("balance", {});
  }
}

export type DrawView = { amount: string; spent: string; remaining: string; dueAt: string; state: string };

export type FleetPhase = "none" | "created" | "activating" | "active" | "paused" | "ended" | "closed";

/**
 * Where a fleet is in its life, in one word a card can colour, from the
 * service's state names (campaign-state.ts): Draft, Awaiting recovery
 * confirmation and Awaiting funding are "created" (the activate step is
 * next); Activating is the wait; Revoked, Depleted and Expired are "ended"
 * (only close is left); Closed is closed.
 */
export const fleetPhase = (record: FleetRecord | undefined): FleetPhase => {
  if (!record) return "none";
  const s = record.state.toLowerCase();
  if (s === "closed") return "closed";
  if (s === "revoked" || s === "depleted" || s === "expired") return "ended";
  if (s === "paused") return "paused";
  if (s === "activating") return "activating";
  if (s === "active") return "active";
  return "created";
};

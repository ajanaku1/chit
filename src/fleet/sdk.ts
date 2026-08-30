/**
 * Fleet TypeScript SDK (FR-010, FR-013, FR-015, SC-003, SC-006, SC-010).
 *
 * A small client over the three fleet routes, implementing the wire rules in
 * `specs/001-fleet-mission/contracts/fleet-sdk.md`: JSON is `{ action, auth,
 * body }`, the idempotency key travels ONLY as the `Idempotency-Key` header,
 * the outer action must equal `auth.action` before anything is sent, and once
 * a campaign reports Revoked the client refuses everything but close locally.
 */

import type {
  ActivationResult,
  Address,
  AuthEnvelope,
  BuyResult,
  CampaignResult,
  ControlAction,
  ControlRoomResult,
  FeeQuote,
  Hex,
} from "./types.js";
import type { Challenge } from "./campaign-service.js";

export type TransportRequest = {
  route: "campaign" | "buy" | "control";
  payload: { action: string; auth?: AuthEnvelope; body: unknown };
  idempotencyKey?: string;
};

export type Transport = (request: TransportRequest) => Promise<{ status: number; body: unknown }>;

export type Signed<T> = { auth: AuthEnvelope; body: T };
export type Idempotent<T> = { auth: AuthEnvelope; idempotencyKey: string; body: T };

export type QuoteInput = { primaryWallet: Address };
export type ChallengeInput = { primaryWallet: Address; action: string; payloadHash: Hex };
export type CampaignInput = { campaign: string };
export type CreateCampaignInput = {
  quoteId: string;
  policy: unknown;
  accounts: { ownerAddress: Address; salt: Hex }[];
  recoveryVaultCommitment: Hex;
};
export type RecoveryInput = CampaignInput & { vaultConfirmed: true };
export type FundInput = CampaignInput & { fundingReference: string };
export type BuyInput = CampaignInput & { accounts: Address[]; token: Address; value: string };

const IDEMPOTENCY_KEY = /^fleet-[A-Za-z0-9_-]{16,128}$/;

/** Actions a locally-known-revoked campaign may still send. */
const ALLOWED_AFTER_REVOKE = new Set(["close", "read"]);

export class SdkError extends Error {
  readonly reason: string;
  readonly status: number | undefined;

  constructor(reason: string, status?: number) {
    super(`fleet_sdk: ${reason}`);
    this.name = "SdkError";
    this.reason = reason;
    this.status = status;
  }
}

export class FleetClient {
  readonly #transport: Transport;
  /** Campaign states learned from responses; drives local terminal refusal. */
  readonly #knownStates = new Map<string, string>();

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  async quote(input: QuoteInput): Promise<FeeQuote> {
    return (await this.#send("campaign", { action: "quote", body: input })) as FeeQuote;
  }

  async challenge(input: ChallengeInput): Promise<Challenge> {
    return (await this.#send("campaign", { action: "challenge", body: input })) as Challenge;
  }

  async createCampaign(input: Idempotent<CreateCampaignInput>): Promise<CampaignResult> {
    return this.#signed("campaign", "create", input) as Promise<CampaignResult>;
  }

  async confirmRecovery(input: Idempotent<RecoveryInput>): Promise<CampaignResult> {
    return this.#signed("campaign", "confirmRecovery", input) as Promise<CampaignResult>;
  }

  async fund(input: Idempotent<FundInput>): Promise<CampaignResult> {
    return this.#signed("campaign", "fund", input) as Promise<CampaignResult>;
  }

  async activate(input: Idempotent<CampaignInput>): Promise<ActivationResult> {
    return this.#signed("campaign", "activate", input) as Promise<ActivationResult>;
  }

  async buy(input: Idempotent<BuyInput>): Promise<BuyResult> {
    return this.#signed("buy", "buy", input) as Promise<BuyResult>;
  }

  async control(action: ControlAction, input: Idempotent<CampaignInput>): Promise<CampaignResult> {
    return this.#signed("control", action, input) as Promise<CampaignResult>;
  }

  async readCampaign(input: Signed<CampaignInput>): Promise<ControlRoomResult> {
    if (input.auth.action !== "read") throw new SdkError("action_mismatch");
    return (await this.#send("campaign", { action: "read", auth: input.auth, body: input.body })) as ControlRoomResult;
  }

  async #signed(
    route: TransportRequest["route"],
    action: string,
    input: { auth: AuthEnvelope; idempotencyKey: string; body: unknown },
  ): Promise<unknown> {
    // The method-selected action is the only outer action; it must match the
    // envelope before any bytes leave the client.
    if (action !== input.auth.action) throw new SdkError("action_mismatch");
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new SdkError("malformed_idempotency_key");
    this.#refuseIfRevoked(action, input.body);
    return this.#send(route, { action, auth: input.auth, body: input.body }, input.idempotencyKey);
  }

  /** Revoked is terminal: no buy, resume, or rotation ever leaves the client (FR-013). */
  #refuseIfRevoked(action: string, body: unknown): void {
    const campaign = (body as { campaign?: unknown }).campaign;
    if (typeof campaign !== "string") return;
    if (this.#knownStates.get(campaign) === "Revoked" && !ALLOWED_AFTER_REVOKE.has(action)) {
      throw new SdkError("revoked_terminal");
    }
  }

  async #send(
    route: TransportRequest["route"],
    payload: TransportRequest["payload"],
    idempotencyKey?: string,
  ): Promise<unknown> {
    const response = await this.#transport(
      idempotencyKey === undefined ? { route, payload } : { route, payload, idempotencyKey },
    );
    const body = response.body as { code?: string; campaign?: string; state?: string };
    if (response.status < 200 || response.status >= 300) {
      throw new SdkError(body?.code ?? "request_failed", response.status);
    }
    if (typeof body?.campaign === "string" && typeof body?.state === "string") {
      this.#knownStates.set(body.campaign, body.state);
    }
    return response.body;
  }
}

/**
 * Gas sponsorship: the route.
 *
 *   POST /api/fleet/sponsor  { action, body, auth? }
 *
 * Two kinds of action. The sponsor's own (register, policy, pause, resume,
 * close, status, list) are signed by the sponsor's wallet through the same
 * challenge flow the fleet app uses; the sponsor is already known to Chit,
 * and its wallet is the one that funds the escrow. The user's (sponsor,
 * submit) need no signature and no login (FR-004): a user of the dapp is
 * nobody Chit knows, and the policy plus the sponsor's budget are the whole
 * gate. `info` is public.
 *
 * Every refusal is a stable code, and a policy refusal carries its reason
 * (`target_not_allowed`, `user_daily_cap`, ...) so a dapp can show it.
 */

import { ServiceError, assertNoSecrets, type CampaignService } from "./campaign-service.js";
import type { SponsorService } from "./sponsor-service.js";
import { FleetValidationError, type Address, type AuthEnvelope, type Hex } from "./types.js";

export type SponsorRouterResult = { status: number; body: unknown };

const STATUS: Record<string, number> = {
  challenge_invalid: 401,
  ineligible: 403,
  policy_rejected: 422,
  idempotency_conflict: 409,
  state_invalid: 409,
  dependency_evidence_invalid: 503,
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const SPONSOR_PUBLIC_ACTIONS = ["info", "challenge", "sponsor", "submit"] as const;
export const SPONSOR_OWNER_ACTIONS = ["register", "policy", "pause", "resume", "close", "status", "list"] as const;

export class SponsorRouter {
  readonly #auth: CampaignService;
  readonly #service: SponsorService;

  constructor(deps: { auth: CampaignService; service: SponsorService }) {
    this.#auth = deps.auth;
    this.#service = deps.service;
  }

  async handle(request: unknown): Promise<SponsorRouterResult> {
    try {
      return { status: 200, body: await this.#dispatch(asRecord(request)) };
    } catch (error) {
      return errorResult(error);
    }
  }

  async #dispatch(request: Record<string, unknown>): Promise<unknown> {
    const action = String(request["action"] ?? "");
    const body = asRecord(request["body"]);

    if (action === "info") return this.#service.info();
    if (action === "challenge") {
      return this.#auth.issueChallenge({
        primaryWallet: body["primaryWallet"] as Address,
        action: String(body["action"] ?? ""),
        payloadHash: body["payloadHash"] as Hex,
      });
    }
    if (action === "sponsor") return this.#service.sponsor(body["sponsor"], body["op"]);
    if (action === "submit") return this.#service.submit(body["op"]);

    const auth = request["auth"] as AuthEnvelope | undefined;
    if (!auth) throw new ServiceError("challenge_invalid", "auth_missing");
    const owner = (await this.#auth.verify(action, { auth, body })) as Address;
    assertNoSecrets(body);
    const id = body["sponsor"] as Hex;

    switch (action) {
      case "register": return this.#service.register(owner, body["policy"]);
      case "policy": return this.#service.setPolicy(owner, id, body["policy"]);
      case "pause": return this.#service.setPaused(owner, id, true);
      case "resume": return this.#service.setPaused(owner, id, false);
      case "close": return this.#service.markClosed(owner, id);
      case "status": return this.#service.status(owner, id);
      case "list": return this.#service.list(owner);
      default: throw new ServiceError("state_invalid", "unknown_action");
    }
  }
}

const errorResult = (error: unknown): SponsorRouterResult => {
  if (error instanceof FleetValidationError) {
    return { status: 400, body: { code: "policy_rejected", reason: error.reason, retryable: false } };
  }
  if (error instanceof ServiceError) {
    const status = STATUS[error.code];
    if (status === undefined) throw error;
    return { status, body: { code: error.code, reason: error.reason, retryable: error.code === "challenge_invalid" } };
  }
  throw error;
};

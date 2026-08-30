/**
 * Fleet campaign action router (FR-002 to FR-006, FR-012, SC-005).
 *
 * Pure request-in/response-out dispatch behind `api/fleet/campaign.ts`, kept
 * transport-free so the route tests exercise every path without a Vercel
 * runtime. Envelope verification, idempotency, and redaction come from
 * `CampaignService`; state legality comes from the campaign state machine; the
 * fee facts come from validated configuration. Responses never echo the primary
 * wallet, a signature, or any credential material.
 */

import { BudgetError, CampaignBudget } from "./campaign-budget.js";
import { CampaignService, ServiceError, assertNoSecrets } from "./campaign-service.js";
import { CampaignStateError, canSponsor, transition } from "./campaign-state.js";
import { EligibilityError, chargeQuote, createQuote, type FeeConfig } from "./eligibility.js";
import { PolicyRejection, authorize, type SessionKey } from "./session-policy.js";
import { buildPackedUserOp, encodeExecuteCall, type UserOperationSubmitter } from "./user-operation.js";
import {
  FleetValidationError,
  isHex32,
  parseFleetAccounts,
  parsePolicy,
  type Address,
  type AuthEnvelope,
  type CampaignState,
  type FeeCharge,
  type FleetAccountInit,
  type Hex,
  type Policy,
  type Uint,
} from "./types.js";

export type RouterDeps = {
  service: CampaignService;
  feeConfig: FeeConfig;
  /** Read-only mainnet CHIT balance for one wallet, in base units. */
  chitBalanceOf: (wallet: Address) => Promise<Uint>;
  /** Confirms a funding reference against chain evidence and returns its wei amount. */
  verifyFunding?: (reference: string) => Promise<Uint>;
  /** Lands authorized UserOperations; absent means sponsorship is not configured. */
  submitter?: UserOperationSubmitter;
  randomId?: () => string;
  now?: () => Date;
};

export type RouterResult = { status: number; body: unknown };

type CampaignRecord = {
  id: string;
  /** Held by the operator only; never serialized into a response. */
  ownerWallet: string;
  policy: Policy;
  accounts: FleetAccountInit[];
  recoveryVaultCommitment: Hex;
  state: CampaignState;
  fee: FeeCharge;
  budget: CampaignBudget;
};

const STATUS: Record<string, number> = {
  challenge_invalid: 401,
  ineligible: 403,
  revoked_terminal: 403,
  state_invalid: 409,
  idempotency_conflict: 409,
  policy_rejected: 422,
  budget_exceeded: 422,
  dependency_evidence_invalid: 503,
};

/** Buy-path policy refusals are 403 per the fleet-api.md route table. */
const POLICY_REJECTED_STATUS = 403;

const CONTROL_EVENTS = {
  pause: "pause",
  resume: "resume",
  revoke: "revoke",
  close: "close",
} as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class CampaignRouter {
  readonly #deps: RouterDeps;
  readonly #campaigns = new Map<string, CampaignRecord>();
  readonly #randomId: () => string;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.#randomId = deps.randomId ?? (() => crypto.randomUUID());
  }

  async handle(request: unknown, idempotencyKey?: string): Promise<RouterResult> {
    try {
      return await this.#dispatch(asRecord(request), idempotencyKey);
    } catch (error) {
      return errorResult(error);
    }
  }

  async #dispatch(request: Record<string, unknown>, idempotencyKey?: string): Promise<RouterResult> {
    const action = request["action"];
    const body = asRecord(request["body"]);

    if (action === "quote") {
      const wallet = String(body["primaryWallet"] ?? "");
      const balance = await this.#deps.chitBalanceOf(wallet as Address);
      return { status: 200, body: createQuote(this.#deps.feeConfig, balance, this.#randomId()) };
    }
    if (action === "challenge") {
      return {
        status: 200,
        body: this.#deps.service.issueChallenge({
          primaryWallet: body["primaryWallet"] as Address,
          action: String(body["action"] ?? ""),
          payloadHash: body["payloadHash"] as Hex,
        }),
      };
    }

    const auth = request["auth"] as AuthEnvelope | undefined;
    if (!auth) throw new ServiceError("challenge_invalid", "auth_missing");
    const wallet = await this.#deps.service.verify(String(action), { auth, body });
    assertNoSecrets(body);

    if (action === "read") return this.#read(wallet, body);

    if (typeof idempotencyKey !== "string") {
      throw new ServiceError("idempotency_conflict", "key_required");
    }
    const scope = {
      primaryWallet: wallet as Address,
      action: String(action),
      campaign: String(body["campaign"] ?? "new"),
    };
    return this.#deps.service.runIdempotent(idempotencyKey, scope, body, async () => {
      switch (action) {
        case "create":
          return this.#create(wallet, body);
        case "confirmRecovery":
          return this.#advance(wallet, body, "confirmRecovery");
        case "fund":
          return this.#fund(wallet, body);
        case "activate":
          return this.#activate(wallet, body);
        case "buy":
          return this.#buy(wallet, body);
        case "pause":
        case "resume":
        case "revoke":
        case "close":
          return this.#control(wallet, body, CONTROL_EVENTS[action]);
        default:
          throw new ServiceError("state_invalid", `unknown_action:${String(action)}`);
      }
    });
  }

  async #create(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const commitment = body["recoveryVaultCommitment"];
    if (!isHex32(commitment)) throw new FleetValidationError("invalid_vault_commitment");
    const policy = parsePolicy(body["policy"]);
    const accounts = parseFleetAccounts(body["accounts"]);
    if (accounts.length !== policy.accounts) throw new FleetValidationError("account_count_mismatch");

    // Eligibility gates everything: no campaign, account, or budget state may
    // exist for a blocked wallet (SC-002).
    const balance = await this.#deps.chitBalanceOf(wallet as Address);
    const quote = createQuote(this.#deps.feeConfig, balance, String(body["quoteId"] ?? this.#randomId()));
    const fee = chargeQuote(quote, this.#deps.feeConfig, `charge-${this.#randomId()}`);

    const record: CampaignRecord = {
      id: this.#randomId(),
      ownerWallet: wallet,
      policy,
      accounts,
      recoveryVaultCommitment: commitment,
      state: transition("Draft", "requestRecovery"),
      fee,
      budget: new CampaignBudget("0"),
    };
    this.#campaigns.set(record.id, record);
    return { status: 201, body: this.#result(record, { fee: true }) };
  }

  #campaign(wallet: string, body: Record<string, unknown>): CampaignRecord {
    const record = this.#campaigns.get(String(body["campaign"] ?? ""));
    if (!record || record.ownerWallet !== wallet) {
      throw new ServiceError("state_invalid", "campaign_unknown");
    }
    return record;
  }

  #advance(wallet: string, body: Record<string, unknown>, event: "confirmRecovery" | "fund"): RouterResult {
    const record = this.#campaign(wallet, body);
    record.state = transition(record.state, event);
    return { status: 200, body: this.#result(record) };
  }

  /** Funding is evidence-checked: the budget is the verified amount, never a claim. */
  async #fund(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = this.#campaign(wallet, body);
    // State legality first: a skipped step is the caller's error (409) no
    // matter how the server is configured.
    const nextState = transition(record.state, "fund");
    if (nextState !== record.state) {
      const verify = this.#deps.verifyFunding;
      if (!verify) throw new ServiceError("dependency_evidence_invalid", "funding_verification_unconfigured");
      record.budget = new CampaignBudget(await verify(String(body["fundingReference"] ?? "")));
      record.state = nextState;
    }
    return { status: 200, body: this.#result(record) };
  }

  #session(record: CampaignRecord): SessionKey {
    return {
      campaign: record.id,
      chainId: record.policy.chainId,
      accounts: record.accounts.map((account) => account.ownerAddress),
      router: record.policy.router,
      function: record.policy.function,
      maxTradeValue: record.policy.maxTradeValue,
      perAccountGas: record.policy.perAccountGas,
      totalGas: record.policy.totalGas,
      expiry: record.policy.expiry,
      revoked: record.state === "Revoked",
    };
  }

  /** One bounded sponsored buy per listed account (FR-007 to FR-010). */
  async #buy(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = this.#campaign(wallet, body);
    const submitter = this.#deps.submitter;
    if (!submitter) throw new ServiceError("dependency_evidence_invalid", "submitter_unconfigured");
    if (!canSponsor(record.state)) throw new PolicyRejection(`state_not_sponsorable:${record.state}`);

    const value = String(body["value"] ?? "");
    const token = String(body["token"] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new FleetValidationError("invalid_token");
    const requested = Array.isArray(body["accounts"]) ? (body["accounts"] as Address[]) : [];
    if (requested.length === 0) throw new FleetValidationError("no_accounts");

    // Shared request facts are checked once, before any sponsorship, so a
    // request outside policy is refused whole (SC-006).
    const session = this.#session(record);
    const now = (this.#deps.now ?? (() => new Date()))();
    authorize({
      session,
      request: {
        campaign: record.id, chainId: record.policy.chainId,
        account: session.accounts[0] as Address, operation: "buy",
        target: record.policy.router, function: record.policy.function,
        value, gas: "0",
      },
      state: record.state, spentGas: record.budget.snapshot().spent, now,
    });

    const results: Record<string, unknown>[] = [];
    for (const account of requested) {
      results.push(await this.#buyOne(record, session, account, token, value, now, submitter));
    }

    // FR edge case: the campaign depletes when the remainder cannot fund
    // another permitted request.
    const remaining = record.budget.snapshot().unused;
    if (record.state === "Active" && BigInt(remaining) < BigInt(record.policy.perAccountGas)) {
      record.state = transition(record.state, "deplete");
    }

    return { status: 200, body: { results } };
  }

  async #buyOne(
    record: CampaignRecord,
    session: SessionKey,
    account: Address,
    token: string,
    value: Uint,
    now: Date,
    submitter: UserOperationSubmitter,
  ): Promise<Record<string, unknown>> {
    const reservationKey = `${record.id}|buy|${account.toLowerCase()}|${value}|${token.toLowerCase()}`;
    try {
      authorize({
        session,
        request: {
          campaign: record.id, chainId: record.policy.chainId,
          account, operation: "buy",
          target: record.policy.router, function: record.policy.function,
          value, gas: record.policy.perAccountGas,
        },
        state: record.state, spentGas: record.budget.snapshot().spent, now,
      });
      record.budget.reserve(reservationKey, record.policy.perAccountGas);
    } catch (error) {
      if (error instanceof PolicyRejection || error instanceof BudgetError) {
        return { account, status: "rejected", budget: record.budget.snapshot() };
      }
      throw error;
    }

    try {
      const submitted = await submitter.submit(buildPackedUserOp({
        sender: account,
        nonce: "0",
        callData: encodeExecuteCall(
          record.policy.router,
          value,
          encodeExecuteData(token as Address, value),
        ),
        callGasLimit: record.policy.perAccountGas,
        verificationGasLimit: "150000",
        preVerificationGas: "50000",
        maxFeePerGas: "1000000000",
        maxPriorityFeePerGas: "1000000",
        paymasterAndData: "0x",
      }));
      const budget = record.budget.commit(reservationKey, submitted.actualGasCost);
      return { account, status: "sponsored", userOpHash: submitted.userOpHash, budget };
    } catch {
      const budget = record.budget.rollback(reservationKey);
      return { account, status: "rejected", budget };
    }
  }

  #control(wallet: string, body: Record<string, unknown>, event: "pause" | "resume" | "revoke" | "close"): RouterResult {
    const record = this.#campaign(wallet, body);
    record.state = transition(record.state, event);
    if (event === "close") {
      const returned = record.budget.close();
      return { status: 200, body: { ...this.#result(record), returnedEth: returned } };
    }
    return { status: 200, body: this.#result(record) };
  }

  #activate(wallet: string, body: Record<string, unknown>): RouterResult {
    const record = this.#campaign(wallet, body);
    record.state = transition(record.state, "activate");
    return {
      status: 200,
      body: {
        ...this.#result(record),
        accounts: record.accounts.map((account) => account.ownerAddress),
      },
    };
  }

  #read(wallet: string, body: Record<string, unknown>): RouterResult {
    const record = this.#campaign(wallet, body);
    return { status: 200, body: { ...this.#result(record), results: [] } };
  }

  #result(record: CampaignRecord, options: { fee?: boolean } = {}): Record<string, unknown> {
    return {
      campaign: record.id,
      state: record.state,
      ...(options.fee ? { fee: record.fee } : {}),
      budget: record.budget.snapshot(),
    };
  }
}

/** Approved-function calldata for the demo buy: router.function(token, value). */
const encodeExecuteData = (token: Address, value: Uint): `0x${string}` =>
  `0x${token.slice(2).padStart(64, "0")}${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`;

/** Maps every thrown domain error onto the fleet-api.md status table. */
const errorResult = (error: unknown): RouterResult => {
  let code: string | undefined;
  let status: number | undefined;
  if (error instanceof ServiceError || error instanceof CampaignStateError) {
    code = error.code;
  } else if (error instanceof PolicyRejection) {
    code = "policy_rejected";
    status = POLICY_REJECTED_STATUS;
  } else if (error instanceof FleetValidationError) {
    code = "policy_rejected";
  } else if (error instanceof EligibilityError) {
    code = error.code === "ineligible" ? "ineligible" : "policy_rejected";
  }
  status ??= code === undefined ? undefined : STATUS[code];
  if (code === undefined || status === undefined) throw error;
  return { status, body: { code, retryable: code === "challenge_invalid" } };
};

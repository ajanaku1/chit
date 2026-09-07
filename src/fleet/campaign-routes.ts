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
import type { OnChainCampaign } from "./chain-campaign.js";
import { campaignKey, type ChainBuy, type FleetChain } from "./chain-service.js";
import { CampaignService, ServiceError, assertNoSecrets } from "./campaign-service.js";
import { CampaignStateError, canSponsor, transition } from "./campaign-state.js";
import { EligibilityError, OPEN_ACCESS_CHARGE, chargeQuote, createQuote, openQuote, type FeeConfig } from "./eligibility.js";
import type { PoolPort } from "./pool-buy.js";
import { PolicyRejection, authorize, type SessionKey } from "./session-policy.js";
import { buildPackedUserOp, encodeExecuteCall, type UserOperationSubmitter } from "./user-operation.js";
import { UNIVERSAL_ROUTER_EXECUTE, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeBuyCall } from "./v4-swap.js";
import {
  FleetValidationError,
  isAddress,
  isHex32,
  isUint,
  parseFleetAccounts,
  parsePolicy,
  type Address,
  type AuthEnvelope,
  type Budget,
  type CampaignState,
  type FeeCharge,
  type FleetAccountInit,
  type Hex,
  type Policy,
  type Uint,
} from "./types.js";

export type RouterDeps = {
  service: CampaignService;
  /** Published CHIT fee facts; absent means open access (no gate, no fee). */
  feeConfig?: FeeConfig;
  /** Read-only mainnet CHIT balance for one wallet, in base units. */
  chitBalanceOf?: (wallet: Address) => Promise<Uint>;
  /** Deployed contracts + operator signer; present means the chain is the budget's source of truth. */
  chain?: FleetChain;
  /** Stage 2 pool; absent means balance and withdrawal answer 503, never a guess. */
  pool?: PoolPort;
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
  /** Set once the fleet exists on-chain: the factory-created account addresses. */
  chainAccounts?: Address[];
  /** Last on-chain budget read; authoritative whenever `chain` is configured. */
  chainBudget?: Budget;
};

const STATUS: Record<string, number> = {
  challenge_invalid: 401,
  ineligible: 403,
  revoked_terminal: 403,
  state_invalid: 409,
  idempotency_conflict: 409,
  policy_rejected: 422,
  budget_exceeded: 422,
  budget_invalid: 422,
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
      return { status: 200, body: await this.#quote(wallet as Address, this.#randomId()) };
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
    if (action === "balance") return this.#balance(wallet);

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
        case "withdraw":
          return this.#withdraw(wallet, body);
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
    // exist for a blocked wallet (SC-002). Open access charges nothing.
    const quote = await this.#quote(wallet as Address, String(body["quoteId"] ?? this.#randomId()));
    const fee = this.#deps.feeConfig
      ? chargeQuote(quote, this.#deps.feeConfig, `charge-${this.#randomId()}`)
      : { ...quote, ...OPEN_ACCESS_CHARGE };

    const id = this.#randomId();
    if (this.#deps.chain) await this.#deps.chain.registerCampaign(campaignKey(id), wallet as Address);
    const record: CampaignRecord = {
      id,
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

  #pool(): PoolPort {
    const pool = this.#deps.pool;
    if (!pool) throw new ServiceError("dependency_evidence_invalid", "pool_unconfigured");
    return pool;
  }

  /** What the trader holds, is holding back, and may still deposit (FR-002, FR-003). */
  async #balance(wallet: string): Promise<RouterResult> {
    return { status: 200, body: await this.#pool().balance(wallet as Address) };
  }

  /**
   * Pays a signed withdrawal (FR-010). The balance is re-read here rather than
   * trusted from the request, and a destination equal to the depositing wallet
   * is warned about, not refused: it is the trader's privacy to spend.
   */
  async #withdraw(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const pool = this.#pool();
    const destination = body["destination"];
    if (!isAddress(destination)) throw new FleetValidationError("invalid_destination");
    const amount = body["amount"];
    if (!isUint(amount) || BigInt(amount) === 0n) throw new FleetValidationError("invalid_amount");

    const before = await pool.balance(wallet as Address);
    if (before.pool.paused) throw new CampaignStateError("state_invalid", "pool_paused");
    if (BigInt(amount) > BigInt(before.available)) {
      throw new BudgetError("budget_exceeded", "insufficient_balance");
    }

    const receipt = await pool.withdraw({ depositor: wallet as Address, amount, destination });
    const after = await pool.balance(wallet as Address);
    const samePayee = destination.toLowerCase() === wallet.toLowerCase();
    return {
      status: 200,
      body: { ...receipt, available: after.available, ...(samePayee ? { warning: "destination_is_primary" } : {}) },
    };
  }

  async #quote(wallet: Address, quoteId: string) {
    const { feeConfig, chitBalanceOf } = this.#deps;
    if (!feeConfig || !chitBalanceOf) return openQuote(quoteId);
    return createQuote(feeConfig, await chitBalanceOf(wallet), quoteId);
  }

  #budget(record: CampaignRecord): Budget {
    return record.chainBudget ?? record.budget.snapshot();
  }

  async #campaign(wallet: string, body: Record<string, unknown>): Promise<CampaignRecord> {
    const id = String(body["campaign"] ?? "");
    const record = this.#campaigns.get(id) ?? (await this.#restore(id, wallet));
    if (!record || record.ownerWallet !== wallet) {
      throw new ServiceError("state_invalid", "campaign_unknown");
    }
    return record;
  }

  /**
   * A campaign this instance never saw is rebuilt from the chain, so any
   * serverless instance can serve buy, control, and read after activation.
   * Before activation the policy exists only in the creating instance.
   */
  async #restore(id: string, wallet: string): Promise<CampaignRecord | undefined> {
    const chain = this.#deps.chain;
    if (!chain || !id) return undefined;
    const found = await chain.loadCampaign(campaignKey(id));
    if (!found?.session || found.owner.toLowerCase() !== wallet) return undefined;
    const record = restoredRecord(id, wallet, found, this.#now());
    this.#campaigns.set(id, record);
    return record;
  }

  #now(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  async #advance(wallet: string, body: Record<string, unknown>, event: "confirmRecovery" | "fund"): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    record.state = transition(record.state, event);
    return { status: 200, body: this.#result(record) };
  }

  /** Funding is evidence-checked: the budget is the verified amount, never a claim. */
  async #fund(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    // State legality first: a skipped step is the caller's error (409) no
    // matter how the server is configured.
    const nextState = transition(record.state, "fund");
    if (nextState !== record.state) {
      if (this.#deps.chain) {
        // Funding is what the escrow holds, read on-chain: never a claim.
        const budget = await this.#deps.chain.readBudget(campaignKey(record.id));
        if (BigInt(budget.unused) < BigInt(record.policy.perAccountGas)) {
          throw new BudgetError("budget_exceeded", "campaign_unfunded");
        }
        record.chainBudget = budget;
      } else {
        const verify = this.#deps.verifyFunding;
        if (!verify) throw new ServiceError("dependency_evidence_invalid", "funding_verification_unconfigured");
        record.budget = new CampaignBudget(await verify(String(body["fundingReference"] ?? "")));
      }
      record.state = nextState;
    }
    return { status: 200, body: this.#result(record) };
  }

  #session(record: CampaignRecord): SessionKey {
    return {
      campaign: record.id,
      chainId: record.policy.chainId,
      accounts: record.chainAccounts ?? record.accounts.map((account) => account.ownerAddress),
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
    const record = await this.#campaign(wallet, body);
    const { submitter, chain } = this.#deps;
    if (!submitter && !chain) throw new ServiceError("dependency_evidence_invalid", "submitter_unconfigured");
    if (!canSponsor(record.state)) throw new PolicyRejection(`state_not_sponsorable:${record.state}`);

    const value = String(body["value"] ?? "");
    const token = String(body["token"] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new FleetValidationError("invalid_token");
    const requested = Array.isArray(body["accounts"]) ? (body["accounts"] as Address[]) : [];
    if (requested.length === 0) throw new FleetValidationError("no_accounts");

    if (chain) await this.#syncEnrolled(record, chain, requested);

    // Shared request facts are checked once, before any sponsorship, so a
    // request outside policy is refused whole (SC-006).
    const session = this.#session(record);
    const now = this.#now();
    authorize({
      session,
      request: {
        campaign: record.id, chainId: record.policy.chainId,
        account: session.accounts[0] as Address, operation: "buy",
        target: record.policy.router, function: record.policy.function,
        value, gas: "0",
      },
      state: record.state, spentGas: this.#budget(record).spent, now,
    });

    const results: Record<string, unknown>[] = chain
      ? await this.#buyOnChain(record, session, chain, requested, token, value, now)
      : await this.#buyInMemory(record, session, submitter!, requested, token, value, now);

    // FR edge case: the campaign depletes when the remainder cannot fund
    // another permitted request.
    const remaining = this.#budget(record).unused;
    if (record.state === "Active" && BigInt(remaining) < BigInt(record.policy.perAccountGas)) {
      record.state = transition(record.state, "deplete");
    }

    return { status: 200, body: { results } };
  }

  async #buyInMemory(
    record: CampaignRecord, session: SessionKey, submitter: UserOperationSubmitter,
    requested: Address[], token: string, value: Uint, now: Date,
  ): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (const account of requested) {
      results.push(await this.#buyOne(record, session, account, token, value, now, submitter));
    }
    return results;
  }

  /**
   * Policy-checks each account here first (so an out-of-policy account is
   * refused without a transaction), then settles the permitted ones on-chain.
   * The escrow's reserve/commit/rollback is the budget; nothing is mirrored.
   */
  async #buyOnChain(
    record: CampaignRecord, session: SessionKey, chain: FleetChain,
    requested: Address[], token: string, value: Uint, now: Date,
  ): Promise<Record<string, unknown>[]> {
    const refused: Record<string, unknown>[] = [];
    const permitted: ChainBuy[] = [];
    for (const account of requested) {
      if (this.#permitted(record, session, account, value, now)) {
        permitted.push(this.#chainBuy(record, account, token, value, now));
      } else {
        refused.push({ account, status: "rejected", budget: this.#budget(record) });
      }
    }
    if (permitted.length === 0) return refused;
    const report = await chain.buy(campaignKey(record.id), record.policy.router, permitted);
    record.chainBudget = report.budget;
    return [...refused, ...report.results.map((r) => ({ ...r, budget: report.budget }))];
  }

  /** True when the session policy admits a buy for this account; false on a policy refusal. */
  #permitted(record: CampaignRecord, session: SessionKey, account: Address, value: Uint, now: Date): boolean {
    try {
      authorize({
        session,
        request: {
          campaign: record.id, chainId: record.policy.chainId, account, operation: "buy",
          target: record.policy.router, function: record.policy.function,
          value, gas: record.policy.perAccountGas,
        },
        state: record.state, spentGas: this.#budget(record).spent, now,
      });
      return true;
    } catch (error) {
      if (error instanceof PolicyRejection) return false;
      throw error;
    }
  }

  #chainBuy(record: CampaignRecord, account: Address, token: string, value: Uint, now: Date): ChainBuy {
    const reservation = `${record.id}|buy|${account.toLowerCase()}|${value}|${token.toLowerCase()}`;
    return {
      account, key: campaignKey(reservation), value,
      callData: encodeBuyCall(record.policy.function, token as Address, BigInt(value), now),
      maxCost: record.policy.perAccountGas,
    };
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

  /**
   * Control lands on-chain once a session exists: pause/resume/revoke call the
   * policy, and close revokes the session so nothing more is sponsored. The
   * owner reclaims unused ETH through the escrow's own close, which only the
   * owner may call; the service never holds or moves that ETH.
   */
  async #control(wallet: string, body: Record<string, unknown>, event: "pause" | "resume" | "revoke" | "close"): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const nextState = transition(record.state, event);
    const chain = this.#deps.chain;
    if (chain && record.chainAccounts && nextState !== record.state) {
      await chain.control(campaignKey(record.id), event === "close" ? "revoke" : event);
    }
    record.state = nextState;
    if (event === "close") {
      const returned = chain ? "0" : record.budget.close();
      return { status: 200, body: { ...this.#result(record), returnedEth: returned } };
    }
    return { status: 200, body: this.#result(record) };
  }

  /** Accounts the chain says are enrolled join the record, so restored records can buy. */
  async #syncEnrolled(record: CampaignRecord, chain: FleetChain, requested: readonly Address[]): Promise<void> {
    const known = new Set((record.chainAccounts ?? []).map((account) => account.toLowerCase()));
    for (const account of requested) {
      if (known.has(account.toLowerCase())) continue;
      if (await chain.isEnrolled(campaignKey(record.id), account)) {
        record.chainAccounts = [...(record.chainAccounts ?? []), account.toLowerCase() as Address];
        known.add(account.toLowerCase());
      }
    }
  }

  async #activate(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const nextState = transition(record.state, "activate");
    if (this.#deps.chain && !record.chainAccounts) {
      record.chainAccounts = await this.#deps.chain.activate(campaignKey(record.id), record.accounts, record.policy);
    }
    record.state = nextState;
    return {
      status: 200,
      body: {
        ...this.#result(record),
        accounts: record.chainAccounts ?? record.accounts.map((account) => account.ownerAddress),
      },
    };
  }

  async #read(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    return { status: 200, body: { ...this.#result(record), results: [] } };
  }

  #result(record: CampaignRecord, options: { fee?: boolean } = {}): Record<string, unknown> {
    return {
      campaign: record.id,
      state: record.state,
      ...(options.fee ? { fee: record.fee } : {}),
      budget: this.#budget(record),
    };
  }
}

/** Approved-function calldata for the demo buy: router.function(token, value). */
const encodeExecuteData = (token: Address, value: Uint): `0x${string}` =>
  `0x${token.slice(2).padStart(64, "0")}${BigInt(value).toString(16).padStart(64, "0")}` as `0x${string}`;

const functionForSelector = (selector: string): string =>
  selector.toLowerCase() === UNIVERSAL_ROUTER_EXECUTE_SELECTOR ? UNIVERSAL_ROUTER_EXECUTE : selector.toLowerCase();

/** The state the chain implies for an activated campaign, terminal cases first. */
const restoredState = (found: OnChainCampaign, now: Date): CampaignState => {
  const session = found.session!;
  if (session.revoked) return "Revoked";
  if (Number(session.expiry) * 1000 <= now.getTime()) return "Expired";
  if (found.budget.unused < session.perAccountGas) return "Depleted";
  return session.paused ? "Paused" : "Active";
};

const restoredRecord = (id: string, owner: string, found: OnChainCampaign, now: Date): CampaignRecord => {
  const session = found.session!;
  const policy: Policy = {
    chainId: Number(session.chainId), accounts: 0, router: session.router.toLowerCase() as Address,
    function: functionForSelector(session.selector), maxTradeValue: session.maxTradeValue.toString(),
    perAccountGas: session.perAccountGas.toString(), totalGas: session.totalGas.toString(),
    expiry: new Date(Number(session.expiry) * 1000).toISOString(),
  };
  return {
    id, ownerWallet: owner, policy, accounts: [],
    // The vault commitment never touches the chain; a restored record cannot
    // recover it and never needs it after activation.
    recoveryVaultCommitment: `0x${"0".repeat(64)}` as Hex,
    state: restoredState(found, now),
    fee: { ...openQuote("restored"), ...OPEN_ACCESS_CHARGE },
    budget: new CampaignBudget(found.budget.funded.toString()),
    chainAccounts: [],
    chainBudget: {
      funded: found.budget.funded.toString(), reserved: found.budget.reserved.toString(),
      spent: found.budget.spent.toString(), unused: found.budget.unused.toString(),
    },
  };
};

/** Maps every thrown domain error onto the fleet-api.md status table. */
const errorResult = (error: unknown): RouterResult => {
  let code: string | undefined;
  let status: number | undefined;
  if (error instanceof ServiceError || error instanceof CampaignStateError || error instanceof BudgetError) {
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

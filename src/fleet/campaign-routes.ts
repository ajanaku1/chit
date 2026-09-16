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
import type { MarketPort } from "./market.js";
import { createMemoryStore, type StorePort } from "./store.js";
import { orderId, planSlices, PlanError, windowFor, type Order, type Slice } from "./order-plan.js";
import { DRAW_CAP, MIN_GAS_CEILING, createSweepGate, minimumDraw, type DrawSummary, type PoolPort, type PooledBuy } from "./pool-buy.js";
import { PolicyRejection, authorize, type SessionKey } from "./session-policy.js";
import { buildPackedUserOp, encodeExecuteCall, type UserOperationSubmitter } from "./user-operation.js";
import { UNIVERSAL_ROUTER_EXECUTE, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, encodeBuyCall, minOutFor } from "./v4-swap.js";
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
  /** Read-only market facts for the trading panel; absent means tokenQuote/order/holdings/list answer 503. */
  market?: MarketPort;
  /**
   * The tokens the venue trades: the default portfolio, so a trader sees what
   * their fleet holds without the browser remembering which orders it placed.
   */
  venueTokens?: readonly Address[];
  /**
   * Slice claims and the operator lock, shared across instances when the
   * store is (Neon on chit.tools). Absent means this instance's memory, which
   * is the right default for a single process and for unit tests.
   */
  store?: StorePort;
  /**
   * Tokens a sponsored buy may target. Absent means any 20-byte value, which
   * on a public chain means any reverting or worthless pool is a free way to
   * spend the operator's gas; set it to the venue tokens the operator stands
   * behind.
   */
  allowedTokens?: readonly Address[];
  /**
   * Slippage a sponsored buy tolerates, in basis points of the spot estimate;
   * default 200. A buy on a real venue is refused when no quote can be read.
   */
  maxSlippageBps?: number;
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
  /**
   * Set when this record was restored from an escrow key rather than looked
   * up by id: `campaignKey` has no inverse, so a key-restored record's `id`
   * is the key itself, and every chain call must use this, not `campaignKey(id)`.
   */
  chainKey?: Hex;
  /** Last on-chain budget read; authoritative whenever `chain` is configured. */
  chainBudget?: Budget;
  /** Stage 2: this campaign's claim on the trader's pool balance. */
  draw?: DrawSummary;
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

/**
 * A trading-panel validation refusal. Unlike a bare `FleetValidationError`
 * (which the fleet-api.md route table collapses to `policy_rejected` at 422,
 * a mapping earlier routes already rely on), the reason here is itself the
 * stable wire code the browser switches on, surfaced at 400.
 */
class TradeValidationError extends FleetValidationError {}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The wire shape of an order carries `entropy` where `Order` carries `seed`.
 * `assertNoSecrets` refuses any request body field literally named `seed`
 * anywhere in its tree, on the assumption it is wallet recovery material; an
 * order's seed is a public PRNG input the browser stores and re-sends openly,
 * not that, so it is renamed at this boundary rather than weakening that guard.
 */
const toWireOrder = (order: Order): Record<string, unknown> => {
  const { seed, ...rest } = order;
  return { ...rest, entropy: seed };
};
const fromWireOrder = (wire: Record<string, unknown>): Record<string, unknown> => {
  const { entropy, ...rest } = wire;
  return { ...rest, seed: entropy };
};

export class CampaignRouter {
  readonly #deps: RouterDeps;
  readonly #campaigns = new Map<string, CampaignRecord>();
  /** `campaignKey(id)` has no inverse; this remembers it for every record this instance created or restored. */
  readonly #keyIndex = new Map<Hex, string>();
  readonly #randomId: () => string;
  /** Ordinary traffic sweeps, but not every request: a sweep is many reads. */
  readonly #sweepGate = createSweepGate(10_000);
  /** Slice claims and the operator lock; see RouterDeps.store. */
  readonly #store: StorePort;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.#randomId = deps.randomId ?? (() => crypto.randomUUID());
    this.#store = deps.store ?? createMemoryStore();
  }

  async handle(request: unknown, idempotencyKey?: string): Promise<RouterResult> {
    try {
      return await this.#dispatch(asRecord(request), idempotencyKey);
    } catch (error) {
      return errorResult(error, String(asRecord(request)["action"] ?? "?"));
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

    if (action === "sweep") return this.#sweep();
    if (action === "status") return this.#status(body);

    const auth = request["auth"] as AuthEnvelope | undefined;
    if (!auth) throw new ServiceError("challenge_invalid", "auth_missing");
    const wallet = await this.#deps.service.verify(String(action), { auth, body });
    assertNoSecrets(body);

    if (action === "read") return this.#read(wallet, body);
    if (action === "balance") return this.#balance(wallet);
    if (action === "tokenQuote") return this.#tokenQuote(wallet, body);
    if (action === "order") return this.#order(wallet, body);
    if (action === "list") return this.#list(wallet);
    if (action === "holdings") return this.#holdings(wallet, body);

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
        case "trade":
          return this.#trade(wallet, body);
        case "withdraw":
          return this.#withdraw(wallet, body);
        case "topUp":
          return this.#topUp(wallet, body);
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
    // A pooled campaign is never registered in the Stage 1 escrow: that
    // registration emits the campaign key beside the owner's address, which is
    // exactly the link this stage exists to stop publishing (FR-009).
    if (this.#deps.chain && !this.#deps.pool) {
      await this.#deps.chain.registerCampaign(campaignKey(id), wallet as Address);
    }
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
    this.#keyIndex.set(campaignKey(record.id).toLowerCase() as Hex, record.id);
    return { status: 201, body: this.#result(record, { fee: true }) };
  }

  #pool(): PoolPort {
    const pool = this.#deps.pool;
    if (!pool) throw new ServiceError("dependency_evidence_invalid", "pool_unconfigured");
    return pool;
  }

  /**
   * One money operation at a time, across instances. Every route that moves
   * money is check-then-act against chain state: read the balance, decide,
   * write. Two of them interleaved both pass the check and both write, and
   * the operator pays twice; two instances signing together also collide on
   * the operator's nonce. The store's lock closes both: per wallet for the
   * check-then-act, and one operator lock for the signing. The balance is
   * still re-read after every write, because the chain is the truth.
   */
  async #serialized<T>(wallet: string, work: () => Promise<T>): Promise<T> {
    return this.#store.withLock(`wallet:${wallet.toLowerCase()}`, () => this.#store.withLock("operator", work));
  }

  /** A trader who has asked to leave gets nothing new drawn, bought or paid until they are out. */
  #refuseIfExiting(balance: { exit: { requestedAt?: string } }): void {
    if (balance.exit.requestedAt) throw new CampaignStateError("state_invalid", "exit_pending");
  }

  /** What the trader holds, is holding back, and may still deposit (FR-002, FR-003). */
  async #balance(wallet: string): Promise<RouterResult> {
    const pool = this.#pool();
    await this.#sweepOpportunistically();
    return { status: 200, body: await pool.balance(wallet as Address) };
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

    return this.#serialized(wallet, async () => {
      const before = await pool.balance(wallet as Address);
      if (before.pool.paused) throw new CampaignStateError("state_invalid", "pool_paused");
      this.#refuseIfExiting(before);
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
    });
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
    await this.#sweepOpportunistically();
    const id = String(body["campaign"] ?? "");
    const record = this.#campaigns.get(id) ?? (await this.#restore(id, wallet));
    if (!record || record.ownerWallet !== wallet) {
      throw new ServiceError("state_invalid", "campaign_unknown");
    }
    await this.#syncDraw(record);
    return record;
  }

  /**
   * Brings a campaign's draw, and the state that follows from it, up to date
   * with the chain. The instance that opened a draw is rarely the one that
   * funds it, so every instance reads the answer rather than remembering it.
   */
  async #syncDraw(record: CampaignRecord): Promise<void> {
    const pool = this.#deps.pool;
    if (!pool) return;
    const draw = await pool.drawOf(this.#key(record));
    if (!draw) return;
    record.draw = draw;
    if (record.state === "Activating" && draw.state === "Funded") {
      record.state = transition(record.state, "activate");
    }
    if (record.state === "Active" && draw.state === "Pending") record.state = "Activating";
  }

  /**
   * A campaign's public state, unsigned (FR-006). Watching a fleet be funded
   * polls, and a signature per tick is unusable; everything returned here is
   * already readable on chain by anyone holding the campaign id, and no
   * depositor is named.
   */
  async #status(body: Record<string, unknown>): Promise<RouterResult> {
    const id = String(body["campaign"] ?? "");
    if (!id) throw new FleetValidationError("invalid_campaign");
    const pool = this.#pool();
    const chain = this.#deps.chain;
    // An id `list` handed out is the chain key itself; hashing it again looks
    // up a campaign that does not exist. The same rule #restore follows.
    const key = isChainKey(id) ? (id.toLowerCase() as Hex) : campaignKey(id);

    await this.#sweepOpportunistically();
    const [draw, session] = await Promise.all([pool.drawOf(key), chain?.sessionOf(key)]);
    if (!draw || !session) throw new ServiceError("state_invalid", "campaign_unknown");

    const found: OnChainCampaign = {
      owner: `0x${"0".repeat(40)}` as Address,
      budget: { funded: 0n, reserved: 0n, spent: 0n, unused: 0n },
      session,
    };
    return { status: 200, body: { campaign: id, state: drawnState(draw, found, this.#now()), draw } };
  }

  /** Funds every draw whose wait is over and posts every charge now due. */
  /** The scheduled sweep: the one place owed charges are queued, in a batch, off any trader's request. */
  async #sweep(): Promise<RouterResult> {
    const pool = this.#pool();
    const chain = this.#deps.chain;
    const report = await pool.sweep(async (campaign) => (chain ? chain.accountsOf(campaign) : []), { queueOwed: true });
    return { status: 200, body: report };
  }

  /**
   * Sweeps as a side effect of ordinary traffic, so a fleet is funded when its
   * wait is over even where the schedule is coarser than the wait. Best effort:
   * the request it rides on must not fail because a sweep did. It never queues
   * owed charges: that batch must not share a window with this request's buy.
   */
  async #sweepOpportunistically(): Promise<void> {
    const { pool, chain } = this.#deps;
    if (!pool || !this.#sweepGate()) return;
    try {
      await pool.sweep(async (campaign) => (chain ? chain.accountsOf(campaign) : []));
    } catch {
      // The scheduled sweep will pick it up; nothing here is the caller's fault.
    }
  }

  /** The draw a trader may commit: within the cap and within their balance. */
  async #requireDrawable(wallet: string, amount: unknown, accounts = 1): Promise<Uint> {
    const pool = this.#pool();
    if (!isUint(amount) || BigInt(amount) === 0n) throw new FleetValidationError("invalid_draw");
    if (BigInt(amount) > DRAW_CAP) throw new BudgetError("budget_exceeded", "draw_cap_exceeded");
    // Below its own headroom a draw can never be funded; refuse it here
    // rather than let every sweep revert on it.
    if (BigInt(amount) < minimumDraw(accounts)) throw new FleetValidationError("draw_below_minimum");

    const balance = await pool.balance(wallet as Address);
    if (balance.pool.paused) throw new CampaignStateError("state_invalid", "pool_paused");
    this.#refuseIfExiting(balance);
    if (BigInt(amount) > BigInt(balance.available)) {
      throw new BudgetError("budget_exceeded", "insufficient_balance");
    }
    return amount;
  }

  /** Raises a depleted campaign's draw from the balance (FR-013). */
  async #topUp(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    return this.#serialized(wallet, async () => {
      const amount = await this.#requireDrawable(wallet, body["amount"]);
      record.draw = await this.#pool().topUpDraw({ campaign: this.#key(record), amount });
      if (record.state === "Depleted") record.state = "Active";
      return { status: 200, body: this.#result(record) };
    });
  }

  /**
   * A campaign this instance never saw is rebuilt from the chain, so any
   * serverless instance can serve buy, control, and read after activation.
   * Before activation the policy exists only in the creating instance.
   */
  async #restore(id: string, wallet: string): Promise<CampaignRecord | undefined> {
    if (!id) return undefined;
    // An id `list` handed out is the chain key itself; hashing it again would
    // look up a campaign that does not exist.
    if (isChainKey(id)) return this.#restoreByKey(id.toLowerCase() as Hex, wallet);
    return this.#restoreFromKey(id, campaignKey(id), wallet);
  }

  /**
   * `list` learns campaigns by their escrow key, not their friendly id, and
   * `campaignKey` has no inverse: the restored record's id is the key itself,
   * remembered on `chainKey` so every later chain call uses the key, not a
   * re-hash of it.
   */
  async #restoreByKey(key: Hex, wallet: string): Promise<CampaignRecord | undefined> {
    return this.#restoreFromKey(key, key, wallet, key);
  }

  async #restoreFromKey(id: string, key: Hex, wallet: string, chainKey?: Hex): Promise<CampaignRecord | undefined> {
    const chain = this.#deps.chain;
    if (!chain) return undefined;
    const pool = this.#deps.pool;
    const found = pool ? await this.#pooledCampaign(chain, pool, key, wallet) : await chain.loadCampaign(key);
    if (!found?.session || found.owner.toLowerCase() !== wallet) return undefined;

    const record = restoredRecord(id, wallet, found, this.#now());
    if (chainKey) record.chainKey = chainKey;
    const draw = await pool?.drawOf(key);
    if (draw) {
      record.draw = draw;
      record.state = drawnState(draw, found, this.#now());
    }
    this.#campaigns.set(id, record);
    this.#keyIndex.set(key.toLowerCase() as Hex, id);
    return record;
  }

  /** `campaignKey(record.id)`, except for a record `list` restored by its escrow key, which has no inverse. */
  #key(record: CampaignRecord): Hex {
    return record.chainKey ?? campaignKey(record.id);
  }

  /**
   * A pooled campaign as the chain holds it: its session from the policy and
   * its owner from the draw's sealed reference. The escrow is not consulted,
   * because a pooled campaign was deliberately never registered there.
   */
  async #pooledCampaign(
    chain: FleetChain, pool: PoolPort, key: Hex, wallet: string,
  ): Promise<OnChainCampaign | undefined> {
    const [session, owner] = await Promise.all([chain.sessionOf(key), pool.ownerOf(key)]);
    if (!session || owner?.toLowerCase() !== wallet) return undefined;
    return { owner: owner as Address, budget: { funded: 0n, reserved: 0n, spent: 0n, unused: 0n }, session };
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
        const budget = await this.#deps.chain.readBudget(this.#key(record));
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
    const allowed = this.#deps.allowedTokens;
    if (allowed && !allowed.some((t) => t.toLowerCase() === token.toLowerCase())) {
      throw new PolicyRejection("token_not_allowed");
    }
    // A record restored from the chain by another instance may not know its
    // fleet size yet; enrolment on chain still refuses strangers, so the cap
    // is only applied when the size is known.
    const fleetSize = Math.max(record.policy.accounts, record.accounts.length, record.chainAccounts?.length ?? 0);
    const requested = parseRequestedAccounts(body["accounts"], fleetSize);

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

    const results: Record<string, unknown>[] = this.#deps.pool && record.draw
      ? await this.#buyFromPool(record, session, requested, token, value, now, wallet)
      : chain
        ? await this.#buyOnChain(record, session, chain, requested, token, value, now)
        : await this.#buyInMemory(record, session, submitter!, requested, token, value, now);

    // FR edge case: the campaign depletes when the remainder cannot fund
    // another permitted request.
    const remaining = record.draw ? record.draw.remaining : this.#budget(record).unused;
    if (record.state === "Active" && BigInt(remaining) < BigInt(record.policy.perAccountGas)) {
      record.state = transition(record.state, "deplete");
    }

    return { status: 200, body: { results } };
  }

  #market(): MarketPort {
    const market = this.#deps.market;
    if (!market) throw new ServiceError("dependency_evidence_invalid", "market_unconfigured");
    return market;
  }

  /** The token's pool and price, with the per-slice cap and window this fleet would get. */
  async #tokenQuote(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const token = String(body["token"] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new TradeValidationError("invalid_token");
    const total = /^\d+$/.test(String(body["totalWei"] ?? "")) ? String(body["totalWei"]) : "0";
    const quote = await this.#market().tokenQuote(token as Address, total);
    return { status: 200, body: { ...quote, windowMs: windowFor(record.policy.accounts), capWei: record.policy.maxTradeValue } };
  }

  /** Validates an order and returns its plan. Nothing executes here. */
  async #order(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const { order, slices } = await this.#validatedOrder(record, wallet as Address, fromWireOrder(body));
    return { status: 200, body: { order: toWireOrder(order), slices } };
  }

  /**
   * Checks an order against fleet policy and the market, and returns its plan.
   * Shared by `order` (placement) and `trade` (execution recomputes the same
   * plan from the browser-held order so any instance agrees on it).
   */
  async #validatedOrder(record: CampaignRecord, owner: Address, body: Record<string, unknown>): Promise<{ order: Order; slices: Slice[] }> {
    if (!canSponsor(record.state)) throw new PolicyRejection(`state_not_sponsorable:${record.state}`);
    const token = String(body["token"] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new TradeValidationError("invalid_token");
    const wallets = Array.isArray(body["wallets"]) ? (body["wallets"] as Address[]) : [];
    const seed = String(body["seed"] ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new TradeValidationError("invalid_seed");
    const createdAt = String(body["createdAt"] ?? "");
    if (Number.isNaN(Date.parse(createdAt))) throw new TradeValidationError("invalid_created_at");
    const totalWei = String(body["totalWei"] ?? "");
    if (!/^\d+$/.test(totalWei)) throw new TradeValidationError("invalid_total");

    // Nothing new leaves the pool for a wallet on its way out of it.
    if (this.#deps.pool) {
      const { exit } = await this.#deps.pool.balance(owner);
      if (exit.requestedAt) throw new TradeValidationError("exit_pending");
    }
    // A fresh instance restores the fleet from chain without its accounts; ask
    // the chain before refusing, as a plain buy does.
    if (this.#deps.chain) await this.#syncEnrolled(record, this.#deps.chain, wallets);
    const enrolled = new Set((record.chainAccounts ?? this.#session(record).accounts).map((a) => a.toLowerCase()));
    if (wallets.length === 0 || wallets.some((w) => !enrolled.has(String(w).toLowerCase()))) throw new TradeValidationError("wallets_not_enrolled");

    const remaining = record.draw ? record.draw.remaining : this.#budget(record).unused;
    if (BigInt(totalWei) > BigInt(remaining)) throw new TradeValidationError("over_draw");

    const quote = await this.#market().tokenQuote(token as Address, totalWei);
    if (!quote.hasPool) throw new TradeValidationError("no_pool");

    const draft: Omit<Order, "id"> = {
      campaign: record.id, token: token as Address, totalWei, wallets, seed: seed as Hex,
      windowMs: Number(body["windowMs"] ?? windowFor(record.policy.accounts)), createdAt, owner,
    };
    let slices: Slice[];
    try {
      slices = planSlices(draft, record.policy.maxTradeValue);
    } catch (error) {
      if (error instanceof PlanError) throw new TradeValidationError(error.code);
      throw error;
    }
    return { order: { ...draft, id: orderId(draft) }, slices };
  }

  /**
   * Executes the slices of a browser-held order that are due and that the
   * browser still reports pending. The plan is recomputed from the order, so
   * any instance agrees on it; a slice is claimed in the store before it runs,
   * so two polls landing on two instances still run it once.
   */
  async #trade(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const given = asRecord(body["order"]);
    const { order, slices } = await this.#validatedOrder(record, wallet as Address, { ...fromWireOrder(given), campaign: record.id });
    if (String(given["id"] ?? "").toLowerCase() !== order.id.toLowerCase() || String(given["owner"] ?? "").toLowerCase() !== wallet.toLowerCase()) {
      throw new TradeValidationError("order_tampered");
    }
    const pending = new Set((Array.isArray(body["pending"]) ? (body["pending"] as unknown[]) : []).map(Number));
    const now = this.#now();
    const due = [];
    for (const slice of slices) {
      if (!pending.has(slice.index) || Date.parse(slice.dueAt) > now.getTime()) continue;
      if (await this.#store.claimSlice(`${order.id}|${slice.index}`)) due.push(slice);
    }

    const { submitter, chain } = this.#deps;
    if (!submitter && !chain) throw new ServiceError("dependency_evidence_invalid", "submitter_unconfigured");
    if (chain) await this.#syncEnrolled(record, chain, due.map((s) => s.wallet));
    const session = this.#session(record);
    const executed: Record<string, unknown>[] = [];
    for (const slice of due) {
      // One slice at a time: sizes differ per wallet, and the pooled path takes one value per call.
      const results = this.#deps.pool && record.draw
        ? await this.#buyFromPool(record, session, [slice.wallet], order.token, slice.amountWei, now, wallet)
        : chain
          ? await this.#buyOnChain(record, session, chain, [slice.wallet], order.token, slice.amountWei, now)
          : await this.#buyInMemory(record, session, submitter!, [slice.wallet], order.token, slice.amountWei, now);
      const result = results[0] ?? { status: "rejected", reason: "no_result" };
      if (result["status"] !== "sponsored") console.warn(`trade: slice ${slice.index} of ${order.id} ${String(result["status"])}: ${String(result["reason"] ?? "")}`);
      if (result["status"] !== "sponsored") await this.#store.releaseSlice(`${order.id}|${slice.index}`);
      executed.push({ index: slice.index, wallet: slice.wallet, amountWei: slice.amountWei, ...result });
    }
    const later = slices
      .filter((s) => pending.has(s.index) && !executed.some((e) => e["index"] === s.index))
      .map((s) => Date.parse(s.dueAt))
      .filter((t) => t > now.getTime());
    return { status: 200, body: { executed, nextDueAt: later.length ? new Date(Math.min(...later)).toISOString() : null, draw: record.draw } };
  }

  /** The fleets this wallet registered on the escrow, in the state the chain gives them now. */
  async #list(wallet: string): Promise<RouterResult> {
    // Stage 1 fleets are registered on the escrow; Stage 2 fleets never are (that
    // registration would publish the owner beside the campaign), so those come
    // from the pool's sealed owner references instead. Union, dedupe, keep order.
    const [escrowKeys, poolKeys] = await Promise.all([
      this.#market().campaignsOf(wallet as Address),
      this.#deps.pool?.campaignsOf?.(wallet as Address) ?? Promise.resolve([] as Hex[]),
    ]);
    const keys = [...new Set([...escrowKeys, ...poolKeys].map((k) => k.toLowerCase() as Hex))];
    const fleets: Record<string, unknown>[] = [];
    for (const key of keys) {
      const id = this.#keyIndex.get(key.toLowerCase() as Hex) ?? key;
      const record = this.#campaigns.get(id) ?? (await this.#restoreByKey(key as Hex, wallet));
      if (!record) continue;
      await this.#syncDraw(record);
      fleets.push({
        campaign: record.id, state: record.state,
        remaining: record.draw ? record.draw.remaining : this.#budget(record).unused,
        accounts: (await this.#accountsOf(record)).length,
      });
    }
    return { status: 200, body: { fleets } };
  }

  /** Each of this fleet's enrolled accounts' ETH and the tokens the browser asks about. */
  async #holdings(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const asked = (Array.isArray(body["tokens"]) ? (body["tokens"] as string[]) : [])
      .filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t)) as Address[];
    // The venue's tokens are always in the portfolio; the browser's list adds to them.
    const tokens = [...new Map([...(this.#deps.venueTokens ?? []), ...asked].map((t) => [t.toLowerCase(), t as Address])).values()];
    const accounts = await this.#accountsOf(record);
    const market = this.#market();
    const [holdings, quotes] = await Promise.all([
      market.holdings(accounts, tokens),
      Promise.all(tokens.map((t) => market.tokenQuote(t, "0").catch(() => undefined))),
    ]);
    const symbols = Object.fromEntries(tokens.map((t, i) => [t.toLowerCase(), quotes[i]?.symbol ?? "?"]));
    return { status: 200, body: { holdings, symbols } };
  }

  /**
   * Pooled buys: each permitted account's principal leaves the pool only inside
   * its own buy, and the charge against the depositor is queued separately so
   * no transaction names both the campaign and the trader.
   */
  async #buyFromPool(
    record: CampaignRecord, session: SessionKey, requested: Address[],
    token: string, value: Uint, now: Date, wallet: string,
  ): Promise<Record<string, unknown>[]> {
    const pool = this.#pool();
    return this.#serialized(wallet, async () => {
    this.#refuseIfExiting(await pool.balance(wallet as Address));
    // The cached record may be Active on this instance while the chain says
    // paused or revoked, because the control route ran on another instance.
    // Money moves on what the chain says, never on what this instance remembers.
    const chain = this.#deps.chain;
    if (chain) {
      const live = await chain.sessionOf(this.#key(record));
      if (live?.revoked) { record.state = "Revoked"; throw new CampaignStateError("state_invalid", "session_revoked"); }
      if (live?.paused) { record.state = "Paused"; throw new CampaignStateError("state_invalid", "session_paused"); }
    }
    if (BigInt(record.policy.perAccountGas) < MIN_GAS_CEILING) throw new PolicyRejection("gas_ceiling_too_low");
    const minOut = await this.#minOut(record, token as Address, value);
    const refused: Record<string, unknown>[] = [];
    const buys: PooledBuy[] = [];
    for (const account of requested) {
      const refusal = this.#refusal(record, session, account, value, now);
      if (refusal === undefined) {
        buys.push({
          account,
          value,
          callData: encodeBuyCall(record.policy.function, token as Address, BigInt(value), now, minOut),
          maxCost: record.policy.perAccountGas,
        });
      } else {
        refused.push({ account, status: "rejected", reason: refusal, draw: record.draw });
      }
    }
    if (buys.length === 0) return refused;

    const report = await pool.buy({
      campaign: this.#key(record),
      depositor: wallet as Address,
      target: record.policy.router,
      buys,
    });
    record.draw = report.draw;
    return [...refused, ...report.results.map((result) => ({ ...result, draw: report.draw }))];
    });
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
    const minOut = await this.#minOut(record, token as Address, value);
    const refused: Record<string, unknown>[] = [];
    const permitted: ChainBuy[] = [];
    for (const account of requested) {
      const refusal = this.#refusal(record, session, account, value, now);
      if (refusal === undefined) {
        permitted.push(this.#chainBuy(record, account, token, value, now, minOut));
      } else {
        refused.push({ account, status: "rejected", reason: refusal, budget: this.#budget(record) });
      }
    }
    if (permitted.length === 0) return refused;
    const report = await chain.buy(this.#key(record), record.policy.router, permitted);
    record.chainBudget = report.budget;
    return [...refused, ...report.results.map((r) => ({ ...r, budget: report.budget }))];
  }

  /** True when the session policy admits a buy for this account; false on a policy refusal. */
  /** Why the policy refuses this account for this buy, or undefined when it permits it. */
  #refusal(record: CampaignRecord, session: SessionKey, account: Address, value: Uint, now: Date): string | undefined {
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
      return undefined;
    } catch (error) {
      if (error instanceof PolicyRejection) return error.reason;
      throw error;
    }
  }

  /**
   * The least a buy on the real venue may return. Read from the pool's spot
   * price at request time, less the tolerated slippage. Without it every
   * sponsored buy was a market order with amountOutMinimum zero, which on a
   * public chain is an invitation to be sandwiched for the whole principal.
   * The fixture venue used by tests has no pool and takes no minimum.
   */
  async #minOut(record: CampaignRecord, token: Address, value: Uint): Promise<bigint> {
    if (record.policy.function !== UNIVERSAL_ROUTER_EXECUTE) return 0n;
    const market = this.#deps.market;
    if (!market) throw new ServiceError("dependency_evidence_invalid", "market_unconfigured");
    const quote = await market.tokenQuote(token, value);
    if (!quote.hasPool) throw new PolicyRejection("no_pool_for_token");
    const minOut = minOutFor(BigInt(quote.estimatedOut), this.#deps.maxSlippageBps ?? 200);
    if (minOut === 0n) throw new PolicyRejection("no_quote_for_token");
    return minOut;
  }

  #chainBuy(record: CampaignRecord, account: Address, token: string, value: Uint, now: Date, minOut = 0n): ChainBuy {
    const reservation = `${record.id}|buy|${account.toLowerCase()}|${value}|${token.toLowerCase()}`;
    return {
      account, key: campaignKey(reservation), value,
      callData: encodeBuyCall(record.policy.function, token as Address, BigInt(value), now, minOut),
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
      await chain.control(this.#key(record), event === "close" ? "revoke" : event);
    }
    record.state = nextState;
    if (event === "close") {
      // With a pool, the unspent draw was never moved: closing releases it back
      // to the balance and transfers nothing, so nothing is published.
      if (this.#deps.pool) {
        const closed = await this.#deps.pool.closeDraw(this.#key(record));
        const credited = record.draw?.remaining ?? "0";
        if (closed) record.draw = closed;
        return { status: 200, body: { ...this.#result(record), creditedToBalance: credited } };
      }
      const returned = chain ? "0" : record.budget.close();
      return { status: 200, body: { ...this.#result(record), returnedEth: returned } };
    }
    return { status: 200, body: this.#result(record) };
  }

  /** Accounts the chain says are enrolled join the record, so restored records can buy. */
  /** The fleet's accounts, fetched from the factory's own event when a restored record has none. */
  async #accountsOf(record: CampaignRecord): Promise<readonly Address[]> {
    if (!record.chainAccounts?.length && this.#deps.chain) {
      const found = await this.#deps.chain.accountsOf(this.#key(record));
      if (found.length) record.chainAccounts = found.map((a) => a.toLowerCase() as Address);
    }
    return record.chainAccounts ?? this.#session(record).accounts;
  }

  async #syncEnrolled(record: CampaignRecord, chain: FleetChain, requested: readonly Address[]): Promise<void> {
    const known = new Set((record.chainAccounts ?? []).map((account) => account.toLowerCase()));
    for (const account of requested) {
      if (known.has(account.toLowerCase())) continue;
      if (await chain.isEnrolled(this.#key(record), account)) {
        record.chainAccounts = [...(record.chainAccounts ?? []), account.toLowerCase() as Address];
        known.add(account.toLowerCase());
      }
    }
  }

  /**
   * Activation. With a pool, it commits a draw from the balance and the fleet
   * is funded later by a sweep, so the campaign reports "Activating" until the
   * wait is over. Without one, Stage 1's behaviour is unchanged.
   */
  async #activate(wallet: string, body: Record<string, unknown>): Promise<RouterResult> {
    const record = await this.#campaign(wallet, body);
    const pool = this.#deps.pool;
    return this.#serialized(wallet, async () => {
    const fleetSize = record.accounts.length;
    let amount = pool ? await this.#requireDrawable(wallet, body["draw"], fleetSize) : undefined;
    const nextState = transition(record.state, pool ? "fund" : "activate");

    if (this.#deps.chain && !record.chainAccounts) {
      record.chainAccounts = await this.#deps.chain.activate(this.#key(record), record.accounts, record.policy);
    }
    if (pool && amount) {
      // The chain activation took time; the balance is read again right
      // before the draw is opened, so a withdrawal or another activation
      // that landed meanwhile cannot leave this draw unbacked.
      amount = await this.#requireDrawable(wallet, amount, fleetSize);
      record.draw = await pool.openDraw({
        campaign: this.#key(record), depositor: wallet as Address, amount,
      });
    }
    record.state = nextState;
    return {
      status: 200,
      body: {
        ...this.#result(record),
        accounts: record.chainAccounts ?? record.accounts.map((account) => account.ownerAddress),
      },
    };
    });
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
      ...(record.draw ? { draw: record.draw } : {}),
      budget: this.#budget(record),
    };
  }
}

/**
 * The accounts a buy names: addresses only, no repeats, never more than the
 * fleet has (when the size is known). Anything else used to reach the chain
 * as a fleet account that was never enrolled, and cost the operator a refused
 * transaction each.
 */
const parseRequestedAccounts = (raw: unknown, fleetSize: number): Address[] => {
  if (!Array.isArray(raw) || raw.length === 0) throw new FleetValidationError("no_accounts");
  const seen = new Set<string>();
  const accounts: Address[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !isAddress(entry)) throw new FleetValidationError("invalid_accounts");
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push(entry as Address);
  }
  if (fleetSize > 0 && accounts.length > fleetSize) throw new FleetValidationError("too_many_accounts");
  return accounts;
};

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

/**
 * The state a pooled campaign is in, read from its draw: the pool is the budget,
 * so the Stage 1 escrow says nothing about it.
 */
const drawnState = (draw: DrawSummary, found: OnChainCampaign, now: Date): CampaignState => {
  const session = found.session!;
  if (session.revoked) return "Revoked";
  if (draw.state === "Closed") return "Closed";
  if (draw.state === "Pending") return "Activating";
  if (Number(session.expiry) * 1000 <= now.getTime()) return "Expired";
  if (BigInt(draw.remaining) < session.perAccountGas) return "Depleted";
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

/** A 32-byte hex id is a chain key `list` handed out, not a friendly id to hash. */
const isChainKey = (id: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(id);

/** Maps every thrown domain error onto the fleet-api.md status table. */
const errorResult = (error: unknown, action = "?"): RouterResult => {
  if (error instanceof TradeValidationError) {
    return { status: 400, body: { code: error.reason, retryable: false } };
  }
  let code: string | undefined;
  let status: number | undefined;
  // The reason travels with the code: "policy_rejected" alone sent a trader
  // who pasted the wrong token to the logs, which do not record it either.
  let reason: string | undefined;
  if (error instanceof ServiceError || error instanceof CampaignStateError || error instanceof BudgetError) {
    code = error.code;
    reason = (error as { reason?: string }).reason;
  } else if (error instanceof PolicyRejection) {
    code = "policy_rejected";
    status = POLICY_REJECTED_STATUS;
    reason = error.reason;
  } else if (error instanceof FleetValidationError) {
    code = "policy_rejected";
    reason = (error as { reason?: string }).reason ?? error.message;
  } else if (error instanceof EligibilityError) {
    code = error.code === "ineligible" ? "ineligible" : "policy_rejected";
  }
  status ??= code === undefined ? undefined : STATUS[code];
  if (code === undefined || status === undefined) throw error;
  if (status >= 400 && code !== "challenge_invalid") console.warn(`fleet route refused: ${action} ${code}${reason ? ` (${reason})` : ""}`);
  return { status, body: { code, retryable: code === "challenge_invalid", ...(reason ? { reason } : {}) } };
};

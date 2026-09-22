/**
 * Stage 2 operator-side money operations against the pool.
 *
 * Reads compose a trader's balance from chain state; writes move money in the
 * shape the privacy claim requires. A withdrawal is paid from the operator's
 * own wallet and only then charged to the depositor, after a delay, so the pool
 * never publishes a transfer from a depositor to a payee.
 */

import { randomUUID } from "node:crypto";

import { parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { FleetPool, PoolDraw, PoolQueued, WriteOutcome } from "./chain-pool.js";
import { DRAW_STATE } from "./chain-pool.js";
import { availableBalance, depositSizes, openDepositor, sealDepositor } from "./pool-ledger.js";
import { createMemoryStore, type SentBatch, type StorePort } from "./store.js";
import type { Uint } from "./types.js";

/** Matches the contract's own delay, so the app never promises a shorter wait. */
export const EXIT_DELAY_SECONDS = 24 * 60 * 60;

/**
 * Mirrors FleetPool.POST_WINDOW: how long after it was queued a charge can
 * still be posted. Past it the contract refuses the posting for good, so the
 * sweep reports the charge as expired instead of asking again every time.
 * test/fleet/pool-sweep-postings.test.ts reads the contract's figure.
 */
export const POST_WINDOW_SECONDS = 12 * 60 * 60;

/**
 * The random window that separates a settlement from the charge it causes.
 * The contract refuses anything under 60 seconds; the service floor sits
 * above it so a block that lands late never turns an activation into a
 * DelayTooShort revert.
 */
export const MIN_DELAY_SECONDS = 90;
export const MAX_DELAY_SECONDS = 900;

/**
 * The least a gas ceiling may be. A ceiling the trader sets to a few wei
 * makes every execute fail on gas, which is a free way to hand the trader the
 * principal (see the rollback in settle) at the operator's expense.
 */
export const MIN_GAS_CEILING = parseEther("0.00005");

/**
 * Charges are posted to a depositor in coarse units, always strictly below
 * the exact amount the campaign side recorded. Posted exactly, the wei value
 * of a buy (principal plus the gas the receipt reported) appeared once
 * campaign-keyed in Committed and once depositor-keyed in SpendPosted, and
 * that pair joined a fleet to its wallet across two public logs. Rounded
 * down to a grain, the two never match, and many charges land on the same
 * few values. The difference, at most one grain, is the operator's loss,
 * never the trader's and never the pool's obligation (FR-031): the pool
 * still owes the depositor what was not charged, and the operator fronted
 * the exact cost. At today's prices a grain is a few cents.
 *
 * The other half is time. A charge used to be queued in the operator's next
 * transaction after the buy that caused it, and that adjacency was a join of
 * its own. Now a buy, a withdrawal or a funding records what is owed in the
 * store and sends nothing depositor-keyed; the sweep queues everything owed
 * in one shuffled batch, each entry on its own random timer, in a transaction
 * that follows no campaign-keyed one. Until it is queued, the balance shows
 * it as owed, so nothing reads as available that a charge already claims.
 */
export const CHARGE_GRAIN = parseEther("0.00001");

export const coarseCharge = (exact: bigint): bigint => {
  if (exact <= CHARGE_GRAIN) return 0n;
  return ((exact - 1n) / CHARGE_GRAIN) * CHARGE_GRAIN;
};

/** The most charges one sweep queues in one transaction; the rest wait for the next. */
export const BATCH_LIMIT = 32;

/** Mirrors FleetPool.GAS_HEADROOM: what fund() seeds into each account. */
export const GAS_HEADROOM = parseEther("0.0002");

/**
 * The smallest draw that can fund a fleet of this size and still buy once.
 * A draw below its own headroom is a draw fund() reverts on forever; the
 * service refuses it before it is opened rather than tripping over it in
 * every sweep.
 */
export const minimumDraw = (accounts: number): bigint => GAS_HEADROOM * BigInt(Math.max(1, accounts)) + 1n;

export type BalanceView = {
  available: Uint;
  /** Recorded against this depositor and not yet queued on chain; already subtracted from `available`. Optional so fakes that predate it still type-check. */
  owed?: Uint;
  deposited: Uint;
  spent: Uint;
  /** Held against campaigns still standing; not spendable, not lost. */
  openDraws: Uint;
  headroom: { sizes: Uint[]; perTraderRemaining: Uint; poolRemaining: Uint };
  /** The pool's caps as deployed, so the app shows what the chain enforces and never a number of its own. */
  caps?: { depositor: Uint; draw: Uint; pool: Uint };
  exit: { requestedAt?: string; amount?: Uint; availableAt?: string };
  pool: { paused: boolean };
  /** Where the trader's own deposit and exit transactions go. */
  poolAddress: Address;
};

/** Mirrors the contract constant, so the app refuses what the chain would. */
export const DRAW_CAP = parseEther("0.2");


const DRAW_LABEL = ["None", "Pending", "Funded", "Closed"] as const;
export type DrawState = "Pending" | "Funded" | "Closed";

export type DrawSummary = {
  amount: Uint;
  spent: Uint;
  remaining: Uint;
  /** When the fleet may be funded; the wait is the privacy. */
  dueAt: string;
  state: DrawState;
};

export type PooledBuy = { account: Address; value: Uint; callData: Hex; maxCost: Uint };
/** `spentGas`: the rejection was a transaction that reverted on chain, so the operator paid for it; a refusal before any send spent nothing (T069 counts only these). */
export type PooledBuyOutcome = { account: Address; status: "sponsored" | "rejected"; txHash?: Hex; reason?: string; spentGas?: boolean };
export type PooledBuyInput = {
  campaign: Hex;
  depositor: Address;
  target: Address;
  buys: readonly PooledBuy[];
};
export type PooledBuyReport = { results: PooledBuyOutcome[]; draw: DrawSummary };

/** Resolves a campaign's fleet accounts from the chain, for instances that never saw them. */
export type AccountsResolver = (campaign: Hex) => Promise<Address[]>;

export type WithdrawInput = { depositor: Address; amount: Uint; destination: Address };
/** The payout's hash and the id of the charge recorded for it, queued by a later sweep. `unresolved` when the payout was signed and broadcast but its receipt was not seen: the next sweep resolves it by the hash. */
export type WithdrawReceipt = { payoutTx: Hex; chargeId: string; unresolved?: true };

/**
 * A withdrawal Chit cannot pay right now, and paid nothing towards: the
 * operator's float is short, or the payout was refused before or at the
 * chain. Nothing is recorded; the trader tries again later or takes the
 * no-Chit exit (design-mainnet-beta.md, "the withdrawal-refused state").
 */
export class WithdrawalRefused extends Error {
  readonly code = "withdrawal_unavailable";
  constructor(readonly reason: string) {
    super(`withdrawal_unavailable: ${reason}`);
    this.name = "WithdrawalRefused";
  }
}

/** What the router may ask of the pool. */
export type PoolPort = {
  balance(depositor: Address): Promise<BalanceView>;
  /** The pool's caps as deployed; the service never assumes them. Optional so fakes that predate it still type-check. */
  caps?(): Promise<{ depositor: bigint; draw: bigint; pool: bigint }>;
  withdraw(input: WithdrawInput): Promise<WithdrawReceipt>;
  /** Commits part of a balance to one campaign, funded only after the wait. */
  openDraw(input: { campaign: Hex; depositor: Address; amount: Uint }): Promise<DrawSummary>;
  topUpDraw(input: { campaign: Hex; amount: Uint }): Promise<DrawSummary>;
  drawOf(campaign: Hex): Promise<DrawSummary | undefined>;
  /** The depositor behind a campaign, opened from its sealed owner reference. */
  ownerOf(campaign: Hex): Promise<Address | undefined>;
  /**
   * Every campaign whose sealed owner reference opens to this depositor. Read
   * operator-side from the draws the chain already holds; nothing is published.
   * Optional so fakes that predate it still type-check.
   */
  campaignsOf?(depositor: Address): Promise<Hex[]>;
  closeDraw(campaign: Hex): Promise<DrawSummary | undefined>;
  /**
   * Posts every charge now due and funds every draw whose wait is over. With
   * `queueOwed`, first queues what is owed in one batch: only the scheduled
   * sweep passes it, because a sweep that rides on a trader's request would
   * put that batch in the same window as the request's own buy.
   */
  sweep(accountsOf: AccountsResolver, options?: { queueOwed?: boolean }): Promise<SweepReport>;
  buy(input: PooledBuyInput): Promise<PooledBuyReport>;
};

/** A due charge the sweep tried to post and could not: its public id, and what stopped it. */
export type PostingFailure = { id: string; reason: string };

/**
 * What a sweep did, and what it could not do. Every due charge ends up in
 * exactly one of `posted`, `failed`, `expired` or `unreadable`, because a
 * charge that is not posted inside POST_WINDOW is a hole in the pool, and a
 * hole nobody can see is how a pool ends up short. The last three are
 * optional so fakes that predate them still type-check.
 */
export type SweepReport = {
  funded: Hex[];
  posted: string[];
  queued?: number;
  /** Tried and not posted this time; the next sweep tries again while the window is open. */
  failed?: PostingFailure[];
  /** Past POST_WINDOW and unposted: lost for good. They never leave the queue, so this list only grows. */
  expired?: string[];
  /** Due charges whose depositor this ledger key cannot open. Anything but zero means the key is wrong. */
  unreadable?: number;
  /** The automatic pause this sweep pulled (FR-026, FR-034), and what pulled it. Absent when nothing did. */
  paused?: { trigger: PauseTrigger; detail: string[] };
};

/** The two machine-detectable triggers of FR-026. The third, a depositor losing money, needs a person to confirm. */
export type PauseTrigger = "charge-expired" | "exit-failed";

/**
 * Admits one sweep per interval. A sweep reads every draw and every queued
 * charge, so letting each request run one is how a public RPC gets exhausted;
 * the work still happens often enough to fund a fleet inside its wait.
 */
export const createSweepGate = (intervalMs: number, now: () => number = Date.now): (() => boolean) => {
  let last = -Infinity;
  return () => {
    const at = now();
    if (at - last < intervalMs) return false;
    last = at;
    return true;
  };
};

export type PoolServiceOptions = {
  now?: () => Date;
  /** Seconds to wait before a charge is posted; random inside the window by default. */
  delaySeconds?: () => number;
  /** Where owed spend waits for its batch; the same store the router uses, so instances agree. */
  store?: StorePort;
  /** Drives the batch shuffle; Math.random by default, fixed in tests. */
  random?: () => number;
  randomId?: () => string;
};

const randomDelay = (): number =>
  MIN_DELAY_SECONDS + Math.floor(Math.random() * (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS + 1));

const iso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

export const createPoolService = (
  wallet: WalletClient,
  publicClient: PublicClient,
  pool: FleetPool,
  ledgerKey: Hex,
  options: PoolServiceOptions = {},
): PoolPort => {
  const now = options.now ?? (() => new Date());
  const delay = options.delaySeconds ?? randomDelay;
  const store = options.store ?? createMemoryStore();
  const random = options.random ?? Math.random;
  const randomId = options.randomId ?? (() => randomUUID());

  /** Chain time plus the wait: the contract compares this to block.timestamp. */
  const dueAt = async (): Promise<bigint> => {
    const block = await publicClient.getBlock();
    return block.timestamp + BigInt(delay());
  };

  /**
   * Records the coarse form of a charge as owed; a charge under one grain is
   * the pool's. Nothing is sent: the sweep queues it, in a batch, later.
   */
  const charge = async (depositor: Address, exact: bigint): Promise<string | undefined> => {
    const posted = coarseCharge(exact);
    if (posted === 0n) return undefined;
    const id = randomId();
    await store.recordOwed({ id, depositor, amount: posted.toString(), incurredAt: now().toISOString() });
    return id;
  };

  /** The operator: the account every money-moving write is signed by. */
  const from = (): Address => {
    const address = wallet.account?.address;
    if (!address) throw new Error("the operator wallet has no account");
    return address;
  };

  /**
   * The sealed references this instance sent under each hash. Sealing is
   * random, so nothing but this memory can match a batch to the queue's
   * entries; the receipt is the evidence that crosses instances.
   */
  const sentRefs = new Map<Hex, readonly Hex[]>();

  /**
   * What a sent transaction came to, applied to its rows. Unknown is left
   * sent for the next sweep; nothing here reads an exception as proof of
   * anything (M4). A batch that reverted or never mined goes back to the
   * next sweep, unless the queue already carries the references this
   * instance sent, in which case it landed and the rows are the chain's.
   */
  const settleSent = async (batch: SentBatch, outcome: WriteOutcome): Promise<void> => {
    if (outcome.status === "unknown") {
      console.warn(`sweep: ${batch.kind} ${batch.txHash} (nonce ${batch.nonce}) is still unresolved; ${batch.ids.length} row(s) stay sent`);
      return;
    }
    if (batch.kind === "payout") {
      await store.resolveSent(batch.ids, outcome.status === "mined" ? "owed" : "void");
      if (outcome.status !== "mined") console.error(`withdrawal payout ${batch.txHash} ${outcome.status}: nothing was paid, its charge is void`);
      return;
    }
    if (outcome.status === "mined") {
      await store.resolveSent(batch.ids, "confirmed");
      return;
    }
    const refs = sentRefs.get(batch.txHash);
    if (refs && (await pool.queued()).some((entry) => refs.includes(entry.encDepositor))) {
      await store.resolveSent(batch.ids, "confirmed");
      return;
    }
    await store.resolveSent(batch.ids, "owed");
    console.error(`sweep: batch ${batch.txHash} ${outcome.status}: ${batch.ids.length} charge(s) go back to the next sweep`);
  };

  /** Every batch left sent by an earlier run, resolved by its hash before anything new is queued. */
  const resolveSent = async (): Promise<void> => {
    for (const batch of await store.sentBatches()) {
      await settleSent(batch, await pool.resolve(batch.txHash, batch.nonce, from()));
    }
  };

  /**
   * One transaction for everything owed: entries shuffled so their order says
   * nothing about the order of the buys, each with its own random due time.
   * The rows are marked sent under the hash before the broadcast; only a
   * failure before the signature releases them on the spot.
   */
  const queueOwed = async (): Promise<number> => {
    const owed = await store.takeOwed(BATCH_LIMIT);
    if (owed.length === 0) return 0;
    for (let i = owed.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [owed[i], owed[j]] = [owed[j]!, owed[i]!];
    }
    const ids = owed.map((o) => o.id);
    const refs = owed.map((o) => sealDepositor(ledgerKey, o.depositor));
    let nonce = 0;
    let outcome: WriteOutcome;
    try {
      const base = await chainSeconds();
      nonce = await pool.nextNonce(from());
      outcome = await pool.signAndBroadcast({
        nonce,
        functionName: "queueSpendBatch",
        args: [refs, owed.map((o) => BigInt(o.amount)), owed.map(() => base + BigInt(delay()))],
        record: async (hash, signedNonce) => {
          sentRefs.set(hash, refs);
          await store.markSent(ids, hash, signedNonce, "batch");
        },
      });
    } catch (error) {
      // Before the signature, or inside record: nothing was broadcast.
      await store.releaseOwed(ids);
      console.error(`sweep: batch of ${owed.length} charges not queued: ${messageOf(error)}`);
      return 0;
    }
    await settleSent({ txHash: outcome.hash, nonce, ids, kind: "batch" }, outcome);
    return outcome.status === "mined" ? owed.length : 0;
  };

  const chainSeconds = async (): Promise<bigint> => (await publicClient.getBlock()).timestamp;

  /**
   * The automatic pause (T050): a charge that passed its deadline unrecorded,
   * or an exit that would fail if sent, pulls the brake in the same sweep
   * that saw it (FR-034). A charge that expired before the pool was last
   * resumed has been dealt with, by the resume gate, and does not pull it
   * again; an exit that would still fail does, because the pool is not
   * whole. Only the scheduled sweep looks, since it is the one that reads
   * every queued charge anyway.
   */
  const pauseIfTriggered = async (expiredIds: readonly string[], queued: readonly PoolQueued[], seconds: bigint): Promise<SweepReport["paused"]> => {
    if (!pool.pause) return undefined;
    const since = pool.lastResumedAt ? await pool.lastResumedAt() : 0n;
    const fresh = queued.filter((q) => expiredIds.includes(q.id) && q.queuedAt + BigInt(POST_WINDOW_SECONDS) > since).map((q) => q.id);
    let trigger: PauseTrigger | undefined;
    let detail: string[] = [];
    if (fresh.length > 0) {
      trigger = "charge-expired";
      detail = fresh;
    } else if (pool.exitsRequested && pool.exitWouldFail) {
      for (const depositor of await pool.exitsRequested()) {
        const record = await pool.depositorOf(depositor);
        if (record.exitRequestedAt === 0n || seconds < record.exitRequestedAt + BigInt(EXIT_DELAY_SECONDS)) continue;
        if (await pool.exitWouldFail(depositor)) {
          trigger = "exit-failed";
          // Never the depositor: an exit that fails is public the moment it is sent, but this one was not.
          detail = [`an exit due at ${iso(record.exitRequestedAt + BigInt(EXIT_DELAY_SECONDS))} would revert`];
          break;
        }
      }
    }
    if (!trigger) return undefined;
    if (await pool.paused()) return { trigger, detail };
    const hash = await pool.pause();
    console.error(`pause: ${trigger} (${detail.join(", ")}); the pool is paused in ${hash}; nothing moves until the resume gate passes`);
    return { trigger, detail };
  };

  /**
   * An expired charge never leaves the queue, and ordinary traffic sweeps
   * every few seconds, so a line per sweep would bury the log it is meant to
   * be found in. Each loss is said once per instance; the report counts it
   * every time. The same for unreadable charges: said when the number moves.
   */
  const saidExpired = new Set<string>();
  let saidUnreadable = 0;
  const sayWhatIsNew = (expired: readonly string[], unreadable: number): void => {
    const fresh = expired.filter((id) => !saidExpired.has(id));
    for (const id of fresh) saidExpired.add(id);
    if (fresh.length > 0) {
      console.error(`sweep: ${fresh.length} charge(s) passed POST_WINDOW unposted and are lost to the pool: ${fresh.join(", ")}`);
    }
    if (unreadable !== saidUnreadable && unreadable > 0) {
      console.error(`sweep: ${unreadable} due charge(s) cannot be opened with this ledger key and will expire unposted; check FLEET_LEDGER_KEY`);
    }
    saidUnreadable = unreadable;
  };

  return {
    caps: () => pool.caps(),
    async balance(depositor) {
      const [inputs, headroom, paused, record, caps] = await Promise.all([
        pool.ledgerInputs(depositor),
        pool.headroom(depositor),
        pool.paused(),
        pool.depositorOf(depositor),
        pool.caps(),
      ]);

      const mine = (ref: Hex): boolean =>
        openDepositor(ledgerKey, ref)?.toLowerCase() === depositor.toLowerCase();
      const openDraws = inputs.draws
        .filter((draw) => draw.state === DRAW_STATE.pending || draw.state === DRAW_STATE.funded)
        .filter((draw) => mine(draw.ownerRef))
        .reduce((total, draw) => total + draw.amount, 0n);

      const exit = record.exitRequestedAt === 0n
        ? {}
        : {
            requestedAt: iso(record.exitRequestedAt),
            amount: record.exitAmount.toString(),
            availableAt: iso(record.exitRequestedAt + BigInt(EXIT_DELAY_SECONDS)),
          };

      const owed = BigInt(await store.owedFor(depositor));
      const available = availableBalance(ledgerKey, depositor, inputs) - owed;
      return {
        available: (available > 0n ? available : 0n).toString(),
        owed: owed.toString(),
        deposited: record.deposited.toString(),
        spent: record.spent.toString(),
        openDraws: openDraws.toString(),
        headroom: {
          sizes: depositSizes(headroom.perDepositor, headroom.perPool).map(String),
          perTraderRemaining: headroom.perDepositor.toString(),
          poolRemaining: headroom.perPool.toString(),
        },
        caps: { depositor: caps.depositor.toString(), draw: caps.draw.toString(), pool: caps.pool.toString() },
        exit,
        pool: { paused },
        poolAddress: pool.address,
      };
    },

    async withdraw({ depositor, amount, destination }) {
      const value = BigInt(amount);
      const operator = from();
      // The operator's own balance pays this. Short of the payout and the gas
      // to send it, the answer is a refusal that recorded nothing and can be
      // retried, never a charge for a payout that could not happen (M1, T021).
      const [balance, gasPrice] = await Promise.all([publicClient.getBalance({ address: operator }), publicClient.getGasPrice().catch(() => 0n)]);
      if (balance < value + 21_000n * gasPrice * 2n) throw new WithdrawalRefused("operator_float_short");
      // The charge is recorded before the payout, then named by the payout's
      // hash before the broadcast: a failure between the two leaves a charge
      // that the next sweep resolves by that hash and voids if nothing was
      // paid; paid-but-unrecorded cannot happen, because the hash is known
      // before the node is.
      const chargeId = await charge(depositor, value);
      const ids = chargeId ? [chargeId] : [];
      // Paid by the operator, not the pool: a pool payout would publish the
      // depositor beside the address they chose to be paid at. The payout is
      // the exact amount asked for; the charge posted later is its coarse
      // form, so the transfer to the payee and the charge to the depositor
      // never carry the same number.
      let nonce = 0;
      let outcome: WriteOutcome;
      try {
        nonce = await pool.nextNonce(operator);
        outcome = await pool.signAndBroadcast({ nonce, to: destination, value, record: (hash, signedNonce) => store.markSent(ids, hash, signedNonce, "payout") });
      } catch (error) {
        // Nothing was broadcast: the charge is void and the trader may try again.
        await store.resolveSent(ids, "void");
        throw new WithdrawalRefused(reasonOf(error));
      }
      await settleSent({ txHash: outcome.hash, nonce, ids, kind: "payout" }, outcome);
      if (outcome.status === "reverted" || outcome.status === "never-mined") throw new WithdrawalRefused(`payout_${outcome.status.replace("-", "_")}`);
      return { payoutTx: outcome.hash, chargeId: chargeId ?? "", ...(outcome.status === "unknown" ? { unresolved: true as const } : {}) };
    },

    async openDraw({ campaign, depositor, amount }) {
      await pool.openDraw(campaign, BigInt(amount), await dueAt(), sealDepositor(ledgerKey, depositor));
      return summarize((await pool.drawOf(campaign))!);
    },

    async topUpDraw({ campaign, amount }) {
      await pool.topUpDraw(campaign, BigInt(amount));
      return summarize((await pool.drawOf(campaign))!);
    },

    async drawOf(campaign) {
      const draw = await pool.drawOf(campaign);
      return draw ? summarize(draw) : undefined;
    },

    async ownerOf(campaign) {
      const draw = await pool.drawOf(campaign);
      return draw ? openDepositor(ledgerKey, draw.ownerRef) : undefined;
    },

    async campaignsOf(depositor) {
      const draws = await pool.draws();
      return draws
        .filter((draw) => openDepositor(ledgerKey, draw.ownerRef)?.toLowerCase() === depositor.toLowerCase())
        .map((draw) => draw.campaign);
    },

    async closeDraw(campaign) {
      const draw = await pool.drawOf(campaign);
      if (!draw || draw.state === DRAW_STATE.closed) return draw ? summarize(draw) : undefined;
      await pool.closeDraw(campaign);
      return summarize((await pool.drawOf(campaign))!);
    },

    /**
     * Idempotent by construction: it acts only on draws whose wait is over and
     * charges whose time has come, so running it twice funds nothing twice.
     *
     * Charges are posted before draws are funded, and every draw is its own
     * try: a single draw that cannot be funded (an account that refuses ETH,
     * a draw smaller than its own headroom) used to abort the sweep before
     * the posting loop, which stopped funding and posting for every other
     * trader until someone noticed, and let every queued charge run out its
     * twelve hour window. Now it costs that one draw and nothing else.
     */
    async sweep(accountsOf, options = {}) {
      // Owed first, and only on the scheduled sweep: what the batch queues is
      // charges recorded in earlier requests, sent from a transaction window
      // that no trader's request opened.
      if (options.queueOwed) await resolveSent();
      const queued = options.queueOwed ? await queueOwed() : 0;
      const seconds = await chainSeconds();

      // Every due charge is accounted for: posted, failed with a reason,
      // expired, or unreadable. A charge that misses its window is never the
      // trader's loss and the exit must not wait for it, but it is a hole in
      // the pool, so it gets a number and a line instead of an empty catch.
      const posted: string[] = [];
      const failed: PostingFailure[] = [];
      const expired: string[] = [];
      let unreadable = 0;
      const queuedNow = await pool.queued();
      for (const entry of queuedNow) {
        if (entry.posted || entry.dueAt > seconds) continue;
        // The contract refuses it for good from here on; asking again on every
        // sweep costs a call and says nothing new.
        if (seconds > entry.queuedAt + BigInt(POST_WINDOW_SECONDS)) {
          expired.push(entry.id);
          continue;
        }
        const depositor = openDepositor(ledgerKey, entry.encDepositor);
        if (!depositor) {
          unreadable += 1;
          continue;
        }
        try {
          await pool.postQueued(entry.id, depositor);
          posted.push(entry.id);
        } catch (error) {
          const reason = postingReason(error);
          failed.push({ id: entry.id, reason });
          // The id is public since SpendQueued. The depositor is not, until
          // the posting lands, so it is never logged; nor is anything past
          // the error's first line, where viem prints the call it was making.
          console.error(`sweep: charge ${entry.id} not posted (${reason}): ${messageOf(error)}`);
        }
      }
      sayWhatIsNew(expired, unreadable);
      const pausedNow = options.queueOwed ? await pauseIfTriggered(expired, queuedNow, seconds) : undefined;

      const funded: Hex[] = [];
      for (const draw of await pool.draws()) {
        if (draw.state !== DRAW_STATE.pending || draw.dueAt > seconds) continue;
        try {
          const accounts = await accountsOf(draw.campaign);
          if (accounts.length === 0) continue;
          const seeded = GAS_HEADROOM * BigInt(accounts.length);
          // fund() reverts DrawExceeded on this; skipping is cheaper than
          // paying for the revert on every sweep until the draw is closed.
          if (draw.amount - draw.spent < seeded) continue;
          const outcome = await signed("fund", [draw.campaign, accounts], { kind: "fund", campaign: draw.campaign });
          // Unknown is settled by the draw itself: Pending still means nothing happened; anything else means it did.
          const landed = outcome.status === "mined"
            || (outcome.status === "unknown" && (await pool.drawOf(draw.campaign))?.state !== DRAW_STATE.pending);
          if (!landed) {
            console.error(`sweep: draw ${draw.campaign} not funded: ${outcome.status} (${outcome.hash})`);
            continue;
          }
          funded.push(draw.campaign);
          // The headroom left the pool for accounts the trader owns. It is
          // charged like any other spend: recorded now, queued by a later
          // sweep, posted on its own timer, so nothing pairs the fund with a wallet.
          const depositor = openDepositor(ledgerKey, draw.ownerRef);
          if (depositor) await charge(depositor, seeded);
        } catch (error) {
          console.error(`sweep: draw ${draw.campaign} not funded: ${messageOf(error)}`);
        }
      }
      return { funded, posted, queued, failed, expired, unreadable, ...(pausedNow ? { paused: pausedNow } : {}) };
    },

    async buy({ campaign, depositor, target, buys }) {
      const results: (PooledBuyOutcome & { charged?: bigint })[] = [];
      for (const entry of buys) {
        const outcome = await settle(campaign, target, entry);
        results.push(outcome);
        if (outcome.status === "sponsored" && outcome.charged) {
          await charge(depositor, outcome.charged);
        }
      }
      return {
        results: results.map(({ charged: _charged, ...rest }) => rest),
        draw: summarize((await pool.drawOf(campaign))!),
      };
    },
  };

  /**
   * One buy, one transaction. The pool sends the principal to the account and
   * tells it to execute; if the buy reverts, the transaction reverts and the
   * principal never left. The draw is charged principal plus the gas the
   * contract measured, capped by the ceiling; the charge for the depositor
   * is read back as the draw's spent delta rather than trusted from here.
   *
   * There is no rollback any more, and no window between funding and buying
   * for the account's owner to act in. A failed buy costs the operator the
   * gas of a reverted transaction, bounded by the limit below, and nothing
   * else.
   */
  async function settle(
    campaign: Hex,
    target: Address,
    buy: PooledBuy,
  ): Promise<PooledBuyOutcome & { charged?: bigint }> {
    const principal = BigInt(buy.value);
    const gasCeiling = BigInt(buy.maxCost);
    const before = (await pool.drawOf(campaign))?.spent ?? 0n;
    let outcome: WriteOutcome;
    try {
      const limit = await gasLimitFor(gasCeiling);
      outcome = await signed("fundAndExecute", [campaign, buy.account, principal, gasCeiling, target, buy.callData], { kind: "buy", campaign, account: buy.account }, limit.gas);
    } catch (error) {
      // Nothing was broadcast. Logged as well as returned: a refused buy the browser
      // shows as "failed" should be findable in the function logs, first line only, no secrets.
      console.warn(`buy refused for ${buy.account}: ${messageOf(error)}`);
      return { account: buy.account, status: "rejected", reason: reasonOf(error) };
    }
    const after = (await pool.drawOf(campaign))?.spent ?? before;
    // The draw's spent is the evidence: a buy whose receipt was never seen but whose
    // principal left the draw was sponsored, and is charged like one (M4b).
    const landed = outcome.status === "mined" || (outcome.status === "unknown" && after > before);
    if (!landed) {
      console.warn(`buy ${outcome.status} for ${buy.account}: ${outcome.hash}`);
      return { account: buy.account, status: "rejected", reason: outcome.status === "reverted" ? outcome.reason ?? "execution_refused" : outcome.status, ...(outcome.status === "reverted" ? { spentGas: true, txHash: outcome.hash } : {}) };
    }
    return { account: buy.account, status: "sponsored", txHash: outcome.hash, charged: after - before };
  }

  /**
   * One pool function through the signed step. The hash is recorded in the
   * store's idempotency table before the broadcast, so a transaction this
   * process loses sight of still has a name somewhere durable. A throw here
   * means nothing was broadcast; every outcome after the signature is a value.
   */
  async function signed(functionName: string, args: readonly unknown[], what: Record<string, unknown>, gas?: bigint): Promise<WriteOutcome> {
    const nonce = await pool.nextNonce(from());
    return pool.signAndBroadcast({
      nonce,
      functionName,
      args,
      ...(gas === undefined ? {} : { gas }),
      record: (hash, signedNonce) => store.idempotency.put(`fleet-tx|${hash}`, { payloadHash: hash, result: { ...what, nonce: signedNonce } }),
    });
  }

  /**
   * A gas limit that keeps the execute transaction inside the ceiling at the
   * price the node will charge. If the node cannot say, the transaction runs
   * without a limit, as before; the ceiling is still what the draw is charged.
   */
  async function gasLimitFor(gasCeiling: bigint): Promise<{ gas?: bigint }> {
    try {
      const price = await publicClient.getGasPrice();
      if (price === 0n) return {};
      const limit = gasCeiling / price;
      return { gas: limit > 21_000n ? limit : 21_000n };
    } catch {
      return {};
    }
  }
};

const ctx = (wallet: WalletClient) => ({ account: wallet.account ?? null, chain: wallet.chain ?? null });

/** The first line of an error, which for viem is the sentence and never the request arguments. */
const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/**
 * What stopped a posting: the contract's own error when it names one, else the
 * kind of failure it was. A dropped RPC call is not a refusal, and a report
 * that calls both "refused" cannot tell a closed window from a bad night.
 */
const postingReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const revert = /(?:Error:\s*)?([A-Z][A-Za-z0-9_]*)\(\)/.exec(message)?.[1];
  if (revert) return revert;
  const kind = error instanceof Error ? error.name : "";
  return kind && kind !== "Error" ? kind : "unknown";
};

const reasonOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const named = /(?:Error:\s*)?([A-Z][A-Za-z0-9_]*)\(\)/.exec(message);
  return named?.[1] ?? "execution_refused";
};

const summarize = (draw: PoolDraw): DrawSummary => ({
  amount: draw.amount.toString(),
  spent: draw.spent.toString(),
  remaining: (draw.amount > draw.spent ? draw.amount - draw.spent : 0n).toString(),
  dueAt: new Date(Number(draw.dueAt) * 1000).toISOString(),
  state: DRAW_LABEL[draw.state] as DrawState,
});

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

import type { FleetPool, PoolDraw } from "./chain-pool.js";
import { DRAW_STATE } from "./chain-pool.js";
import { availableBalance, depositSizes, openDepositor, sealDepositor } from "./pool-ledger.js";
import { createMemoryStore, type StorePort } from "./store.js";
import type { Uint } from "./types.js";

/** Matches the contract's own delay, so the app never promises a shorter wait. */
export const EXIT_DELAY_SECONDS = 24 * 60 * 60;

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
 * few values. The difference, at most one grain, is the pool's, never the
 * trader's; at today's prices a grain is a few cents.
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
export type PooledBuyOutcome = { account: Address; status: "sponsored" | "rejected"; txHash?: Hex; reason?: string };
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
/** The payout's hash and the id of the charge recorded for it, queued by a later sweep. */
export type WithdrawReceipt = { payoutTx: Hex; chargeId: string };

/** What the router may ask of the pool. */
export type PoolPort = {
  balance(depositor: Address): Promise<BalanceView>;
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
  sweep(accountsOf: AccountsResolver, options?: { queueOwed?: boolean }): Promise<{ funded: Hex[]; posted: string[]; queued?: number }>;
  buy(input: PooledBuyInput): Promise<PooledBuyReport>;
};

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

  /**
   * One transaction for everything owed: entries shuffled so their order says
   * nothing about the order of the buys, each with its own random due time.
   * A failed transaction releases the rows for the next sweep.
   */
  const queueOwed = async (): Promise<number> => {
    const owed = await store.takeOwed(BATCH_LIMIT);
    if (owed.length === 0) return 0;
    for (let i = owed.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [owed[i], owed[j]] = [owed[j]!, owed[i]!];
    }
    const base = await chainSeconds();
    try {
      const tx = await pool.queueSpendBatch(
        owed.map((o) => sealDepositor(ledgerKey, o.depositor)),
        owed.map((o) => BigInt(o.amount)),
        owed.map(() => base + BigInt(delay())),
      );
      await store.confirmOwed(owed.map((o) => o.id), tx);
      return owed.length;
    } catch (error) {
      await store.releaseOwed(owed.map((o) => o.id));
      console.error(`sweep: batch of ${owed.length} charges not queued: ${messageOf(error)}`);
      return 0;
    }
  };

  const chainSeconds = async (): Promise<bigint> => (await publicClient.getBlock()).timestamp;

  return {
    async balance(depositor) {
      const [inputs, headroom, paused, record] = await Promise.all([
        pool.ledgerInputs(depositor),
        pool.headroom(depositor),
        pool.paused(),
        pool.depositorOf(depositor),
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
        exit,
        pool: { paused },
        poolAddress: pool.address,
      };
    },

    async withdraw({ depositor, amount, destination }) {
      const value = BigInt(amount);
      // The charge is recorded before the payout, not after. Record first and
      // a failure between the two leaves a charge the sweep queues against a
      // payout that never happened, which the exit refunds; pay first and the
      // same failure leaves ETH paid and nothing recorded, and a retry pays
      // it again. Recorded-but-unpaid is recoverable; paid-but-unrecorded is
      // not.
      const chargeId = (await charge(depositor, value)) ?? "";
      // Paid by the operator, not the pool: a pool payout would publish the
      // depositor beside the address they chose to be paid at. The payout is
      // the exact amount asked for; the charge posted later is its coarse
      // form, so the transfer to the payee and the charge to the depositor
      // never carry the same number.
      const payoutTx = await wallet.sendTransaction({
        account: wallet.account ?? null,
        chain: wallet.chain ?? null,
        to: destination,
        value,
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: payoutTx });
      if (receipt.status !== "success") throw new Error(`withdrawal payout reverted: ${payoutTx}`);
      return { payoutTx, chargeId };
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
      const queued = options.queueOwed ? await queueOwed() : 0;
      const seconds = await chainSeconds();

      const posted: string[] = [];
      for (const entry of await pool.queued()) {
        if (entry.posted || entry.dueAt > seconds) continue;
        const depositor = openDepositor(ledgerKey, entry.encDepositor);
        if (!depositor) continue;
        try {
          await pool.postQueued(entry.id, depositor);
          posted.push(entry.id);
        } catch {
          // Past its window: the charge is the operator's loss, never the
          // trader's, and the exit must not be blocked waiting for it.
        }
      }

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
          await pool.fund(draw.campaign, accounts);
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
      return { funded, posted, queued };
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
    let hash: Hex;
    try {
      const limit = await gasLimitFor(gasCeiling);
      hash = await pool.fundAndExecute(campaign, buy.account, principal, gasCeiling, target, buy.callData, limit.gas);
    } catch (error) {
      return { account: buy.account, status: "rejected", reason: reasonOf(error) };
    }
    const after = (await pool.drawOf(campaign))?.spent ?? before;
    return { account: buy.account, status: "sponsored", txHash: hash, charged: after - before };
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

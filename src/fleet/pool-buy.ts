/**
 * Stage 2 operator-side money operations against the pool.
 *
 * Reads compose a trader's balance from chain state; writes move money in the
 * shape the privacy claim requires. A withdrawal is paid from the operator's
 * own wallet and only then charged to the depositor, after a delay, so the pool
 * never publishes a transfer from a depositor to a payee.
 */

import { parseAbi, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import type { FleetPool, PoolDraw } from "./chain-pool.js";
import { DRAW_STATE } from "./chain-pool.js";
import { availableBalance, depositSizes, openDepositor, sealDepositor } from "./pool-ledger.js";
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
 * What this does not do: move the queueing in time. The charge is still
 * queued in the operator's next transaction after the buy, and that
 * adjacency is a join of its own. Breaking it needs the contract to carry
 * uncharged spend until a sweep batches it, which is a design change.
 */
export const CHARGE_GRAIN = parseEther("0.00001");

export const coarseCharge = (exact: bigint): bigint => {
  if (exact <= CHARGE_GRAIN) return 0n;
  return ((exact - 1n) / CHARGE_GRAIN) * CHARGE_GRAIN;
};

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

const ACCOUNT_ABI = parseAbi(["function execute(address target, uint256 value, bytes data) returns (bytes)"]);

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
export type WithdrawReceipt = { payoutTx: Hex; queuedSpendTx: Hex };

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
  /** Funds every draw whose wait is over and posts every charge now due. */
  sweep(accountsOf: AccountsResolver): Promise<{ funded: Hex[]; posted: string[] }>;
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

  /** Chain time plus the wait: the contract compares this to block.timestamp. */
  const dueAt = async (): Promise<bigint> => {
    const block = await publicClient.getBlock();
    return block.timestamp + BigInt(delay());
  };

  /** Queues the coarse form of a charge to its depositor; a charge under one grain is the pool's. */
  const charge = async (depositor: Address, exact: bigint): Promise<Hex | undefined> => {
    const posted = coarseCharge(exact);
    if (posted === 0n) return undefined;
    return pool.queueSpend(sealDepositor(ledgerKey, depositor), posted, await dueAt());
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

      return {
        available: availableBalance(ledgerKey, depositor, inputs).toString(),
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
      // The charge is queued before the payout, not after. Queue first and a
      // failure between the two leaves a charge the sweep posts against a
      // payout that never happened, which the exit refunds; pay first and the
      // same failure leaves ETH paid and nothing recorded, and a retry pays
      // it again. Recorded-but-unpaid is recoverable; paid-but-unrecorded is
      // not.
      const queuedSpendTx = (await charge(depositor, value)) ?? `0x${"0".repeat(64)}`;
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
      return { payoutTx, queuedSpendTx };
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
    async sweep(accountsOf) {
      const seconds = await chainSeconds();

      const posted: string[] = [];
      for (const entry of await pool.queued()) {
        if (entry.posted || entry.dueAt > seconds) continue;
        const depositor = openDepositor(ledgerKey, entry.encDepositor);
        if (!depositor) continue;
        try {
          await pool.postQueued(entry.id, depositor);
          posted.push(entry.id.toString());
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
          // charged like any other spend: queued to the depositor, posted on
          // its own timer, so nothing pairs the fund with a wallet.
          const depositor = openDepositor(ledgerKey, draw.ownerRef);
          if (depositor) await charge(depositor, seeded);
        } catch (error) {
          console.error(`sweep: draw ${draw.campaign} not funded: ${messageOf(error)}`);
        }
      }
      return { funded, posted };
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
   * One buy: reserve and send the principal, execute, then settle at the real
   * cost. The principal cannot be checked by simulation first, because the
   * account does not hold it until this call sends it. On failure the pool is
   * made whole and the draw is charged nothing, so a failed buy never costs the
   * trader; the operator absorbs the principal, which lands in the trader's own
   * fleet account and is theirs to sweep with the owner escape hatch.
   */
  async function settle(
    campaign: Hex,
    target: Address,
    buy: PooledBuy,
  ): Promise<PooledBuyOutcome & { charged?: bigint }> {
    const principal = BigInt(buy.value);
    const gasCeiling = BigInt(buy.maxCost);
    const args = [target, principal, buy.callData] as const;

    try {
      await pool.fundPrincipal(campaign, buy.account, principal, gasCeiling);
    } catch (error) {
      return { account: buy.account, status: "rejected", reason: reasonOf(error) };
    }

    let hash: Hex;
    let charged: bigint;
    try {
      hash = await wallet.writeContract({
        ...ctx(wallet), address: buy.account, abi: ACCOUNT_ABI, functionName: "execute", args,
        // The ceiling is a promise to the trader; the transaction is bounded
        // by it, not only charged up to it.
        ...(await gasLimitFor(gasCeiling)),
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("execute_reverted");
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      charged = principal + (gas > gasCeiling ? gasCeiling : gas);
    } catch (error) {
      // The buy did not happen. The principal is already in the trader's own
      // fleet account; the pool is made whole by the operator so the draw is
      // charged nothing.
      await pool.rollback(campaign, principal);
      return { account: buy.account, status: "rejected", reason: reasonOf(error) };
    }

    // The buy is mined. From here a failure is an accounting failure, never
    // a reason to roll back: a rollback now would refund a principal that was
    // spent and leave the trader with both the tokens and the money.
    try {
      await pool.commit(campaign, charged);
    } catch (error) {
      try {
        await pool.commit(campaign, charged);
      } catch {
        console.error(`buy ${hash} mined but not committed: ${messageOf(error)}`);
        return { account: buy.account, status: "sponsored", txHash: hash, reason: "commit_pending" };
      }
    }
    return { account: buy.account, status: "sponsored", txHash: hash, charged };
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

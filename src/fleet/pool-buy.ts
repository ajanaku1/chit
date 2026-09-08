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

/** The random window that separates a settlement from the charge it causes. */
export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 900;

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
  closeDraw(campaign: Hex): Promise<DrawSummary | undefined>;
  /** Funds every draw whose wait is over and posts every charge now due. */
  sweep(accountsOf: AccountsResolver): Promise<{ funded: Hex[]; posted: string[] }>;
  buy(input: PooledBuyInput): Promise<PooledBuyReport>;
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

  const chainSeconds = async (): Promise<bigint> => (await publicClient.getBlock()).timestamp;

  return {
    async balance(depositor) {
      const [inputs, headroom, paused] = await Promise.all([
        pool.ledgerInputs(depositor),
        pool.headroom(depositor),
        pool.paused(),
      ]);
      const record = await pool.depositorOf(depositor);

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
      // Paid by the operator, not the pool: a pool payout would publish the
      // depositor beside the address they chose to be paid at.
      const payoutTx = await wallet.sendTransaction({
        account: wallet.account ?? null,
        chain: wallet.chain ?? null,
        to: destination,
        value,
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: payoutTx });
      if (receipt.status !== "success") throw new Error(`withdrawal payout reverted: ${payoutTx}`);

      const queuedSpendTx = await pool.queueSpend(sealDepositor(ledgerKey, depositor), value, await dueAt());
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

    async closeDraw(campaign) {
      const draw = await pool.drawOf(campaign);
      if (!draw || draw.state === DRAW_STATE.closed) return draw ? summarize(draw) : undefined;
      await pool.closeDraw(campaign);
      return summarize((await pool.drawOf(campaign))!);
    },

    /**
     * Idempotent by construction: it acts only on draws whose wait is over and
     * charges whose time has come, so running it twice funds nothing twice.
     */
     async sweep(accountsOf) {
      const seconds = await chainSeconds();
      const funded: Hex[] = [];
      for (const draw of await pool.draws()) {
        if (draw.state !== DRAW_STATE.pending || draw.dueAt > seconds) continue;
        const accounts = await accountsOf(draw.campaign);
        if (accounts.length === 0) continue;
        await pool.fund(draw.campaign, accounts);
        funded.push(draw.campaign);
      }

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
      return { funded, posted };
    },

    async buy({ campaign, depositor, target, buys }) {
      const results: (PooledBuyOutcome & { charged?: bigint })[] = [];
      for (const entry of buys) {
        const outcome = await settle(campaign, target, entry);
        results.push(outcome);
        if (outcome.status === "sponsored" && outcome.charged) {
          await pool.queueSpend(sealDepositor(ledgerKey, depositor), outcome.charged, await dueAt());
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

    try {
      const hash = await wallet.writeContract({
        ...ctx(wallet), address: buy.account, abi: ACCOUNT_ABI, functionName: "execute", args,
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("execute_reverted");

      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      const charged = principal + (gas > gasCeiling ? gasCeiling : gas);
      await pool.commit(campaign, charged);
      return { account: buy.account, status: "sponsored", txHash: hash, charged };
    } catch (error) {
      // The principal is already in the trader's own fleet account; the pool is
      // made whole by the operator so the draw is charged nothing.
      await pool.rollback(campaign, principal);
      return { account: buy.account, status: "rejected", reason: reasonOf(error) };
    }
  }
};

const ctx = (wallet: WalletClient) => ({ account: wallet.account ?? null, chain: wallet.chain ?? null });

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

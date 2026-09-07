/**
 * Stage 2 operator-side money operations against the pool.
 *
 * Reads compose a trader's balance from chain state; writes move money in the
 * shape the privacy claim requires. A withdrawal is paid from the operator's
 * own wallet and only then charged to the depositor, after a delay, so the pool
 * never publishes a transfer from a depositor to a payee.
 */

import type { Address, Hex, PublicClient, WalletClient } from "viem";

import type { FleetPool } from "./chain-pool.js";
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

export type WithdrawInput = { depositor: Address; amount: Uint; destination: Address };
export type WithdrawReceipt = { payoutTx: Hex; queuedSpendTx: Hex };

/** What the router may ask of the pool. */
export type PoolPort = {
  balance(depositor: Address): Promise<BalanceView>;
  withdraw(input: WithdrawInput): Promise<WithdrawReceipt>;
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

  const dueAt = (): bigint => BigInt(Math.floor(now().getTime() / 1000) + delay());

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

      const queuedSpendTx = await pool.queueSpend(sealDepositor(ledgerKey, depositor), value, dueAt());
      return { payoutTx, queuedSpendTx };
    },
  };
};

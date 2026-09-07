/**
 * Balance page logic.
 *
 * Every refusal here mirrors one the pool contract enforces. The page must not
 * offer a deposit or a withdrawal the chain would reject: a trader who learns a
 * limit from a reverted transaction has paid gas for the lesson.
 */

export type Headroom = { sizes: string[]; perTraderRemaining: string; poolRemaining: string };

export type BalanceState = {
  available: string;
  deposited: string;
  spent: string;
  openDraws: string;
  headroom: Headroom;
  exit: { requestedAt?: string; amount?: string; availableAt?: string };
  pool: { paused: boolean };
};

export type DepositOption = { size: string; label: string; disabled: boolean; reason?: string };

/** Published sizes, ascending, matching the contract's constants. */
export const SIZES = ["10000000000000000", "50000000000000000", "100000000000000000"] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;

/** Renders wei as ETH without trailing zeros: 10000000000000000 -> "0.01". */
export const toEth = (wei: string): string => {
  const padded = wei.padStart(19, "0");
  const whole = padded.slice(0, -18);
  const frac = padded.slice(-18).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

export const depositOptions = (state: BalanceState): DepositOption[] =>
  SIZES.map((size) => {
    const label = `${toEth(size)} ETH`;
    if (state.pool.paused) {
      return { size, label, disabled: true, reason: "Deposits are paused right now." };
    }
    if (BigInt(size) > BigInt(state.headroom.perTraderRemaining)) {
      return { size, label, disabled: true, reason: `Over your limit of ${toEth(state.headroom.perTraderRemaining)} ETH left.` };
    }
    if (BigInt(size) > BigInt(state.headroom.poolRemaining)) {
      return { size, label, disabled: true, reason: `The pool has only ${toEth(state.headroom.poolRemaining)} ETH of room left.` };
    }
    return { size, label, disabled: false };
  });

/**
 * The reason a withdrawal cannot proceed, or undefined. A destination equal to
 * the depositing wallet returns a reason that is advice, not a block; pass
 * `blocking` to ask only for reasons that must stop the form.
 */
export const withdrawIssue = (
  state: BalanceState,
  amount: string,
  destination: string,
  primaryWallet?: string,
  options: { blocking?: boolean } = {},
): string | undefined => {
  if (!DECIMAL.test(amount) || BigInt(amount) === 0n) return "Enter an amount to withdraw.";
  if (!ADDRESS.test(destination)) return "Enter the address that should receive the ETH.";
  if (BigInt(amount) > BigInt(state.available)) {
    return `That is more than your balance of ${toEth(state.available)} ETH.`;
  }
  if (state.pool.paused) return "Withdrawals are paused right now.";
  if (!options.blocking && primaryWallet && destination.toLowerCase() === primaryWallet.toLowerCase()) {
    return "Paying out to the same wallet you deposited from links them again. A fresh address keeps them apart.";
  }
  return undefined;
};

export type ExitStatus = "none" | "waiting" | "available";

export const exitView = (
  state: BalanceState,
  now: Date,
): { status: ExitStatus; availableAt?: string; amount?: string } => {
  const { requestedAt, availableAt, amount } = state.exit;
  if (!requestedAt || !availableAt) return { status: "none" };
  const ready = Date.parse(availableAt) <= now.getTime();
  return { status: ready ? "available" : "waiting", availableAt, ...(amount ? { amount } : {}) };
};

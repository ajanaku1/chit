/**
 * CHIT eligibility and service-fee accounting (FR-002, FR-003, SC-002, SC-005).
 *
 * CHIT is read-only eligibility and discount data. The quote discloses the
 * published threshold, base fee, configured discount, and exact net fee before
 * anything is created; an ineligible wallet is refused before any campaign,
 * account, or budget state exists. The charged fee is a separate typed record
 * and never touches the ETH sponsorship budget.
 */

import type { FeeCharge, FeeQuote, Uint } from "./types.js";
import { isAddress, isUint } from "./types.js";

export type FeeConfig = {
  /** Published CHIT threshold, in CHIT base units. */
  threshold: Uint;
  baseFee: Uint;
  discount: Uint;
  feeAsset: string;
  recipient: string;
};

export class EligibilityError extends Error {
  readonly code: "fee_config_invalid" | "ineligible";
  readonly reason: string;

  constructor(code: EligibilityError["code"], reason: string) {
    super(`${code}: ${reason}`);
    this.name = "EligibilityError";
    this.code = code;
    this.reason = reason;
  }
}

const uint = (value: unknown, reason: string): Uint => {
  if (!isUint(value)) throw new EligibilityError("fee_config_invalid", reason);
  return value;
};

/** Validates configured fee facts. A discount above the base fee is refused outright. */
export const validateFeeConfig = (config: FeeConfig): FeeConfig => {
  const threshold = uint(config.threshold, "invalid_threshold");
  const baseFee = uint(config.baseFee, "invalid_base_fee");
  const discount = uint(config.discount, "invalid_discount");
  if (BigInt(discount) > BigInt(baseFee)) throw new EligibilityError("fee_config_invalid", "negative_net_fee");
  if (!isAddress(config.recipient)) throw new EligibilityError("fee_config_invalid", "invalid_recipient");
  if (config.feeAsset.length === 0) throw new EligibilityError("fee_config_invalid", "invalid_fee_asset");
  return { threshold, baseFee, discount, feeAsset: config.feeAsset, recipient: config.recipient };
};

/** Builds the disclosed quote from configuration and a read-only CHIT balance. */
export const createQuote = (config: FeeConfig, chitBalance: Uint, quoteId: string): FeeQuote => {
  const checked = validateFeeConfig(config);
  const balance = uint(chitBalance, "invalid_balance");
  return {
    quoteId,
    threshold: checked.threshold,
    baseFee: checked.baseFee,
    discount: checked.discount,
    netFee: (BigInt(checked.baseFee) - BigInt(checked.discount)).toString(),
    eligible: BigInt(balance) >= BigInt(checked.threshold),
  };
};

/**
 * Open access (Stage 1 testnet, decided 2026-09-02): no CHIT gate, no fee.
 * Requiring CHIT on the primary wallet would fingerprint it as a Chit user,
 * which defeats a privacy tool. The quote shape is unchanged so the wizard's
 * contract holds; the facts are simply zero and always eligible.
 */
export const openQuote = (quoteId: string): FeeQuote => ({
  quoteId, threshold: "0", baseFee: "0", discount: "0", netFee: "0", eligible: true,
});

export const OPEN_ACCESS_CHARGE = { feeAsset: "ETH", recipient: "0x0000000000000000000000000000000000000000", chargeEvidence: "open-access" } as const;

/** Records the fee charge for an eligible quote. Never debits campaign ETH. */
export const chargeQuote = (quote: FeeQuote, config: FeeConfig, chargeEvidence: string): FeeCharge => {
  if (!quote.eligible) throw new EligibilityError("ineligible", "quote_ineligible");
  const checked = validateFeeConfig(config);
  return { ...quote, feeAsset: checked.feeAsset, recipient: checked.recipient, chargeEvidence };
};

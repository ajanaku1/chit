import assert from "node:assert/strict";
import test from "node:test";

import {
  EligibilityError,
  chargeQuote,
  createQuote,
  validateFeeConfig,
  type FeeConfig,
} from "../../src/fleet/eligibility.js";

const config = (): FeeConfig => ({
  threshold: "5000000000000000000000000",
  baseFee: "10000000000000000",
  discount: "2500000000000000",
  feeAsset: "ETH",
  recipient: "0x00000000000000000000000000000000000000f1",
});

const rejects = (run: () => unknown, code: EligibilityError["code"] = "fee_config_invalid"): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof EligibilityError);
    assert.equal(error.code, code);
    return error.reason;
  }
  return assert.fail(`expected ${code}`);
};

test("fee configuration is validated and a negative net fee is refused", () => {
  assert.deepEqual(validateFeeConfig(config()), config());
  assert.equal(rejects(() => validateFeeConfig({ ...config(), discount: "10000000000000001" })), "negative_net_fee");
  assert.equal(rejects(() => validateFeeConfig({ ...config(), baseFee: "not-a-number" })), "invalid_base_fee");
  assert.equal(rejects(() => validateFeeConfig({ ...config(), threshold: "-1" })), "invalid_threshold");
  assert.equal(rejects(() => validateFeeConfig({ ...config(), recipient: "treasury" })), "invalid_recipient");
});

test("a quote discloses threshold, base fee, discount, and exact net fee", () => {
  const quote = createQuote(config(), "5000000000000000000000000", "quote-1");
  assert.deepEqual(quote, {
    quoteId: "quote-1",
    threshold: "5000000000000000000000000",
    baseFee: "10000000000000000",
    discount: "2500000000000000",
    netFee: "7500000000000000",
    eligible: true,
  });
});

test("eligibility is the read-only CHIT balance against the published threshold", () => {
  assert.equal(createQuote(config(), "5000000000000000000000000", "q").eligible, true);
  assert.equal(createQuote(config(), "4999999999999999999999999", "q").eligible, false);
  assert.equal(createQuote(config(), "0", "q").eligible, false);
  assert.equal(rejects(() => createQuote(config(), "abc", "q")), "invalid_balance");
});

test("an ineligible quote cannot be charged, and charging never invents fee facts", () => {
  const ineligible = createQuote(config(), "0", "q-ineligible");
  assert.equal(rejects(() => chargeQuote(ineligible, config(), "evidence-1"), "ineligible"), "quote_ineligible");

  const charge = chargeQuote(createQuote(config(), "5000000000000000000000000", "q-eligible"), config(), "evidence-1");
  assert.equal(charge.netFee, "7500000000000000");
  assert.equal(charge.feeAsset, "ETH");
  assert.equal(charge.recipient, config().recipient);
  assert.equal(charge.chargeEvidence, "evidence-1");
  assert.equal(rejects(() => chargeQuote(createQuote(config(), "1", "q2"), config(), ""), "ineligible"), "quote_ineligible");
});

test("the charged fee never touches the ETH sponsorship budget shape", () => {
  const charge = chargeQuote(createQuote(config(), "5000000000000000000000000", "q"), config(), "evidence-2");
  assert.deepEqual(
    Object.keys(charge).sort(),
    ["baseFee", "chargeEvidence", "discount", "eligible", "feeAsset", "netFee", "quoteId", "recipient", "threshold"],
    "a FeeCharge carries fee facts only — no funded/reserved/spent/unused budget fields",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFor } from "../src/fleet/order-quote.js";

/**
 * The fill a depositor accepts is the estimate for the total they order. Found
 * in the first loop on the live beta: the page quoted when the token was
 * chosen and never again when the amount changed, so an order could carry the
 * estimate for another total, and every slice was refused as price_moved
 * against a figure that was never its own.
 */

const quote = { estimatedOut: "11308626162914986175344" };

test("the estimate is sent only for the total it was quoted for", () => {
  assert.equal(acceptedFor(quote, "1000000000000000", "1000000000000000"), quote.estimatedOut);
});

test("a total changed after the quote has no accepted fill until it is quoted again", () => {
  assert.equal(acceptedFor(quote, "2000000000000000", "1000000000000000"), undefined);
  assert.equal(acceptedFor(quote, undefined, "1000000000000000"), undefined, "a quote with no recorded total is not trusted");
  assert.equal(acceptedFor(undefined, "1000000000000000", "1000000000000000"), undefined);
});

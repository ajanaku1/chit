import assert from "node:assert/strict";
import test from "node:test";

import { orderErrorText } from "../src/fleet/order-errors.js";

/**
 * What the trade page says when an order is refused. The service sends a code
 * and, beside it, a reason; the reason is what a trader can act on. Found in
 * the first loop on the live beta: an order placed while the fleet was still
 * being funded read "Something went wrong: policy_rejected", twelve times.
 */

test("an order placed while the fleet is still being funded says to wait, not that something broke", () => {
  const text = orderErrorText("policy_rejected", "state_not_sponsorable:Activating");
  assert.match(text, /still being funded/);
  assert.doesNotMatch(text, /went wrong|policy_rejected/);
});

test("a fleet in any other state that cannot trade is not active, read from the reason the service sends", () => {
  assert.equal(orderErrorText("policy_rejected", "state_not_sponsorable:Closed"), "This fleet is not active.");
  assert.equal(orderErrorText("state_not_sponsorable:Paused"), "This fleet is not active.", "the older shape, the state in the code, still reads the same");
});

test("the codes the page already knew keep their words, and an unknown one still names itself", () => {
  assert.equal(orderErrorText("over_draw"), "More than this fleet has left.");
  assert.equal(orderErrorText("exit_pending"), "You have an exit in progress; nothing new can leave the pool.");
  assert.equal(orderErrorText("something_new"), "Something went wrong: something_new");
});

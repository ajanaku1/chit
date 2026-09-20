/**
 * The sell flag's SDK: the calldata the owner's wallet and the bot's key send
 * to a SessionAccount to let a key sell, checked by decoding it back against
 * the contract's ABI. The contract's own promise (who may flip the flag, who
 * may approve, which spenders) is proven in test/fleet/SessionAccount.t.sol
 * and on the live router in test/fork/session-keys.test.ts; this is the
 * wire between them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, getAbiItem, toFunctionSelector } from "viem";

import { PERMIT2, SESSION_ACCOUNT_ABI, encodeApproveForSell, encodeSetSellAllowed, selectorOf } from "../../src/fleet/session-keys.js";
import { PERMIT2 as SWAP_PERMIT2 } from "../../src/fleet/v4-swap.js";

const KEY = "0x00000000000000000000000000000000000000b7" as const;
const TOKEN = "0x0000000000000000000000000000000000000c01" as const;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as const;
/** Decoding checksums addresses; the encoders took them lowercase. */
const lower = (args: readonly unknown[] | undefined): unknown[] => (args ?? []).map((a) => (typeof a === "string" ? a.toLowerCase() : a));

describe("session sell flag SDK", () => {
  it("encodes setSellAllowed(key, allowed) for the owner's wallet", () => {
    const on = decodeFunctionData({ abi: SESSION_ACCOUNT_ABI, data: encodeSetSellAllowed(KEY, true) });
    assert.equal(on.functionName, "setSellAllowed");
    assert.deepEqual(lower(on.args), [KEY, true]);
    const off = decodeFunctionData({ abi: SESSION_ACCOUNT_ABI, data: encodeSetSellAllowed(KEY, false) });
    assert.deepEqual(lower(off.args), [KEY, false]);
    assert.equal(selectorOf(encodeSetSellAllowed(KEY, true)), toFunctionSelector("setSellAllowed(address,bool)"));
  });

  it("encodes approveForSell(token, spender) for the bot's key", () => {
    const decoded = decodeFunctionData({ abi: SESSION_ACCOUNT_ABI, data: encodeApproveForSell(TOKEN, ROUTER) });
    assert.equal(decoded.functionName, "approveForSell");
    assert.deepEqual(lower(decoded.args), [TOKEN, ROUTER]);
    assert.equal(selectorOf(encodeApproveForSell(TOKEN, ROUTER)), toFunctionSelector("approveForSell(address,address)"));
  });

  it("carries the read and the two events so a page can show the flag and a log can follow it", () => {
    const read = getAbiItem({ abi: SESSION_ACCOUNT_ABI, name: "sellAllowed" });
    assert.equal(read.type, "function");
    assert.equal((read as { stateMutability: string }).stateMutability, "view");
    const allowed = getAbiItem({ abi: SESSION_ACCOUNT_ABI, name: "SellAllowed" });
    const approved = getAbiItem({ abi: SESSION_ACCOUNT_ABI, name: "SellApproved" });
    assert.equal(allowed.type, "event");
    assert.equal(approved.type, "event");
    assert.deepEqual((approved as { inputs: ReadonlyArray<{ name: string; indexed?: boolean }> }).inputs.map((i) => [i.name, i.indexed]), [["key", true], ["token", true], ["spender", true]]);
  });

  it("names the same Permit2 the swap encoders approve through", () => {
    assert.equal(PERMIT2, SWAP_PERMIT2);
    assert.equal(PERMIT2, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });
});

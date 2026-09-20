/**
 * The sell flag's SDK: the calldata the owner's wallet and the bot's key send
 * to a SessionAccount to let a key sell and to sell, checked by decoding it
 * back against the contract's ABI. The contract's own promise (who may flip
 * the flag, who may sell, where the ETH lands, that nothing outlives a sale)
 * is proven in test/fleet/SessionAccount.t.sol and on the live router in
 * test/fork/session-keys.test.ts; this is the wire between them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, getAbiItem, toFunctionSelector } from "viem";

import { PERMIT2, SESSION_ACCOUNT_ABI, encodeSell, encodeSetSellAllowed, selectorOf } from "../../src/fleet/session-keys.js";
import { PERMIT2 as SWAP_PERMIT2, venuePoolKey } from "../../src/fleet/v4-swap.js";

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

  it("encodes sell(router, poolKey, amountIn, minOut, deadline) for the bot's key, on the venue pool by default", () => {
    const data = encodeSell({ router: ROUTER, token: TOKEN, amountIn: 400n * 10n ** 18n, minOut: 3n * 10n ** 17n, deadline: 1_700_003_600n });
    const decoded = decodeFunctionData({ abi: SESSION_ACCOUNT_ABI, data });
    assert.equal(decoded.functionName, "sell");
    const [router, poolKey, amountIn, minOut, deadline] = decoded.args as unknown as readonly [string, { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }, bigint, bigint, bigint];
    assert.equal(router.toLowerCase(), ROUTER);
    assert.deepEqual(
      { ...poolKey, currency0: poolKey.currency0.toLowerCase(), currency1: poolKey.currency1.toLowerCase(), hooks: poolKey.hooks.toLowerCase() },
      venuePoolKey(TOKEN),
      "ETH against the token on the venue's tier, no hooks",
    );
    assert.equal(amountIn, 400n * 10n ** 18n);
    assert.equal(minOut, 3n * 10n ** 17n);
    assert.equal(deadline, 1_700_003_600n);
    assert.equal(selectorOf(data), toFunctionSelector("sell(address,(address,address,uint24,int24,address),uint128,uint128,uint256)"));
  });

  it("names another pool when the sale is on a launchpad's hooked pool", () => {
    const hooked = { currency0: "0x0000000000000000000000000000000000000000" as const, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: "0x00000000000000000000000000000000000000c4" as const };
    const decoded = decodeFunctionData({ abi: SESSION_ACCOUNT_ABI, data: encodeSell({ router: ROUTER, token: TOKEN, amountIn: 1n, minOut: 1n, deadline: 1n, poolKey: hooked }) });
    const poolKey = (decoded.args as unknown as readonly [string, { fee: number; tickSpacing: number; hooks: string }])[1];
    assert.equal(poolKey.fee, 10_000);
    assert.equal(poolKey.tickSpacing, 200);
    assert.equal(poolKey.hooks.toLowerCase(), hooked.hooks);
  });

  it("carries the reads and the two events so a page can show the flag, a bot can ask before paying gas and a log can follow it", () => {
    const read = getAbiItem({ abi: SESSION_ACCOUNT_ABI, name: "sellAllowed" });
    assert.equal(read.type, "function");
    assert.equal((read as { stateMutability: string }).stateMutability, "view");
    const can = getAbiItem({ abi: SESSION_ACCOUNT_ABI, name: "canSell" });
    assert.equal((can as { stateMutability: string }).stateMutability, "view");
    assert.deepEqual((can as { outputs: ReadonlyArray<{ type: string }> }).outputs.map((o) => o.type), ["bool", "string"]);
    const allowed = getAbiItem({ abi: SESSION_ACCOUNT_ABI, name: "SellAllowed" });
    const sold = getAbiItem({ abi: SESSION_ACCOUNT_ABI, name: "Sold" });
    assert.equal(allowed.type, "event");
    assert.equal(sold.type, "event");
    assert.deepEqual((sold as { inputs: ReadonlyArray<{ name: string; indexed?: boolean }> }).inputs.map((i) => [i.name, i.indexed ?? false]), [["key", true], ["token", true], ["router", true], ["amountIn", false], ["ethOut", false]]);
  });

  it("names the same Permit2 the swap encoders approve through", () => {
    assert.equal(PERMIT2, SWAP_PERMIT2);
    assert.equal(PERMIT2, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });
});

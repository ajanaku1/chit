import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeAbiParameters, decodeFunctionData, parseAbi, type Address } from "viem";

import {
  NATIVE_ETH, UNIVERSAL_ROUTER_EXECUTE, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, VENUE_POOL,
  encodeBuyCall, encodeV4EthBuy,
} from "../../src/fleet/v4-swap.js";

const TOKEN = "0x00000000000000000000000000000000000f1ee7" as Address;
const EXECUTE = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

describe("Uniswap v4 buy calldata", () => {
  it("targets the Universal Router execute selector the policy approves", () => {
    assert.equal(UNIVERSAL_ROUTER_EXECUTE_SELECTOR, "0x3593564c");
    assert.equal(encodeBuyCall(UNIVERSAL_ROUTER_EXECUTE, TOKEN, 1n, new Date(0)).slice(0, 10), "0x3593564c");
  });

  it("encodes one V4_SWAP: exact-in single ETH -> token, settle ETH, take token", () => {
    const data = encodeV4EthBuy({ token: TOKEN, amountIn: 5n * 10n ** 14n, minOut: 7n, deadline: 1_900_000_000n });
    const { args } = decodeFunctionData({ abi: EXECUTE, data });
    const [commands, inputs, deadline] = args;
    assert.equal(commands, "0x10");
    assert.equal(deadline, 1_900_000_000n);
    assert.equal(inputs.length, 1);

    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
    assert.equal(actions, "0x060c0f");
    assert.equal(params.length, 3);
    const [settleCurrency, settleMax] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]!);
    const [takeCurrency, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
    assert.equal(settleCurrency, NATIVE_ETH);
    assert.equal(settleMax, 5n * 10n ** 14n);
    assert.equal(takeCurrency.toLowerCase(), TOKEN);
    assert.equal(takeMin, 7n);
    // The swap params carry the fixed venue pool key with ETH as currency0.
    assert.ok(params[0]!.includes(TOKEN.slice(2)));
    assert.ok(params[0]!.includes(VENUE_POOL.fee.toString(16).padStart(64, "0")));
  });

  it("keeps the labelled fixture shape for any other approved function", () => {
    const data = encodeBuyCall("buy(address,uint256)", TOKEN, 3n, new Date(0));
    assert.equal(data.length, 2 + 8 + 128);
    assert.ok(data.endsWith(`${TOKEN.slice(2).padStart(64, "0")}${"3".padStart(64, "0")}`));
  });

  it("derives the deadline one hour after now", () => {
    const data = encodeBuyCall(UNIVERSAL_ROUTER_EXECUTE, TOKEN, 1n, new Date(1_700_000_000_000));
    const { args } = decodeFunctionData({ abi: EXECUTE, data });
    assert.equal(args[2], 1_700_003_600n);
  });
});

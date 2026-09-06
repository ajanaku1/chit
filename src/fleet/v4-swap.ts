/**
 * Uniswap v4 buy calldata for the Stage 1 venue.
 *
 * The approved fleet function is the Universal Router's `execute`. One
 * sponsored buy is an exact-in ETH -> token swap through a single no-hook pool,
 * paid from the fleet account's own ETH (`value`) so the escrow only ever pays
 * gas. Action and command bytes follow v4-periphery `Actions` and the Universal
 * Router `Commands` library.
 */

import { encodeAbiParameters, encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";

export const UNIVERSAL_ROUTER_EXECUTE = "execute(bytes,bytes[],uint256)";
export const UNIVERSAL_ROUTER_EXECUTE_SELECTOR: Hex = toFunctionSelector(UNIVERSAL_ROUTER_EXECUTE);

/** The seeded venue pool's fixed parameters: 0.30% fee, tick spacing 60, no hooks. */
export const VENUE_POOL = { fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" as Address } as const;
export const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

const COMMAND_V4_SWAP = "0x10";
const ACTION_SWAP_EXACT_IN_SINGLE = "06";
const ACTION_SETTLE_ALL = "0c";
const ACTION_TAKE_ALL = "0f";

const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const EXACT_IN_SINGLE = {
  type: "tuple",
  components: [
    { ...POOL_KEY, name: "poolKey" },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

const EXECUTE_ABI = [{
  type: "function", name: "execute", stateMutability: "payable",
  inputs: [{ name: "commands", type: "bytes" }, { name: "inputs", type: "bytes[]" }, { name: "deadline", type: "uint256" }],
  outputs: [],
}] as const;

export type V4Buy = { token: Address; amountIn: bigint; minOut?: bigint; deadline: bigint };

/** ETH is always currency0 (address zero sorts first), so a buy is zeroForOne. */
export const venuePoolKey = (token: Address) => ({
  currency0: NATIVE_ETH, currency1: token, fee: VENUE_POOL.fee, tickSpacing: VENUE_POOL.tickSpacing, hooks: VENUE_POOL.hooks,
});

export const encodeV4EthBuy = ({ token, amountIn, minOut = 0n, deadline }: V4Buy): Hex => {
  const actions: Hex = `0x${ACTION_SWAP_EXACT_IN_SINGLE}${ACTION_SETTLE_ALL}${ACTION_TAKE_ALL}`;
  const params: Hex[] = [
    encodeAbiParameters([EXACT_IN_SINGLE], [{
      poolKey: venuePoolKey(token), zeroForOne: true, amountIn, amountOutMinimum: minOut, hookData: "0x",
    }]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [NATIVE_ETH, amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, minOut]),
  ];
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [COMMAND_V4_SWAP, [input], deadline] });
};

/** Legacy fixture shape: `selector(token, value)`, used by the labelled test-only venue. */
const encodeFixtureBuy = (signature: string, token: Address, value: bigint): Hex => {
  // A campaign restored from the chain knows only its selector, not the signature.
  const selector = signature.startsWith("0x") ? signature : toFunctionSelector(signature);
  return `${selector}${token.slice(2).padStart(64, "0")}${value.toString(16).padStart(64, "0")}` as Hex;
};

/** Calldata for one sponsored buy against the campaign's approved function. */
export const encodeBuyCall = (signature: string, token: Address, value: bigint, now: Date): Hex =>
  signature === UNIVERSAL_ROUTER_EXECUTE
    ? encodeV4EthBuy({ token, amountIn: value, deadline: BigInt(Math.floor(now.getTime() / 1000) + 3600) })
    : encodeFixtureBuy(signature, token, value);

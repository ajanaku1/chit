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

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
/** `poolKey` names the pool when it is not the venue's own (a launchpad's hooked pool, another fee tier); the venue's key is the default. */
export type V4Buy = { token: Address; amountIn: bigint; minOut?: bigint; deadline: bigint; poolKey?: PoolKey };

/** ETH is always currency0 (address zero sorts first), so a buy is zeroForOne. */
export const venuePoolKey = (token: Address): PoolKey => ({
  currency0: NATIVE_ETH, currency1: token, fee: VENUE_POOL.fee, tickSpacing: VENUE_POOL.tickSpacing, hooks: VENUE_POOL.hooks,
});

export const encodeV4EthBuy = ({ token, amountIn, minOut = 0n, deadline, poolKey }: V4Buy): Hex => {
  const actions: Hex = `0x${ACTION_SWAP_EXACT_IN_SINGLE}${ACTION_SETTLE_ALL}${ACTION_TAKE_ALL}`;
  const params: Hex[] = [
    encodeAbiParameters([EXACT_IN_SINGLE], [{
      poolKey: poolKey ?? venuePoolKey(token), zeroForOne: true, amountIn, amountOutMinimum: minOut, hookData: "0x",
    }]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [NATIVE_ETH, amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, minOut]),
  ];
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [COMMAND_V4_SWAP, [input], deadline] });
};

export type V4Sell = { token: Address; amountIn: bigint; minOut?: bigint; deadline: bigint; poolKey?: PoolKey };

/** Permit2 on Robinhood Chain, verified live (specs/001-fleet-mission/research.md). The router pulls ERC-20 input through it. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const ERC20_APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const PERMIT2_APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "spender", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }], outputs: [] }] as const;

/**
 * The sell side of the same pool: token in, ETH out, oneForZero. The router
 * settles the token through Permit2 from the caller, so the caller must have
 * approved Permit2 on the token and the router on Permit2 first; those two
 * calls are `sellApprovals`. TAKE_ALL sends the ETH to the caller.
 */
export const encodeV4TokenSell = ({ token, amountIn, minOut = 0n, deadline, poolKey }: V4Sell): Hex => {
  const actions: Hex = `0x${ACTION_SWAP_EXACT_IN_SINGLE}${ACTION_SETTLE_ALL}${ACTION_TAKE_ALL}`;
  const params: Hex[] = [
    encodeAbiParameters([EXACT_IN_SINGLE], [{
      poolKey: poolKey ?? venuePoolKey(token), zeroForOne: false, amountIn, amountOutMinimum: minOut, hookData: "0x",
    }]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [NATIVE_ETH, minOut]),
  ];
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [COMMAND_V4_SWAP, [input], deadline] });
};

/** The two approvals a seller makes once per token: the token to Permit2, then Permit2 to the router. */
export const sellApprovals = (token: Address, router: Address, amount: bigint, expiration: number): Array<{ to: Address; data: Hex }> => [
  { to: token, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [PERMIT2, amount] }) },
  { to: PERMIT2, data: encodeFunctionData({ abi: PERMIT2_APPROVE_ABI, functionName: "approve", args: [token, router, amount, expiration] }) },
];

/** A sale's ETH out at the spot price, before fee and slippage: the inverse of the buy estimate. */
export const estimateEthOut = (amountIn: bigint, sqrtPriceX96: bigint): bigint =>
  sqrtPriceX96 === 0n ? 0n : (amountIn * (2n ** 192n)) / (sqrtPriceX96 * sqrtPriceX96);

/** Legacy fixture shape: `selector(token, value)`, used by the labelled test-only venue. */
const encodeFixtureBuy = (signature: string, token: Address, value: bigint): Hex => {
  // A campaign restored from the chain knows only its selector, not the signature.
  const selector = signature.startsWith("0x") ? signature : toFunctionSelector(signature);
  return `${selector}${token.slice(2).padStart(64, "0")}${value.toString(16).padStart(64, "0")}` as Hex;
};

/**
 * Calldata for one sponsored buy against the campaign's approved function.
 * `minOut` is the least the swap may return; zero means a market order that
 * any watcher of the public mempool can sandwich, so the router never passes
 * zero for a real venue (see `minOutFor`).
 */
export const encodeBuyCall = (signature: string, token: Address, value: bigint, now: Date, minOut = 0n): Hex =>
  signature === UNIVERSAL_ROUTER_EXECUTE
    ? encodeV4EthBuy({ token, amountIn: value, minOut, deadline: BigInt(Math.floor(now.getTime() / 1000) + 3600) })
    : encodeFixtureBuy(signature, token, value);

/** Ten thousand basis points; the slippage the operator tolerates is expressed in them. */
export const BPS = 10_000n;

/** The least output a buy may accept: the spot estimate less the tolerated slippage. */
export const minOutFor = (estimatedOut: bigint, maxSlippageBps: number): bigint =>
  (estimatedOut * (BPS - BigInt(maxSlippageBps))) / BPS;

/**
 * Session keys: the SDK for owners, bots and pages.
 *
 * A SessionAccount is a smart account with a kill switch (contracts/fleet/
 * SessionAccount.sol). The owner funds it and grants a bot's key a session:
 * which contracts and functions it may call, how much ETH per call and in
 * total, until when. The bot calls `execute` from its own key and pays its
 * own gas; the owner pauses or revokes from the wallet, in one transaction.
 * Nobody else is in the loop: no operator, no service, no Chit key.
 *
 * This module is the ABI and the encoders, shared by the app page, the fork
 * test and any bot that wants to be a good citizen and ask `canExecute`
 * before spending gas on a refusal.
 *
 * Selling rides on one flag per key rather than a rule per token: the owner
 * sets `sellAllowed`, the key calls `approveForSell(token, spender)` once per
 * token (the account approves Permit2, Permit2 approves the spender, which
 * must already be a target of the key's rules), and the sale itself is an
 * ordinary `execute` with zero value.
 */

import { encodeFunctionData, keccak256, parseAbi, stringToHex, type Hex } from "viem";

import type { Address, Uint } from "./types.js";
import { PERMIT2 } from "./v4-swap.js";

/** The Permit2 the account approves through; the same constant the swap encoders use. */
export { PERMIT2 };

export const SESSION_ACCOUNT_ABI = parseAbi([
  "struct Rule { address target; bytes4 selector; }",
  "function owner() view returns (address)",
  "function grant(address key, Rule[] rules, uint128 maxValuePerCall, uint128 totalValueCap, uint48 expiry)",
  "function pause(address key)",
  "function resume(address key)",
  "function revoke(address key)",
  "function execute(address target, uint256 value, bytes data) returns (bytes)",
  "function withdraw(address to, uint256 amount)",
  "function withdrawToken(address token, address to, uint256 amount)",
  "function sessionOf(address key) view returns (bool exists, bool paused, bool revoked, uint48 expiry, uint128 maxValuePerCall, uint128 totalValueCap, uint128 spentValue, uint32 calls)",
  "function rulesOf(address key) view returns (Rule[])",
  "function canExecute(address key, address target, bytes4 selector, uint256 value) view returns (bool, string)",
  "function setSellAllowed(address key, bool allowed)",
  "function sellAllowed(address key) view returns (bool)",
  "function approveForSell(address token, address spender)",
  "event SessionGranted(address indexed key, uint128 maxValuePerCall, uint128 totalValueCap, uint48 expiry, uint256 rules)",
  "event SessionPaused(address indexed key)",
  "event SessionResumed(address indexed key)",
  "event SessionRevoked(address indexed key)",
  "event Executed(address indexed by, address indexed target, bytes4 indexed selector, uint256 value)",
  "event SellAllowed(address indexed key, bool allowed)",
  "event SellApproved(address indexed key, address indexed token, address indexed spender)",
]);

export const SESSION_FACTORY_ABI = parseAbi([
  "function createAccount(address owner, bytes32 salt) returns (address)",
  "function accountOf(address owner, bytes32 salt) view returns (address)",
  "event AccountCreated(address indexed owner, address indexed account, bytes32 salt)",
]);

/** One account per wallet by default; a second one is a different salt. */
export const DEFAULT_SALT: Hex = keccak256(stringToHex("chit-session-account-v1"));

/** A zero selector on a rule means any function of that target. */
export const ANY_FUNCTION: Hex = "0x00000000";

export type SessionRule = { target: Address; selector: Hex };

export type SessionView = {
  exists: boolean;
  paused: boolean;
  revoked: boolean;
  expiry: number;
  maxValuePerCall: Uint;
  totalValueCap: Uint;
  spentValue: Uint;
  calls: number;
};

/** What a session is right now, in one word a page can colour. */
export const sessionState = (s: SessionView, nowSeconds: number): "active" | "paused" | "revoked" | "expired" | "spent" | "none" => {
  if (!s.exists) return "none";
  if (s.revoked) return "revoked";
  if (nowSeconds >= s.expiry) return "expired";
  if (s.paused) return "paused";
  if (BigInt(s.spentValue) >= BigInt(s.totalValueCap) && BigInt(s.totalValueCap) > 0n) return "spent";
  return "active";
};

export const decodeSessionView = (raw: readonly [boolean, boolean, boolean, number, bigint, bigint, bigint, number]): SessionView => ({
  exists: raw[0],
  paused: raw[1],
  revoked: raw[2],
  expiry: Number(raw[3]),
  maxValuePerCall: raw[4].toString(),
  totalValueCap: raw[5].toString(),
  spentValue: raw[6].toString(),
  calls: Number(raw[7]),
});

// --- calldata the owner's wallet sends ---------------------------------------

export const encodeCreateAccount = (owner: Address, salt: Hex = DEFAULT_SALT): Hex =>
  encodeFunctionData({ abi: SESSION_FACTORY_ABI, functionName: "createAccount", args: [owner, salt] });

export const encodeGrant = (key: Address, rules: readonly SessionRule[], maxValuePerCall: bigint, totalValueCap: bigint, expiry: number): Hex =>
  encodeFunctionData({
    abi: SESSION_ACCOUNT_ABI,
    functionName: "grant",
    args: [key, rules.map((r) => ({ target: r.target, selector: r.selector })), maxValuePerCall, totalValueCap, expiry],
  });

export const encodePause = (key: Address): Hex => encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "pause", args: [key] });
export const encodeResume = (key: Address): Hex => encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "resume", args: [key] });
export const encodeRevoke = (key: Address): Hex => encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "revoke", args: [key] });
export const encodeWithdraw = (to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "withdraw", args: [to, amount] });
export const encodeWithdrawToken = (token: Address, to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "withdrawToken", args: [token, to, amount] });
/** Lets `key` set up sells, or takes it back; the sale itself stays inside the key's rules and caps. */
export const encodeSetSellAllowed = (key: Address, allowed: boolean): Hex =>
  encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "setSellAllowed", args: [key, allowed] });

// --- calldata the bot's key sends ------------------------------------------------

/** The one call a bot makes: the account executes `data` on `target` with `value` of the account's ETH. */
export const encodeSessionExecute = (target: Address, value: bigint, data: Hex): Hex =>
  encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "execute", args: [target, value, data] });

/** Once per token before its first sale: the account approves Permit2 for `token` and Permit2 approves `spender`, which must be a rule target. */
export const encodeApproveForSell = (token: Address, spender: Address): Hex =>
  encodeFunctionData({ abi: SESSION_ACCOUNT_ABI, functionName: "approveForSell", args: [token, spender] });

/** The selector a call carries, for `canExecute` and for writing rules. */
export const selectorOf = (data: Hex): Hex => (data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : ANY_FUNCTION);

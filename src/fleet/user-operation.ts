/**
 * ERC-4337 UserOperation adapter (FR-007 to FR-010, SC-003).
 *
 * Builds EntryPoint v0.7 packed UserOperations for policy-authorized fleet buys
 * and submits them through a pluggable submitter. The default production path
 * is self-bundling — the operator calls `EntryPoint.handleOps` directly, the
 * same route the Sepolia proof used — so no external bundler account is
 * required; a hosted bundler URL is a configuration change, not a rewrite.
 */

import { concatHex, encodeFunctionData, numberToHex, parseAbi, type Hex } from "viem";

import type { Address, Uint } from "./types.js";

/** EntryPoint v0.7.0, verified live on Robinhood Chain testnet (chain 46630). */
export const ENTRYPOINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032" as const;

export type PackedUserOperation = {
  sender: Address;
  nonce: Uint;
  initCode: Hex;
  callData: Hex;
  /** verificationGasLimit (16 bytes) ++ callGasLimit (16 bytes). */
  accountGasLimits: Hex;
  preVerificationGas: Uint;
  /** maxPriorityFeePerGas (16 bytes) ++ maxFeePerGas (16 bytes). */
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type SubmitResult = { userOpHash: Hex; actualGasCost: Uint };

export interface UserOperationSubmitter {
  submit(op: PackedUserOperation): Promise<SubmitResult>;
}

const FLEET_ACCOUNT_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data) returns (bytes)",
]);

const ENTRYPOINT_ABI = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address payable beneficiary)",
]);

/** The one call a fleet account may make: its policy-checked execute. */
export const encodeExecuteCall = (target: Address, value: Uint, data: Hex): Hex =>
  encodeFunctionData({
    abi: FLEET_ACCOUNT_ABI,
    functionName: "execute",
    args: [target, BigInt(value), data],
  });

/** Two 16-byte halves packed into one 32-byte word, v0.7 style. */
const packPair = (high: Uint, low: Uint): Hex =>
  concatHex([
    numberToHex(BigInt(high), { size: 16 }),
    numberToHex(BigInt(low), { size: 16 }),
  ]);

export type BuildUserOpInput = {
  sender: Address;
  nonce: Uint;
  callData: Hex;
  callGasLimit: Uint;
  verificationGasLimit: Uint;
  preVerificationGas: Uint;
  maxFeePerGas: Uint;
  maxPriorityFeePerGas: Uint;
  paymasterAndData: Hex;
};

export const buildPackedUserOp = (input: BuildUserOpInput): PackedUserOperation => ({
  sender: input.sender,
  nonce: input.nonce,
  initCode: "0x",
  callData: input.callData,
  accountGasLimits: packPair(input.verificationGasLimit, input.callGasLimit),
  preVerificationGas: input.preVerificationGas,
  gasFees: packPair(input.maxPriorityFeePerGas, input.maxFeePerGas),
  paymasterAndData: input.paymasterAndData,
  signature: "0x",
});

/** The calldata for a self-bundled `handleOps` submission. */
export const encodeHandleOps = (ops: readonly PackedUserOperation[], beneficiary: Address): Hex =>
  encodeFunctionData({
    abi: ENTRYPOINT_ABI,
    functionName: "handleOps",
    args: [
      ops.map((op) => ({
        sender: op.sender,
        nonce: BigInt(op.nonce),
        initCode: op.initCode,
        callData: op.callData,
        accountGasLimits: op.accountGasLimits as `0x${string}`,
        preVerificationGas: BigInt(op.preVerificationGas),
        gasFees: op.gasFees as `0x${string}`,
        paymasterAndData: op.paymasterAndData,
        signature: op.signature,
      })),
      beneficiary,
    ],
  });

type TransactionSender = {
  sendTransaction(tx: { to: Address; data: Hex }): Promise<{ transactionHash: Hex; gasCost: Uint }>;
};

/**
 * Self-bundling submitter: the operator lands the op through `handleOps` from
 * its own EOA. `sender` abstracts the wallet client so tests need no chain.
 */
export class SelfBundleSubmitter implements UserOperationSubmitter {
  readonly #sender: TransactionSender;
  readonly #beneficiary: Address;
  readonly #entryPoint: Address;

  constructor(sender: TransactionSender, beneficiary: Address, entryPoint: Address = ENTRYPOINT_V07) {
    this.#sender = sender;
    this.#beneficiary = beneficiary;
    this.#entryPoint = entryPoint;
  }

  async submit(op: PackedUserOperation): Promise<SubmitResult> {
    const receipt = await this.#sender.sendTransaction({
      to: this.#entryPoint,
      data: encodeHandleOps([op], this.#beneficiary),
    });
    return { userOpHash: receipt.transactionHash, actualGasCost: receipt.gasCost };
  }
}

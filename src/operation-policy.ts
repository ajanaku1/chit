import { type UserOperation } from "viem/account-abstraction";

export interface GasCeilings {
  readonly call: bigint;
  readonly verification: bigint;
  readonly preVerification: bigint;
  readonly paymasterVerification: bigint;
  readonly paymasterPostOp: bigint;
  readonly feePerGas: bigint;
  readonly priorityFeePerGas: bigint;
}

export interface OperationPolicy {
  readonly account: string;
  readonly expectedNonce: bigint;
  readonly accountDeployed: boolean;
  readonly accountFactory: string;
  readonly accountFactoryData: string;
  readonly expectedCallData: string;
  readonly paymaster: string;
  readonly maximumCost: bigint;
  readonly validUntil: number;
  readonly now: number;
  readonly currentEpochClaim: bigint;
  readonly gasCeilings: GasCeilings;
}

type ChitOperation = UserOperation<"0.7">;

function sameHex(actual: string | undefined, expected: string): boolean {
  return actual?.toLowerCase() === expected.toLowerCase();
}

function requireAtMost(actual: bigint, maximum: bigint, label: string): void {
  if (actual < 0n || actual > maximum) {
    throw new Error(`${label} exceeds the policy ceiling`);
  }
}

function validateIdentity(operation: ChitOperation, policy: OperationPolicy): void {
  if (!sameHex(operation.sender, policy.account)) {
    throw new Error("UserOperation sender is not the enrolled account");
  }
  if (operation.nonce !== policy.expectedNonce) {
    throw new Error("UserOperation nonce is not current");
  }
  if (!sameHex(operation.callData, policy.expectedCallData)) {
    throw new Error("UserOperation call data is outside the fixed action");
  }
  if (!sameHex(operation.paymaster, policy.paymaster)) {
    throw new Error("UserOperation paymaster does not match the round");
  }
}

function validateDeployment(
  operation: ChitOperation,
  policy: OperationPolicy,
): void {
  if (policy.accountDeployed) {
    if (operation.factory !== undefined || operation.factoryData !== undefined) {
      throw new Error("Deployed account must not include factory data");
    }
    return;
  }
  if (!sameHex(operation.factory, policy.accountFactory)) {
    throw new Error("UserOperation factory is not canonical");
  }
  if (!sameHex(operation.factoryData, policy.accountFactoryData)) {
    throw new Error("UserOperation factory data is not canonical");
  }
}

export function requiredPrefund(operation: ChitOperation): bigint {
  const gas =
    operation.callGasLimit +
    operation.verificationGasLimit +
    operation.preVerificationGas +
    (operation.paymasterVerificationGasLimit ?? 0n) +
    (operation.paymasterPostOpGasLimit ?? 0n);
  return gas * operation.maxFeePerGas;
}

function validateGas(operation: ChitOperation, policy: OperationPolicy): void {
  const limits = policy.gasCeilings;
  requireAtMost(operation.callGasLimit, limits.call, "Call gas");
  requireAtMost(operation.verificationGasLimit, limits.verification, "Verification gas");
  requireAtMost(operation.preVerificationGas, limits.preVerification, "Pre-verification gas");
  requireAtMost(
    operation.paymasterVerificationGasLimit ?? 0n,
    limits.paymasterVerification,
    "Paymaster verification gas",
  );
  requireAtMost(
    operation.paymasterPostOpGasLimit ?? 0n,
    limits.paymasterPostOp,
    "Paymaster post-op gas",
  );
  requireAtMost(operation.maxFeePerGas, limits.feePerGas, "Fee per gas");
  requireAtMost(
    operation.maxPriorityFeePerGas,
    limits.priorityFeePerGas,
    "Priority fee",
  );
  if (operation.maxPriorityFeePerGas > operation.maxFeePerGas) {
    throw new Error("Priority fee exceeds fee per gas");
  }
  if (requiredPrefund(operation) !== policy.maximumCost) {
    throw new Error("UserOperation maximum cost does not match the reservation");
  }
}

export function validatePreparedOperation(
  operation: ChitOperation,
  policy: OperationPolicy,
): void {
  if (operation.signature !== "0x") {
    throw new Error("Prepared UserOperation must not include an account signature");
  }
  if (operation.paymasterData !== undefined && operation.paymasterData !== "0x") {
    throw new Error("Prepared UserOperation must not include paymaster data");
  }
  if (policy.now > policy.validUntil) throw new Error("Authorization has expired");
  if (policy.currentEpochClaim !== 0n) {
    throw new Error("Account already has a claim in the current epoch");
  }
  validateIdentity(operation, policy);
  validateDeployment(operation, policy);
  validateGas(operation, policy);
}

export function operationFingerprint(operation: ChitOperation): string {
  return JSON.stringify([
    operation.sender.toLowerCase(),
    operation.nonce.toString(),
    operation.factory?.toLowerCase() ?? null,
    operation.factoryData?.toLowerCase() ?? null,
    operation.callData.toLowerCase(),
    operation.callGasLimit.toString(),
    operation.verificationGasLimit.toString(),
    operation.preVerificationGas.toString(),
    operation.maxFeePerGas.toString(),
    operation.maxPriorityFeePerGas.toString(),
    operation.paymaster?.toLowerCase() ?? null,
    operation.paymasterVerificationGasLimit?.toString() ?? null,
    operation.paymasterPostOpGasLimit?.toString() ?? null,
    operation.paymasterData?.toLowerCase() ?? null,
  ]);
}

export function assertSubmittedOperationFingerprint(
  preparedFingerprint: string,
  submitted: ChitOperation,
): void {
  if (submitted.signature === "0x") {
    throw new Error("Submitted UserOperation is missing its account signature");
  }
  if (operationFingerprint(submitted) !== preparedFingerprint) {
    throw new Error("Submitted UserOperation changed a reserved field");
  }
}

export function assertSubmittedOperationMatches(
  prepared: ChitOperation,
  submitted: ChitOperation,
): void {
  assertSubmittedOperationFingerprint(operationFingerprint(prepared), submitted);
}

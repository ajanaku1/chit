import {
  getAddress,
  isHex,
  size,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export interface ServiceOperatorRecord {
  readonly chainId: 11_155_111;
  readonly factory: Address;
  readonly round: Hex;
  readonly creator: Address;
  readonly paymaster: Address;
  readonly settlement: Address;
  readonly serviceOperator: Address;
}

export interface RoundServiceRoles {
  readonly verifier: Address;
  readonly paymasterOperator: Address;
  readonly settlementOperator: Address;
}

export interface RoleRotationStep {
  readonly contract: "paymaster" | "settlement";
  readonly functionName: "setVerifier" | "setOperator";
}

const SET_OPERATOR_SELECTOR = toFunctionSelector("setOperator(address)").slice(2);

export class UnsupportedRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRotationError";
  }
}

export function assertOperatorRotationSupported(
  paymasterCode: Hex,
  settlementCode: Hex,
): void {
  if (!paymasterCode.toLowerCase().includes(SET_OPERATOR_SELECTOR)) {
    throw new UnsupportedRotationError(
      "Deployed paymaster does not implement setOperator(address)",
    );
  }
  if (!settlementCode.toLowerCase().includes(SET_OPERATOR_SELECTOR)) {
    throw new UnsupportedRotationError(
      "Deployed settlement does not implement setOperator(address)",
    );
  }
}

function differs(left: Address, right: Address): boolean {
  return left.toLowerCase() !== right.toLowerCase();
}

export function parseSecretHex(value: string, name: string): Hex {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!isHex(normalized) || size(normalized) !== 32) {
    throw new Error(`${name} must be a 32-byte hex value`);
  }
  return normalized;
}

function recordAddress(
  record: Record<string, unknown>,
  field: string,
): Address {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
}

export function parseServiceOperatorRecord(
  value: unknown,
): ServiceOperatorRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Service operator record is malformed");
  }
  const record = value as Record<string, unknown>;
  if (record.chainId !== 11_155_111) {
    throw new Error("Service operator record must target Sepolia");
  }
  const round = record.round;
  if (typeof round !== "string" || !isHex(round) || size(round) !== 32) {
    throw new Error("round is invalid");
  }
  return {
    chainId: 11_155_111,
    factory: recordAddress(record, "factory"),
    round,
    creator: recordAddress(record, "creator"),
    paymaster: recordAddress(record, "paymaster"),
    settlement: recordAddress(record, "settlement"),
    serviceOperator: recordAddress(record, "serviceOperator"),
  };
}

export function planServiceRoleRotation(
  current: RoundServiceRoles,
  service: Address,
): readonly RoleRotationStep[] {
  if (service === zeroAddress) {
    throw new Error("Service authority cannot be the zero address");
  }
  const steps: RoleRotationStep[] = [];
  if (differs(current.verifier, service)) {
    steps.push({ contract: "paymaster", functionName: "setVerifier" });
  }
  if (differs(current.paymasterOperator, service)) {
    steps.push({ contract: "paymaster", functionName: "setOperator" });
  }
  if (differs(current.settlementOperator, service)) {
    steps.push({ contract: "settlement", functionName: "setOperator" });
  }
  return steps;
}

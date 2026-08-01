import {
  getAddress,
  isHash,
  isHex,
  type Address,
  type Hex,
} from "viem";

export const LOW_STAKE_PROFILE = {
  minimumStake: 100_000_000_000_000_000n,
  paymasterDeposit: 10_000_000_000_000_000n,
  operatorGas: 1_000_000_000_000_000n,
  unstakeDelay: 86_400,
  minimumWalletBalance: 130_000_000_000_000_000n,
} as const;

export interface RecoveryCheckpoint {
  readonly factory?: Address;
  readonly factoryDeployTx?: Hex;
  readonly pendingHash?: Hex;
  readonly pendingLabel?: string;
  readonly lastHash?: Hex;
}

export function clearFailedFactoryDeployment(
  checkpoint: RecoveryCheckpoint,
  failedHash: Hex,
): RecoveryCheckpoint {
  if (checkpoint.factoryDeployTx !== failedHash) return checkpoint;
  const {
    factory: _factory,
    factoryDeployTx: _factoryDeployTx,
    ...remaining
  } = checkpoint;
  return remaining;
}

export interface LowStakeRound {
  readonly creator: Address;
  readonly operator: Address;
  readonly verifier: Address;
  readonly auditor: Address;
  readonly vault: Address;
  readonly settlement: Address;
  readonly paymaster: Address;
  readonly initializedSteps: number;
}

export interface LowStakeProgress {
  readonly pending: boolean;
  readonly factory: boolean;
  readonly round?: boolean;
  readonly initializationMask?: number;
  readonly roundState?: number;
}

export type LowStakeAction =
  | { readonly kind: "reconcile-pending" }
  | { readonly kind: "deploy-factory" }
  | { readonly kind: "begin-round" }
  | { readonly kind: "initialize"; readonly step: number }
  | { readonly kind: "activate" }
  | { readonly kind: "complete" };

export function nextLowStakeAction(
  progress: LowStakeProgress,
): LowStakeAction {
  if (progress.pending) return { kind: "reconcile-pending" };
  if (!progress.factory) return { kind: "deploy-factory" };
  if (progress.round !== true) return { kind: "begin-round" };
  if (
    progress.initializationMask === undefined ||
    progress.roundState === undefined
  ) {
    throw new Error("Existing round progress is incomplete");
  }
  const [step] = missingInitializationSteps(progress.initializationMask);
  if (step !== undefined) return { kind: "initialize", step };
  if (progress.roundState === 0) return { kind: "activate" };
  if (progress.roundState === 1) return { kind: "complete" };
  throw new Error(`Round state ${progress.roundState} cannot be activated`);
}

export function assertLowStakeBalance(balance: bigint): void {
  if (balance < LOW_STAKE_PROFILE.minimumWalletBalance) {
    throw new Error("At least 0.13 Sepolia ETH is required for the new round");
  }
}

export function missingInitializationSteps(mask: number): readonly number[] {
  if (!Number.isInteger(mask) || mask < 0 || mask > 31) {
    throw new Error("Round initialization mask is invalid");
  }
  return [0, 1, 2, 3, 4].filter((step) => (mask & (1 << step)) === 0);
}

export function parseFactoryBytecode(value: unknown): Hex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Factory artifact bytecode is missing");
  }
  const bytecode = (value as Record<string, unknown>).bytecode;
  if (typeof bytecode !== "string" || !isHex(bytecode) || bytecode === "0x") {
    throw new Error("Factory artifact bytecode is invalid");
  }
  return bytecode;
}

function checkpointAddress(value: unknown, field: string): Address | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
}

function requiredAddress(record: Record<string, unknown>, field: string): Address {
  const address = checkpointAddress(record[field], field);
  if (address === undefined) throw new Error(`${field} is invalid`);
  return address;
}

export function parseLowStakeRound(value: unknown): LowStakeRound {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Factory round is malformed");
  }
  const record = value as Record<string, unknown>;
  const initializedSteps = record.initializedSteps;
  if (
    !Number.isInteger(initializedSteps) ||
    Number(initializedSteps) < 0 ||
    Number(initializedSteps) > 31
  ) {
    throw new Error("initializedSteps is invalid");
  }
  return {
    creator: requiredAddress(record, "creator"),
    operator: requiredAddress(record, "operator"),
    verifier: requiredAddress(record, "verifier"),
    auditor: requiredAddress(record, "auditor"),
    vault: requiredAddress(record, "vault"),
    settlement: requiredAddress(record, "settlement"),
    paymaster: requiredAddress(record, "paymaster"),
    initializedSteps: Number(initializedSteps),
  };
}

function checkpointHash(value: unknown, field: string): Hex | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function parseRecoveryCheckpoint(value: unknown): RecoveryCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery checkpoint is malformed");
  }
  const record = value as Record<string, unknown>;
  const factory = checkpointAddress(record.factory, "factory");
  const factoryDeployTx = checkpointHash(record.factoryDeployTx, "factoryDeployTx");
  const pendingHash = checkpointHash(record.pendingHash, "pendingHash");
  const lastHash = checkpointHash(record.lastHash, "lastHash");
  const pendingLabel = record.pendingLabel;
  if (
    pendingLabel !== undefined &&
    (typeof pendingLabel !== "string" || pendingLabel.length > 80)
  ) {
    throw new Error("pendingLabel is invalid");
  }
  if (factory !== undefined && factoryDeployTx === undefined) {
    throw new Error("factoryDeployTx is required with factory");
  }
  return {
    ...(factory === undefined ? {} : { factory }),
    ...(factoryDeployTx === undefined ? {} : { factoryDeployTx }),
    ...(pendingHash === undefined ? {} : { pendingHash }),
    ...(pendingLabel === undefined ? {} : { pendingLabel }),
    ...(lastHash === undefined ? {} : { lastHash }),
  };
}

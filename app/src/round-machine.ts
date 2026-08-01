import { getAddress, isHash, keccak256, stringToHex, type Hex } from "viem";

export interface RoundProgress {
  readonly pending: boolean;
  readonly exists: boolean;
  readonly initializationMask: number;
  readonly roundState?: number;
}

export type RoundAction =
  | { readonly kind: "reconcile" }
  | { readonly kind: "begin" }
  | { readonly kind: "initialize"; readonly step: number }
  | { readonly kind: "activate" }
  | { readonly kind: "complete" };

export interface RoundCheckpoint {
  readonly label: string;
  readonly pendingHash?: Hex;
  readonly pendingLabel?: string;
  readonly lastHash?: Hex;
}

function normalizedLabel(label: string): string {
  const normalized = label.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > 48) {
    throw new Error("Round name must contain 1 to 48 characters");
  }
  return normalized;
}

export function deriveRoundSalt(label: string, creator: string): Hex {
  const identity = `chit-round:${getAddress(creator).toLowerCase()}:${normalizedLabel(label).toLowerCase()}`;
  return keccak256(stringToHex(identity));
}

export function nextRoundAction(progress: RoundProgress): RoundAction {
  if (progress.pending) return { kind: "reconcile" };
  if (!progress.exists) return { kind: "begin" };
  for (let step = 0; step < 5; step += 1) {
    if ((progress.initializationMask & (1 << step)) === 0) {
      return { kind: "initialize", step };
    }
  }
  return progress.roundState === 1 ? { kind: "complete" } : { kind: "activate" };
}

export function canEditRoundLabel(progress: RoundProgress): boolean {
  return !progress.pending && !progress.exists;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Round checkpoint must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalHash(record: Record<string, unknown>, field: string): Hex | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(`Checkpoint ${field} must be a transaction hash`);
  }
  return value;
}

export function parseRoundCheckpoint(value: unknown): RoundCheckpoint {
  const record = objectRecord(value);
  if (typeof record.label !== "string") {
    throw new Error("Checkpoint label is missing");
  }
  const label = normalizedLabel(record.label);
  const pendingHash = optionalHash(record, "pendingHash");
  const lastHash = optionalHash(record, "lastHash");
  if (record.pendingLabel !== undefined && typeof record.pendingLabel !== "string") {
    throw new Error("Checkpoint pendingLabel must be a string");
  }
  return {
    label,
    ...(pendingHash === undefined ? {} : { pendingHash }),
    ...(record.pendingLabel === undefined ? {} : { pendingLabel: record.pendingLabel }),
    ...(lastHash === undefined ? {} : { lastHash }),
  };
}

import { getAddress, isHash, type Address, type Hex } from "viem";

import { SEPOLIA_CHAIN_ID } from "./browser-nox.js";

export const PREVIOUS_SPONSOR = getAddress(
  "0x536ad0665e4041e7e1843e0ce01b72ff90a9a4e5",
);
export const SPONSOR_BUDGET = 1_000n;
export const ADMISSION_LIFETIME_SECONDS = 86_400;
const MINIMUM_ADMISSION_LIFETIME_SECONDS = 5 * 60;

export interface ActiveSponsorTarget {
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
  readonly creator: Address;
  readonly sponsor: Address;
  readonly chitToken: Address;
  readonly chitBudgetToken: Address;
  readonly factory: Address;
  readonly roundId: Hex;
  readonly vault: Address;
}

export interface SponsorCheckpoint {
  readonly admissionExpiry?: number;
  readonly admissionDigest?: Hex;
  readonly admissionSignature?: Hex;
  readonly wrapTx?: Hex;
  readonly operatorTx?: Hex;
  readonly registrationTx?: Hex;
  readonly pendingHash?: Hex;
  readonly pendingLabel?: SponsorPendingLabel;
  readonly lastHash?: Hex;
}

export type SponsorPendingLabel = "approve" | "wrap" | "authorize" | "register";

export interface ActiveSponsorProgress {
  readonly pending: boolean;
  readonly admission: boolean;
  readonly sponsorWallet: boolean;
  readonly allowance: boolean;
  readonly wrapped: boolean;
  readonly operator: boolean;
  readonly registered: boolean;
}

export type ActiveSponsorAction =
  | { readonly kind: "reconcile-pending" }
  | { readonly kind: "sign-admission" }
  | { readonly kind: "switch-sponsor" }
  | { readonly kind: "approve-token" }
  | { readonly kind: "wrap-token" }
  | { readonly kind: "authorize-vault" }
  | { readonly kind: "register-sponsor" }
  | { readonly kind: "complete" };

function objectRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} is malformed`);
  }
  return value as Record<string, unknown>;
}

function requiredAddress(record: Record<string, unknown>, field: string): Address {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
}

function requiredHash(record: Record<string, unknown>, field: string): Hex {
  const value = record[field];
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function assertSepoliaRecord(record: Record<string, unknown>, context: string): void {
  if (record.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`${context} must target Ethereum Sepolia`);
  }
}

export function parseActiveSponsorTarget(
  roundValue: unknown,
  assetsValue: unknown,
): ActiveSponsorTarget {
  const round = objectRecord(roundValue, "Low-stake round");
  const assets = objectRecord(assetsValue, "Asset deployment");
  assertSepoliaRecord(round, "Low-stake round");
  assertSepoliaRecord(assets, "Asset deployment");
  const wrapper = requiredAddress(round, "wrapper");
  const deployedWrapper = requiredAddress(assets, "chitBudgetToken");
  if (wrapper !== deployedWrapper) {
    throw new Error("Low-stake round wrapper does not match the asset deployment");
  }
  return {
    chainId: SEPOLIA_CHAIN_ID,
    creator: requiredAddress(round, "creator"),
    sponsor: round.sponsor === undefined
      ? PREVIOUS_SPONSOR
      : requiredAddress(round, "sponsor"),
    chitToken: requiredAddress(assets, "chitToken"),
    chitBudgetToken: wrapper,
    factory: requiredAddress(round, "factory"),
    roundId: requiredHash(round, "roundId"),
    vault: requiredAddress(round, "vault"),
  };
}

function optionalHash(record: Record<string, unknown>, field: string): Hex | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function admissionSignature(value: unknown): Hex | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) {
    throw new Error("admissionSignature must be a 65-byte signature");
  }
  return value as Hex;
}

function admissionExpiry(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error("admissionExpiry must be a Unix timestamp");
  }
  return Number(value);
}

function assertCompleteAdmission(values: readonly unknown[]): void {
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== values.length) {
    throw new Error("Creator admission checkpoint must be complete");
  }
}

function pendingLabel(value: unknown): SponsorPendingLabel | undefined {
  if (value === undefined) return undefined;
  if (value === "approve" || value === "wrap" ||
      value === "authorize" || value === "register") return value;
  throw new Error("pendingLabel is invalid");
}

function assertCompletePending(
  hash: Hex | undefined,
  label: SponsorPendingLabel | undefined,
): void {
  if ((hash === undefined) !== (label === undefined)) {
    throw new Error("Pending transaction checkpoint must be complete");
  }
}

export function parseSponsorCheckpoint(value: unknown): SponsorCheckpoint {
  const record = objectRecord(value, "Sponsor checkpoint");
  const expiry = admissionExpiry(record.admissionExpiry);
  const digest = optionalHash(record, "admissionDigest");
  const signature = admissionSignature(record.admissionSignature);
  assertCompleteAdmission([expiry, digest, signature]);
  const transactions = checkpointTransactions(record);
  const label = pendingLabel(record.pendingLabel);
  assertCompletePending(transactions.pendingHash, label);
  return {
    ...(expiry === undefined ? {} : { admissionExpiry: expiry }),
    ...(digest === undefined ? {} : { admissionDigest: digest }),
    ...(signature === undefined ? {} : { admissionSignature: signature }),
    ...transactions,
    ...(label === undefined ? {} : { pendingLabel: label }),
  };
}

function checkpointTransactions(record: Record<string, unknown>): SponsorCheckpoint {
  const wrapTx = optionalHash(record, "wrapTx");
  const operatorTx = optionalHash(record, "operatorTx");
  const registrationTx = optionalHash(record, "registrationTx");
  const pendingHash = optionalHash(record, "pendingHash");
  const lastHash = optionalHash(record, "lastHash");
  return {
    ...(wrapTx === undefined ? {} : { wrapTx }),
    ...(operatorTx === undefined ? {} : { operatorTx }),
    ...(registrationTx === undefined ? {} : { registrationTx }),
    ...(pendingHash === undefined ? {} : { pendingHash }),
    ...(lastHash === undefined ? {} : { lastHash }),
  };
}

export function admissionIsUsable(
  checkpoint: SponsorCheckpoint,
  liveDigest: Hex,
  now: number,
): boolean {
  return checkpoint.admissionExpiry !== undefined &&
    checkpoint.admissionDigest?.toLowerCase() === liveDigest.toLowerCase() &&
    checkpoint.admissionSignature !== undefined &&
    checkpoint.admissionExpiry - now >= MINIMUM_ADMISSION_LIFETIME_SECONDS;
}

export function nextActiveSponsorAction(
  progress: ActiveSponsorProgress,
): ActiveSponsorAction {
  if (progress.pending) return { kind: "reconcile-pending" };
  if (!progress.admission) return { kind: "sign-admission" };
  if (!progress.sponsorWallet) return { kind: "switch-sponsor" };
  if (!progress.allowance) return { kind: "approve-token" };
  if (!progress.wrapped) return { kind: "wrap-token" };
  if (!progress.operator) return { kind: "authorize-vault" };
  if (!progress.registered) return { kind: "register-sponsor" };
  return { kind: "complete" };
}

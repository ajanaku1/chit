export const SEPOLIA_CHAIN_ID = 11_155_111;
const MINIMUM_ADMISSION_LIFETIME_SECONDS = 5 * 60;

export interface FactoryGateEvidence {
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
  readonly sponsor: `0x${string}`;
  readonly chitToken: `0x${string}`;
  readonly chitBudgetToken: `0x${string}`;
  readonly vault: `0x${string}`;
  readonly admissionExpiry: number;
  readonly admissionSignature: `0x${string}`;
}

export interface InjectedWalletProvider<Provider> {
  readonly info: {
    readonly name: string;
    readonly rdns: string;
  };
  readonly provider: Provider;
}

export function assertSepolia(chainId: number): void {
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error("Connect the wallet to Ethereum Sepolia");
  }
}

export function proofByteLength(proof: string): number {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(proof)) {
    throw new TypeError("Nox proof must be even-length hex");
  }
  return (proof.length - 2) / 2;
}

export function assertNoxProof(proof: string): void {
  const byteLength = proofByteLength(proof);
  if (byteLength !== 137) {
    throw new Error(`Nox proof must contain 137 bytes; received ${byteLength}`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Factory gate evidence must be an object");
  }
  return value as Record<string, unknown>;
}

function addressField(
  record: Record<string, unknown>,
  field: string,
): `0x${string}` {
  const value = record[field];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new TypeError(`Factory gate ${field} must be an Ethereum address`);
  }
  return value as `0x${string}`;
}

export function parseFactoryGateEvidence(value: unknown): FactoryGateEvidence {
  const record = objectRecord(value);
  if (record.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error("Factory gate evidence must target Ethereum Sepolia");
  }
  if (!Number.isInteger(record.admissionExpiry) || Number(record.admissionExpiry) <= 0) {
    throw new TypeError("Factory gate admissionExpiry must be a Unix timestamp");
  }
  if (
    typeof record.admissionSignature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(record.admissionSignature)
  ) {
    throw new TypeError("Factory gate admissionSignature must be a 65-byte signature");
  }
  return {
    chainId: SEPOLIA_CHAIN_ID,
    sponsor: addressField(record, "sponsor"),
    chitToken: addressField(record, "chitToken"),
    chitBudgetToken: addressField(record, "chitBudgetToken"),
    vault: addressField(record, "vault"),
    admissionExpiry: Number(record.admissionExpiry),
    admissionSignature: record.admissionSignature as `0x${string}`,
  };
}

export function assertGateSponsor(expected: string, connected: string): void {
  if (expected.toLowerCase() !== connected.toLowerCase()) {
    throw new Error(`Connect the admitted sponsor wallet ${expected}`);
  }
}

export function assertAdmissionFresh(expiry: number, now: number): void {
  if (expiry - now < MINIMUM_ADMISSION_LIFETIME_SECONDS) {
    throw new Error("Sponsor admission has expired or is not fresh enough to continue");
  }
}

export function selectRabbyProvider<Provider>(
  providers: readonly InjectedWalletProvider<Provider>[],
): Provider {
  const rabby = providers.find(({ info }) =>
    info.rdns.toLowerCase().includes("rabby") ||
    info.name.toLowerCase().includes("rabby")
  );
  if (rabby === undefined) {
    throw new Error("Rabby Wallet is not available on this page");
  }
  return rabby.provider;
}

export function selectLegacyRabbyProvider<Provider>(
  providers: readonly Provider[],
): Provider {
  const rabby = providers.find(
    (provider) =>
      (provider as { readonly isRabby?: unknown }).isRabby === true,
  );
  if (rabby === undefined) {
    throw new Error("Rabby Wallet is not available on this page");
  }
  return rabby;
}

export function connectedWalletAddress(
  value: unknown,
): `0x${string}` | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
    return undefined;
  }
  return first as `0x${string}`;
}

export type WalletAccountState =
  | { readonly kind: "none" }
  | { readonly kind: "match"; readonly account: `0x${string}` }
  | {
      readonly kind: "mismatch";
      readonly account: `0x${string}`;
      readonly expected: `0x${string}`;
    };

export function classifyWalletAccount(
  value: unknown,
  expected: `0x${string}`,
): WalletAccountState {
  const account = connectedWalletAddress(value);
  if (account === undefined) return { kind: "none" };
  if (account.toLowerCase() === expected.toLowerCase()) {
    return { kind: "match", account };
  }
  return { kind: "mismatch", account, expected };
}

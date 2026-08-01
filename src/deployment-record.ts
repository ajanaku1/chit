import {
  isAddress,
  isHex,
  size,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export const ENTRY_POINT_V07 =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const satisfies Address;
export const NOX_COMPUTE_SEPOLIA =
  "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF" as const satisfies Address;
export const SIMPLE_ACCOUNT_FACTORY_V07 =
  "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985" as const satisfies Address;

const contractKeys = [
  "chitToken",
  "chitBudgetToken",
  "chitPaymaster",
  "chitVault",
  "chitSettlement",
  "chitCounter",
] as const;
const transactionKeys = [
  "sponsorFundTx",
  "sponsorEnrollTx",
  "sponsoredUserOpTx",
  "settleEpochTx",
] as const;

export interface DeploymentRecord {
  readonly chainId: 11155111;
  readonly entryPoint: Address;
  readonly noxCompute: Address;
  readonly simpleAccountFactory: Address;
  readonly chitToken: Address;
  readonly chitBudgetToken: Address;
  readonly chitPaymaster: Address;
  readonly chitVault: Address;
  readonly chitSettlement: Address;
  readonly chitCounter: Address;
  readonly simpleAccount: Address;
  readonly deployTransactions: Readonly<Record<(typeof contractKeys)[number], Hex>>;
  readonly sponsorFundTx: Hex;
  readonly sponsorEnrollTx: Hex;
  readonly sponsoredUserOpTx: Hex;
  readonly settleEpochTx: Hex;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function addressValue(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value) || value === zeroAddress) {
    throw new TypeError(`${field} must be a nonzero address`);
  }
  return value;
}

function transactionValue(value: unknown, field: string): Hex {
  if (
    typeof value !== "string" ||
    !isHex(value) ||
    size(value) !== 32 ||
    /^0x0{64}$/i.test(value)
  ) {
    throw new TypeError(`${field} must be a 32-byte transaction hash`);
  }
  return value;
}

function canonicalAddress(
  record: Record<string, unknown>,
  field: string,
  expected: Address,
): Address {
  const actual = addressValue(record[field], field);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new TypeError(`${field} does not match the canonical ${field}`);
  }
  return actual;
}

function deploymentTransactions(value: unknown): DeploymentRecord["deployTransactions"] {
  const record = objectValue(value, "deployTransactions");
  return Object.fromEntries(
    contractKeys.map((key) => [
      key,
      transactionValue(record[key], `deployTransactions.${key}`),
    ]),
  ) as unknown as DeploymentRecord["deployTransactions"];
}

export function parseDeploymentRecord(value: unknown): DeploymentRecord {
  const record = objectValue(value, "deployment record");
  if (record.chainId !== 11155111) {
    throw new TypeError("deployment record must target Ethereum Sepolia");
  }
  canonicalAddress(record, "entryPoint", ENTRY_POINT_V07);
  canonicalAddress(record, "noxCompute", NOX_COMPUTE_SEPOLIA);
  canonicalAddress(record, "simpleAccountFactory", SIMPLE_ACCOUNT_FACTORY_V07);
  for (const key of contractKeys) addressValue(record[key], key);
  addressValue(record.simpleAccount, "simpleAccount");
  deploymentTransactions(record.deployTransactions);
  for (const key of transactionKeys) transactionValue(record[key], key);
  return value as DeploymentRecord;
}

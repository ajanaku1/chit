import {
  getAddress,
  isHex,
  parseAbi,
  size,
  type Address,
  type Hex,
} from "viem";
import { SEPOLIA_CHAIN_ID } from "./browser-nox.js";

const FACTORY_ABI = parseAbi([
  "function getRound(bytes32 id) view returns ((address creator,address operator,address verifier,address auditor,address vault,address settlement,address paymaster,uint8 initializedSteps))",
]);
const PAYMASTER_ABI = parseAbi([
  "function roundState() view returns (uint8)",
  "function currentEpoch() view returns (uint256)",
  "function entryPointBalance() view returns (uint256)",
  "function creator() view returns (address)",
  "function operator() view returns (address)",
  "function verifier() view returns (address)",
  "function settlement() view returns (address)",
]);
const SETTLEMENT_ABI = parseAbi([
  "function settledEpochs() view returns (uint256)",
  "function paymaster() view returns (address)",
  "function operator() view returns (address)",
]);
const VAULT_ABI = parseAbi([
  "function sponsorCount() view returns (uint256)",
  "function creator() view returns (address)",
  "function settlement() view returns (address)",
]);

export interface SepoliaReadClient {
  getChainId(): Promise<number>;
  getCode(input: { readonly address: Address }): Promise<Hex | undefined>;
  getBalance(input: { readonly address: Address }): Promise<bigint>;
  readContract(input: {
    readonly address: Address;
    readonly abi: readonly object[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface SepoliaServiceTarget {
  readonly factory: Address;
  readonly round: Hex;
}

interface SepoliaRoundReaderOptions {
  readonly client: SepoliaReadClient;
  readonly factory: Address;
  readonly expectedOperator: Address;
}

interface RoundRecord {
  readonly creator: Address;
  readonly operator: Address;
  readonly verifier: Address;
  readonly auditor: Address;
  readonly vault: Address;
  readonly settlement: Address;
  readonly paymaster: Address;
  readonly initializedSteps: number;
}

interface RoundFacts {
  readonly state: number;
  readonly currentEpoch: bigint;
  readonly entryPointBalance: bigint;
  readonly paymasterCreator: Address;
  readonly paymasterOperator: Address;
  readonly verifier: Address;
  readonly paymasterSettlement: Address;
  readonly settledEpochs: bigint;
  readonly settlementPaymaster: Address;
  readonly settlementOperator: Address;
  readonly sponsorCount: bigint;
  readonly vaultCreator: Address;
  readonly vaultSettlement: Address;
  readonly operatorBalance: bigint;
}

export interface SepoliaRoundSnapshot
  extends Omit<RoundRecord, "operator" | "verifier"> {
  readonly round: Hex;
  readonly operator: Address;
  readonly verifier: Address;
  readonly factoryOperator: Address;
  readonly factoryVerifier: Address;
  readonly state: "initializing" | "active" | "closing" | "closed";
  readonly sponsorCount: number;
  readonly currentEpoch: string;
  readonly settledEpochs: string;
  readonly entryPointBalance: string;
  readonly operatorBalance: string;
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Round read was aborted");
}

function recordObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Factory round record is malformed");
  }
  return value as Record<string, unknown>;
}

export function parseSepoliaServiceTarget(value: unknown): SepoliaServiceTarget {
  const record = recordObject(value);
  if (record.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error("Service target must use Ethereum Sepolia");
  }
  const factory = addressField(record, "factory");
  const round = record.roundId;
  if (typeof round !== "string" || !isHex(round) || size(round) !== 32) {
    throw new Error("Service target roundId is invalid");
  }
  return { factory, round };
}

function addressField(record: Record<string, unknown>, field: string): Address {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`Round ${field} is invalid`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`Round ${field} is invalid`);
  }
}

function integerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 31) {
    throw new Error(`Round ${field} is invalid`);
  }
  return value as number;
}

function parseRoundRecord(value: unknown): RoundRecord {
  const record = recordObject(value);
  return {
    creator: addressField(record, "creator"),
    operator: addressField(record, "operator"),
    verifier: addressField(record, "verifier"),
    auditor: addressField(record, "auditor"),
    vault: addressField(record, "vault"),
    settlement: addressField(record, "settlement"),
    paymaster: addressField(record, "paymaster"),
    initializedSteps: integerField(record, "initializedSteps"),
  };
}

function bigintValue(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${field} chain value is invalid`);
  }
  return value;
}

function stateValue(value: unknown): number {
  const state = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(state) || (state as number) < 0 || (state as number) > 3) {
    throw new Error("Round state chain value is invalid");
  }
  return state as number;
}

function stateName(state: number): SepoliaRoundSnapshot["state"] {
  return ["initializing", "active", "closing", "closed"][state] as SepoliaRoundSnapshot["state"];
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class SepoliaRoundReader {
  constructor(private readonly options: SepoliaRoundReaderOptions) {}

  async read(round: Hex, signal: AbortSignal): Promise<SepoliaRoundSnapshot> {
    requireActive(signal);
    await this.requireSepolia();
    await this.requireCode(this.options.factory, "factory");
    const record = await this.readRecord(round);
    await this.requireCoreCode(record);
    const facts = await this.readFacts(record);
    requireActive(signal);
    this.validateWiring(record, facts);
    return this.snapshot(round, record, facts);
  }

  private async requireSepolia(): Promise<void> {
    if ((await this.options.client.getChainId()) !== SEPOLIA_CHAIN_ID) {
      throw new Error("Service RPC must target Ethereum Sepolia");
    }
  }

  private async readRecord(round: Hex): Promise<RoundRecord> {
    return parseRoundRecord(await this.options.client.readContract({
      address: this.options.factory,
      abi: FACTORY_ABI,
      functionName: "getRound",
      args: [round],
    }));
  }

  private async requireCoreCode(record: RoundRecord): Promise<void> {
    await Promise.all([
      this.requireCode(record.vault, "vault"),
      this.requireCode(record.settlement, "settlement"),
      this.requireCode(record.paymaster, "paymaster"),
    ]);
  }

  private async requireCode(address: Address, label: string): Promise<void> {
    const code = await this.options.client.getCode({ address });
    if (code === undefined || code === "0x") {
      throw new Error(`Round ${label} bytecode is missing`);
    }
  }

  private readContract(
    address: Address,
    abi: readonly object[],
    functionName: string,
  ): Promise<unknown> {
    return this.options.client.readContract({ address, abi, functionName });
  }

  private async readFacts(record: RoundRecord): Promise<RoundFacts> {
    const values = await Promise.all([
      this.readContract(record.paymaster, PAYMASTER_ABI, "roundState"),
      this.readContract(record.paymaster, PAYMASTER_ABI, "currentEpoch"),
      this.readContract(record.paymaster, PAYMASTER_ABI, "entryPointBalance"),
      this.readContract(record.paymaster, PAYMASTER_ABI, "creator"),
      this.readContract(record.paymaster, PAYMASTER_ABI, "operator"),
      this.readContract(record.paymaster, PAYMASTER_ABI, "verifier"),
      this.readContract(record.paymaster, PAYMASTER_ABI, "settlement"),
      this.readContract(record.settlement, SETTLEMENT_ABI, "settledEpochs"),
      this.readContract(record.settlement, SETTLEMENT_ABI, "paymaster"),
      this.readContract(record.settlement, SETTLEMENT_ABI, "operator"),
      this.readContract(record.vault, VAULT_ABI, "sponsorCount"),
      this.readContract(record.vault, VAULT_ABI, "creator"),
      this.readContract(record.vault, VAULT_ABI, "settlement"),
      this.options.client.getBalance({ address: this.options.expectedOperator }),
    ]);
    return this.parseFacts(values);
  }

  private parseFacts(values: readonly unknown[]): RoundFacts {
    return {
      state: stateValue(values[0]),
      currentEpoch: bigintValue(values[1], "currentEpoch"),
      entryPointBalance: bigintValue(values[2], "entryPointBalance"),
      paymasterCreator: addressField({ value: values[3] }, "value"),
      paymasterOperator: addressField({ value: values[4] }, "value"),
      verifier: addressField({ value: values[5] }, "value"),
      paymasterSettlement: addressField({ value: values[6] }, "value"),
      settledEpochs: bigintValue(values[7], "settledEpochs"),
      settlementPaymaster: addressField({ value: values[8] }, "value"),
      settlementOperator: addressField({ value: values[9] }, "value"),
      sponsorCount: bigintValue(values[10], "sponsorCount"),
      vaultCreator: addressField({ value: values[11] }, "value"),
      vaultSettlement: addressField({ value: values[12] }, "value"),
      operatorBalance: bigintValue(values[13], "operatorBalance"),
    };
  }

  private validateWiring(record: RoundRecord, facts: RoundFacts): void {
    const serviceRolesMatch =
      sameAddress(facts.paymasterOperator, this.options.expectedOperator) &&
      sameAddress(facts.settlementOperator, this.options.expectedOperator) &&
      sameAddress(facts.verifier, this.options.expectedOperator);
    if (!serviceRolesMatch) {
      throw new Error("Round operator and verifier do not match the service key");
    }
    const wired =
      sameAddress(facts.paymasterCreator, record.creator) &&
      sameAddress(facts.vaultCreator, record.creator) &&
      sameAddress(facts.paymasterSettlement, record.settlement) &&
      sameAddress(facts.vaultSettlement, record.settlement) &&
      sameAddress(facts.settlementPaymaster, record.paymaster);
    if (!wired) throw new Error("Round core contract wiring does not match the factory");
    if (facts.sponsorCount > 4n) throw new Error("Round sponsor count exceeds capacity");
    if (facts.settledEpochs > facts.currentEpoch) {
      throw new Error("Round settled epoch exceeds its current epoch");
    }
  }

  private snapshot(
    round: Hex,
    record: RoundRecord,
    facts: RoundFacts,
  ): SepoliaRoundSnapshot {
    return {
      round,
      ...record,
      operator: facts.paymasterOperator,
      verifier: facts.verifier,
      factoryOperator: record.operator,
      factoryVerifier: record.verifier,
      state: stateName(facts.state),
      sponsorCount: Number(facts.sponsorCount),
      currentEpoch: facts.currentEpoch.toString(),
      settledEpochs: facts.settledEpochs.toString(),
      entryPointBalance: facts.entryPointBalance.toString(),
      operatorBalance: facts.operatorBalance.toString(),
    };
  }
}

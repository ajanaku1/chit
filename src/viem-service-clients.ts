import {
  encodeFunctionData,
  getAddress,
  isHex,
  parseAbi,
  size,
  type Address,
  type Hex,
} from "viem";
import {
  entryPoint07Abi,
  type UserOperation,
} from "viem/account-abstraction";
import {
  deriveSimpleAccountSalt,
  type AccountChainReader,
  type OperationChainFacts,
  type OperationChainReader,
  type OperationExecutor,
  type SubmissionOutcome,
  type SponsorChainFacts,
  type SponsorChainReader,
} from "./operator-service.js";
import {
  type LifecycleActionRecord,
  type LifecycleReconciliation,
} from "./lifecycle-types.js";
import { type GasCeilings } from "./operation-policy.js";
import { packChitUserOperation } from "./user-operation.js";

const SPONSOR_EVENT_ABI = parseAbi([
  "event SponsorRegistered(address indexed sponsor, uint256 indexed slot)",
]);
const TRANSFER_EVENT_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const ACCOUNT_ENROLLED_ABI = parseAbi([
  "event AccountEnrolled(address indexed account)",
]);
const ACCOUNT_FACTORY_ABI = parseAbi([
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address account)",
]);
const SETTLEMENT_ABI = parseAbi([
  "function enrolled(address account) view returns (bool)",
  "function settledEpochs() view returns (uint256)",
]);
const ENTRY_POINT_ABI = parseAbi([
  "function getNonce(address sender, uint192 key) view returns (uint256 nonce)",
]);
const PAYMASTER_ABI = parseAbi([
  "function currentEpoch() view returns (uint256)",
  "function claim(uint256 epoch, address account) view returns (uint256)",
]);
const ACCOUNT_ABI = parseAbi([
  "function owner() view returns (address)",
  "function execute(address dest, uint256 value, bytes func)",
]);
const COUNTER_ABI = parseAbi(["function increment()"]);

export interface ServicePublicClient {
  getCode(input: { readonly address: Address }): Promise<Hex | undefined>;
  getTransaction(input: { readonly hash: Hex }): Promise<{
    readonly from: Address;
    readonly to: Address | null;
    readonly value: bigint;
    readonly gas: bigint;
    readonly gasPrice: bigint;
  }>;
  getTransactionReceipt(input: { readonly hash: Hex }): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
  }>;
  getContractEvents(input: {
    readonly address: Address;
    readonly abi: readonly object[];
    readonly eventName: string;
    readonly args?: object;
    readonly fromBlock: bigint;
    readonly toBlock?: bigint;
  }): Promise<readonly object[]>;
  readContract(input: {
    readonly address: Address;
    readonly abi: readonly object[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface ServiceExecutionClient extends ServicePublicClient {
  simulateContract(input: {
    readonly account: Address;
    readonly address: Address;
    readonly abi: readonly object[];
    readonly functionName: string;
    readonly args: readonly unknown[];
  }): Promise<{ readonly request: Readonly<Record<string, unknown>> }>;
  waitForTransactionReceipt(input: { readonly hash: Hex }): Promise<{
    readonly status: "success" | "reverted";
  }>;
}

export interface ServiceWalletClient {
  writeContract(input: Readonly<Record<string, unknown>>): Promise<Hex>;
}

interface SponsorReaderOptions {
  readonly client: ServicePublicClient;
  readonly round: string;
  readonly vault: Address;
  readonly wrapper: Address;
  readonly underlyingToken: Address;
  readonly fundingFromBlock: bigint;
}

interface AccountReaderOptions {
  readonly client: ServicePublicClient;
  readonly factory: Address;
}

interface OperationReaderOptions {
  readonly client: ServicePublicClient;
  readonly round: Hex;
  readonly chainId: number;
  readonly settlement: Address;
  readonly paymaster: Address;
  readonly entryPoint: Address;
  readonly accountFactory: Address;
  readonly counter: Address;
  readonly gasCeilings: GasCeilings;
}

interface LifecycleReconcilerOptions {
  readonly client: ServicePublicClient;
  readonly round: string;
  readonly settlement: Address;
  readonly operator: Address;
  readonly creator: Address;
  readonly roundStartBlock: bigint;
}

interface OperationExecutorOptions {
  readonly client: ServiceExecutionClient;
  readonly wallet: ServiceWalletClient;
  readonly entryPoint: Address;
  readonly paymaster: Address;
  readonly beneficiary: Address;
}

function sameValue(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function eventArgs(event: object, label: string): Record<string, unknown> {
  const args = (event as { readonly args?: unknown }).args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error(`${label} event args are malformed`);
  }
  return args as Record<string, unknown>;
}

function uintValue(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} chain value is invalid`);
  }
  return value;
}

function boolValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} chain value is invalid`);
  }
  return value;
}

function addressValue(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function transactionHash(event: object): Hex | undefined {
  const value = (event as { readonly transactionHash?: unknown }).transactionHash;
  return typeof value === "string" && isHex(value) && size(value) === 32
    ? value
    : undefined;
}

function requireEventAddress(
  args: Record<string, unknown>,
  field: string,
  expected: Address,
): void {
  const actual = addressValue(args[field], `${field} event field`);
  if (!sameValue(actual, expected)) {
    throw new Error(`${field} event field does not match its filter`);
  }
}

function requireRound(actual: string, expected: string): void {
  if (!sameValue(actual, expected)) {
    throw new Error("Request round does not match the service context");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ViemSponsorChainReader implements SponsorChainReader {
  constructor(private readonly options: SponsorReaderOptions) {}

  async readSponsorRegistration(
    round: string,
    sponsor: Address,
    registrationTx: string,
  ): Promise<SponsorChainFacts> {
    requireRound(round, this.options.round);
    const receipt = await this.registrationReceipt(registrationTx);
    const slot = await this.registeredSlot(sponsor, registrationTx, receipt.blockNumber);
    const confirmedFunding = await this.confirmedFunding(sponsor);
    return { registered: slot !== undefined, slot: slot ?? -1, confirmedFunding };
  }

  private async registrationReceipt(transaction: string): Promise<{
    readonly blockNumber: bigint;
  }> {
    if (!isHex(transaction) || size(transaction) !== 32) {
      throw new Error("Sponsor registration transaction hash is invalid");
    }
    const receipt = await this.options.client.getTransactionReceipt({ hash: transaction });
    if (receipt.status !== "success") {
      throw new Error("Sponsor registration transaction reverted");
    }
    return { blockNumber: receipt.blockNumber };
  }

  private async registeredSlot(
    sponsor: Address,
    registrationTx: string,
    block: bigint,
  ): Promise<number | undefined> {
    const events = await this.options.client.getContractEvents({
      address: this.options.vault,
      abi: SPONSOR_EVENT_ABI,
      eventName: "SponsorRegistered",
      args: { sponsor },
      fromBlock: block,
      toBlock: block,
    });
    const event = events.find((candidate) => {
      const hash = transactionHash(candidate);
      return hash !== undefined && sameValue(hash, registrationTx);
    });
    if (event === undefined) return undefined;
    const args = eventArgs(event, "SponsorRegistered");
    requireEventAddress(args, "sponsor", sponsor);
    const slot = uintValue(args.slot, "sponsor slot");
    if (slot > 3n) throw new Error("Sponsor registration slot is invalid");
    return Number(slot);
  }

  private async confirmedFunding(sponsor: Address): Promise<bigint> {
    const events = await this.options.client.getContractEvents({
      address: this.options.underlyingToken,
      abi: TRANSFER_EVENT_ABI,
      eventName: "Transfer",
      args: { from: sponsor, to: this.options.wrapper },
      fromBlock: this.options.fundingFromBlock,
    });
    return events.reduce((total, event) => {
      const args = eventArgs(event, "Transfer");
      requireEventAddress(args, "from", sponsor);
      requireEventAddress(args, "to", this.options.wrapper);
      return total + uintValue(args.value, "wrap value");
    }, 0n);
  }
}

export class ViemAccountChainReader implements AccountChainReader {
  constructor(private readonly options: AccountReaderOptions) {}

  async predictSimpleAccount(owner: Address, salt: bigint): Promise<Address> {
    const result = await this.options.client.readContract({
      address: this.options.factory,
      abi: ACCOUNT_FACTORY_ABI,
      functionName: "getAddress",
      args: [owner, salt],
    });
    return addressValue(result, "SimpleAccount prediction");
  }
}

export class SelfBundlingOperationExecutor implements OperationExecutor {
  constructor(private readonly options: OperationExecutorOptions) {}

  async simulateAndSubmit(
    operation: UserOperation<"0.7">,
  ): Promise<SubmissionOutcome> {
    const simulation = await this.simulate(operation);
    if ("status" in simulation) return simulation;
    let transactionHash: Hex;
    try {
      transactionHash = await this.options.wallet.writeContract(simulation.request);
    } catch {
      return { status: "unknown" };
    }
    return this.confirm(transactionHash, operation.sender);
  }

  private async simulate(
    operation: UserOperation<"0.7">,
  ): Promise<
    | { readonly request: Readonly<Record<string, unknown>> }
    | { readonly status: "known-failure"; readonly reason: string }
  > {
    try {
      return await this.options.client.simulateContract({
        account: this.options.beneficiary,
        address: this.options.entryPoint,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[packChitUserOperation(operation)], this.options.beneficiary],
      });
    } catch (error) {
      return { status: "known-failure", reason: errorMessage(error) };
    }
  }

  private async confirm(
    transactionHash: Hex,
    account: Address,
  ): Promise<SubmissionOutcome> {
    try {
      const receipt = await this.options.client.waitForTransactionReceipt({
        hash: transactionHash,
      });
      if (receipt.status === "reverted") {
        return { status: "known-failure", reason: "handleOps transaction reverted" };
      }
      const actualClaim = await this.readCurrentClaim(account);
      return actualClaim > 0n
        ? { status: "confirmed", transactionHash, actualClaim }
        : { status: "unknown", transactionHash };
    } catch {
      return { status: "unknown", transactionHash };
    }
  }

  private async readCurrentClaim(account: Address): Promise<bigint> {
    const epoch = uintValue(
      await this.options.client.readContract({
        address: this.options.paymaster,
        abi: PAYMASTER_ABI,
        functionName: "currentEpoch",
      }),
      "current epoch",
    );
    return uintValue(
      await this.options.client.readContract({
        address: this.options.paymaster,
        abi: PAYMASTER_ABI,
        functionName: "claim",
        args: [epoch, account],
      }),
      "confirmed claim",
    );
  }
}

export class ViemOperationChainReader implements OperationChainReader {
  constructor(private readonly options: OperationReaderOptions) {}

  async readOperationFacts(
    round: string,
    account: Address,
    owner: Address,
  ): Promise<OperationChainFacts> {
    requireRound(round, this.options.round);
    const salt = deriveSimpleAccountSalt(this.options.chainId, this.options.round, owner);
    await this.requirePredictedAccount(account, owner, salt);
    const base = await this.readBaseFacts(account);
    const deployedOwner = base.deployed ? await this.readOwner(account) : undefined;
    const currentEpochClaim = await this.readClaim(base.epoch, account);
    return this.buildFacts(base, owner, salt, deployedOwner, currentEpochClaim);
  }

  private async requirePredictedAccount(
    account: Address,
    owner: Address,
    salt: bigint,
  ): Promise<void> {
    const predicted = await new ViemAccountChainReader({
      client: this.options.client,
      factory: this.options.accountFactory,
    }).predictSimpleAccount(owner, salt);
    if (!sameValue(predicted, account)) {
      throw new Error("Operation sender is not the canonical SimpleAccount");
    }
  }

  private async readBaseFacts(account: Address): Promise<{
    readonly enrolled: boolean;
    readonly deployed: boolean;
    readonly nonce: bigint;
    readonly epoch: bigint;
  }> {
    const [enrolled, code, nonce, epoch] = await Promise.all([
      this.read(this.options.settlement, SETTLEMENT_ABI, "enrolled", [account]),
      this.options.client.getCode({ address: account }),
      this.read(this.options.entryPoint, ENTRY_POINT_ABI, "getNonce", [account, 0n]),
      this.read(this.options.paymaster, PAYMASTER_ABI, "currentEpoch"),
    ]);
    return {
      enrolled: boolValue(enrolled, "enrolled"),
      deployed: code !== undefined && code !== "0x",
      nonce: uintValue(nonce, "account nonce"),
      epoch: uintValue(epoch, "current epoch"),
    };
  }

  private async readOwner(account: Address): Promise<Address> {
    return addressValue(
      await this.read(account, ACCOUNT_ABI, "owner"),
      "SimpleAccount owner",
    );
  }

  private async readClaim(epoch: bigint, account: Address): Promise<bigint> {
    return uintValue(
      await this.read(this.options.paymaster, PAYMASTER_ABI, "claim", [epoch, account]),
      "current epoch claim",
    );
  }

  private read(
    address: Address,
    abi: readonly object[],
    functionName: string,
    args?: readonly unknown[],
  ): Promise<unknown> {
    return this.options.client.readContract({
      address,
      abi,
      functionName,
      ...(args === undefined ? {} : { args }),
    });
  }

  private buildFacts(
    base: { readonly enrolled: boolean; readonly deployed: boolean; readonly nonce: bigint },
    owner: Address,
    salt: bigint,
    deployedOwner: Address | undefined,
    currentEpochClaim: bigint,
  ): OperationChainFacts {
    const increment = encodeFunctionData({ abi: COUNTER_ABI, functionName: "increment" });
    return {
      enrolled: base.enrolled,
      deployed: base.deployed,
      ...(deployedOwner === undefined ? {} : { owner: deployedOwner }),
      nonce: base.nonce,
      accountFactory: this.options.accountFactory,
      accountFactoryData: encodeFunctionData({
        abi: ACCOUNT_FACTORY_ABI,
        functionName: "createAccount",
        args: [owner, salt],
      }),
      expectedCallData: encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "execute",
        args: [this.options.counter, 0n, increment],
      }),
      paymaster: this.options.paymaster,
      currentEpochClaim,
      gasCeilings: this.options.gasCeilings,
    };
  }
}

export class ViemLifecycleReconciler {
  constructor(private readonly options: LifecycleReconcilerOptions) {}

  async reconcile(
    record: LifecycleActionRecord,
    signal: AbortSignal,
  ): Promise<LifecycleReconciliation> {
    if (signal.aborted) throw new Error("Lifecycle reconciliation was aborted");
    requireRound(record.round, this.options.round);
    if (record.kind === "enrollment") return this.reconcileEnrollment(record);
    if (record.kind === "settlement") return this.reconcileSettlement(record);
    return this.reconcileRecovery(record);
  }

  private async reconcileEnrollment(
    record: LifecycleActionRecord,
  ): Promise<LifecycleReconciliation> {
    const account = addressValue(record.actionKey.split(":").at(-1), "enrollment account");
    const events = await this.options.client.getContractEvents({
      address: this.options.settlement,
      abi: ACCOUNT_ENROLLED_ABI,
      eventName: "AccountEnrolled",
      args: { account },
      fromBlock: this.options.roundStartBlock,
    });
    const hash = events.map(transactionHash).find((value) => value !== undefined);
    if (hash !== undefined) {
      return { status: "confirmed", result: { kind: "enrollment", transactionHash: hash } };
    }
    return this.retryStatus(record.transactionHash);
  }

  private async reconcileSettlement(
    record: LifecycleActionRecord,
  ): Promise<LifecycleReconciliation> {
    if (record.transactionHash === undefined) return { status: "unresolved" };
    const receipt = await this.receipt(record.transactionHash);
    if (receipt === undefined) return { status: "unresolved" };
    if (receipt.status === "reverted") return { status: "retry-safe" };
    const epoch = this.settlementEpoch(record);
    const settled = uintValue(
      await this.options.client.readContract({
        address: this.options.settlement,
        abi: SETTLEMENT_ABI,
        functionName: "settledEpochs",
      }),
      "settled epochs",
    );
    if (settled <= epoch) return { status: "retry-safe" };
    return {
      status: "confirmed",
      result: {
        kind: "settlement",
        epoch: epoch.toString(),
        settlementTransactionHash: record.transactionHash,
      },
    };
  }

  private async reconcileRecovery(
    record: LifecycleActionRecord,
  ): Promise<LifecycleReconciliation> {
    if (record.transactionHash === undefined) return { status: "unresolved" };
    const receipt = await this.receipt(record.transactionHash);
    if (receipt === undefined) return { status: "unresolved" };
    if (receipt.status === "reverted") return { status: "retry-safe" };
    return this.recoveredTransaction(record.transactionHash);
  }

  private async recoveredTransaction(hash: Hex): Promise<LifecycleReconciliation> {
    const transaction = await this.options.client.getTransaction({ hash });
    if (
      !sameValue(transaction.from, this.options.operator) ||
      transaction.to === null ||
      !sameValue(transaction.to, this.options.creator) ||
      transaction.value < 0n ||
      transaction.gas <= 0n ||
      transaction.gasPrice <= 0n
    ) {
      throw new Error("Operator recovery transaction does not match its context");
    }
    return {
      status: "confirmed",
      result: {
        kind: "operator-gas-recovery",
        transactionHash: hash,
        recoveredValue: transaction.value.toString(),
        retainedGas: (transaction.gas * transaction.gasPrice).toString(),
      },
    };
  }

  private async retryStatus(hash: Hex | undefined): Promise<LifecycleReconciliation> {
    if (hash === undefined) return { status: "unresolved" };
    const receipt = await this.receipt(hash);
    return receipt?.status === "reverted"
      ? { status: "retry-safe" }
      : { status: "unresolved" };
  }

  private async receipt(hash: Hex): Promise<{
    readonly status: "success" | "reverted";
  } | undefined> {
    try {
      return await this.options.client.getTransactionReceipt({ hash });
    } catch {
      return undefined;
    }
  }

  private settlementEpoch(record: LifecycleActionRecord): bigint {
    const value = record.actionKey.split(":").at(-1);
    if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error("Settlement action has an invalid epoch identity");
    }
    return BigInt(value);
  }
}

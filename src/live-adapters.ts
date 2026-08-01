import { getAddress, type Address, type Hex } from "viem";
import { assertNoxProof } from "./browser-nox.js";

const ENROLL_ABI = [
  {
    type: "function",
    name: "enroll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "encryptedSlot", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const CLOSE_EPOCH_ABI = [
  {
    type: "function",
    name: "closeEpoch",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "closedEpoch", type: "uint256" }],
  },
] as const;

const SETTLE_EPOCH_ABI = [
  {
    type: "function",
    name: "settleEpoch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "users", type: "address[]" },
      { name: "claims", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

const PAYMASTER_READ_ABI = [
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "value", type: "uint256" }],
  },
  {
    type: "function",
    name: "epochTotal",
    stateMutability: "view",
    inputs: [{ name: "epoch", type: "uint256" }],
    outputs: [{ name: "value", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "view",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "value", type: "uint256" }],
  },
] as const;

const SETTLEMENT_READ_ABI = [
  {
    type: "function",
    name: "settledEpochs",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "value", type: "uint256" }],
  },
] as const;

const ROUND_STATE_ABI = [
  {
    type: "function",
    name: "roundState",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "state", type: "uint8" }],
  },
] as const;

const CHIT_RECORDED_EVENT = [
  {
    type: "event",
    name: "ChitRecorded",
    inputs: [
      { indexed: true, name: "epoch", type: "uint256" },
      { indexed: true, name: "account", type: "address" },
      { indexed: false, name: "gasCost", type: "uint256" },
    ],
  },
] as const;

export interface NoxEncryptedInput {
  readonly handle: Hex;
  readonly handleProof: Hex;
}

export interface NoxInputClient {
  encryptInput(
    value: bigint,
    type: "uint256",
    contract: Address,
  ): Promise<NoxEncryptedInput>;
}

export interface ContractWriter {
  writeContract(request: {
    readonly address: Address;
    readonly abi: readonly object[];
    readonly functionName: string;
    readonly args: readonly unknown[];
  }): Promise<Hex>;
}

export interface TransactionReceiptReader {
  waitForTransactionReceipt(request: { readonly hash: Hex }): Promise<{
    readonly status: "success" | "reverted";
  }>;
}

export interface RoundChainReader extends TransactionReceiptReader {
  readContract(request: {
    readonly address: Address;
    readonly abi: readonly object[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<unknown>;
  getContractEvents(request: {
    readonly address: Address;
    readonly abi: readonly object[];
    readonly eventName: string;
    readonly args: object;
    readonly fromBlock: bigint;
  }): Promise<readonly object[]>;
}

interface NoxEnrollmentOptions {
  readonly settlement: Address;
  readonly nox: NoxInputClient;
  readonly wallet: ContractWriter;
  readonly chain: TransactionReceiptReader;
}

interface EnrollmentRequest {
  readonly account: Address;
  readonly sponsorSlot: number;
  readonly signal: AbortSignal;
}

interface EpochSettlementOptions {
  readonly paymaster: Address;
  readonly settlement: Address;
  readonly roundStartBlock: bigint;
  readonly policy: { isSettlementReady(round: string): boolean };
  readonly wallet: ContractWriter;
  readonly chain: RoundChainReader;
}

interface SettlementRequest {
  readonly round: string;
  readonly signal: AbortSignal;
}

interface ChitEvent {
  readonly account: Address;
  readonly gasCost: bigint;
}

interface OperatorGasRecoveryOptions {
  readonly paymaster: Address;
  readonly operator: Address;
  readonly creator: Address;
  readonly wallet: {
    sendTransaction(request: {
      readonly account: Address;
      readonly to: Address;
      readonly value: bigint;
      readonly gas: bigint;
      readonly gasPrice: bigint;
    }): Promise<Hex>;
  };
  readonly chain: TransactionReceiptReader & {
    readContract(request: {
      readonly address: Address;
      readonly abi: readonly object[];
      readonly functionName: string;
    }): Promise<unknown>;
    getBalance(request: { readonly address: Address }): Promise<bigint>;
    getGasPrice(): Promise<bigint>;
    estimateGas(request: {
      readonly account: Address;
      readonly to: Address;
      readonly value: bigint;
    }): Promise<bigint>;
  };
}

interface RecoveryQuote {
  readonly recoveredValue: bigint;
  readonly retainedGas: bigint;
  readonly gas: bigint;
  readonly gasPrice: bigint;
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Operation was aborted");
}

export class UnknownTransactionOutcomeError extends Error {
  constructor(readonly transactionHash?: Hex, options?: ErrorOptions) {
    super("Transaction outcome is unknown", options);
    this.name = "UnknownTransactionOutcomeError";
  }
}

async function submitTransaction(write: () => Promise<Hex>): Promise<Hex> {
  try {
    return await write();
  } catch (error) {
    throw new UnknownTransactionOutcomeError(undefined, { cause: error });
  }
}

async function requireSuccessfulReceipt(
  chain: TransactionReceiptReader,
  transactionHash: Hex,
): Promise<void> {
  let receipt: { readonly status: "success" | "reverted" };
  try {
    receipt = await chain.waitForTransactionReceipt({ hash: transactionHash });
  } catch (error) {
    throw new UnknownTransactionOutcomeError(transactionHash, { cause: error });
  }
  if (receipt.status !== "success") {
    throw new Error("Transaction reverted");
  }
}

export class NoxEnrollmentAdapter {
  constructor(private readonly options: NoxEnrollmentOptions) {}

  async enroll(request: EnrollmentRequest): Promise<{ transactionHash: Hex }> {
    requireActive(request.signal);
    if (!Number.isSafeInteger(request.sponsorSlot) || request.sponsorSlot < 0 || request.sponsorSlot >= 4) {
      throw new Error("Encrypted sponsor slot must be an integer from 0 through 3");
    }
    const encrypted = await this.options.nox.encryptInput(
      BigInt(request.sponsorSlot),
      "uint256",
      this.options.settlement,
    );
    requireActive(request.signal);
    assertNoxProof(encrypted.handleProof);
    const transactionHash = await submitTransaction(() =>
      this.options.wallet.writeContract({
        address: this.options.settlement,
        abi: ENROLL_ABI,
        functionName: "enroll",
        args: [request.account, encrypted.handle, encrypted.handleProof],
      }),
    );
    await requireSuccessfulReceipt(this.options.chain, transactionHash);
    return { transactionHash };
  }
}

function requireBigint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${name} chain value is invalid`);
  }
  return value;
}

function eventArgs(value: object): Record<string, unknown> {
  const args = (value as { readonly args?: unknown }).args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("ChitRecorded event args are invalid");
  }
  return args as Record<string, unknown>;
}

function parseChitEvent(value: object, epoch: bigint): ChitEvent {
  const args = eventArgs(value);
  if (args.epoch !== epoch || typeof args.account !== "string") {
    throw new Error("ChitRecorded event context is invalid");
  }
  let account: Address;
  try {
    account = getAddress(args.account);
  } catch {
    throw new Error("ChitRecorded event account is invalid");
  }
  return {
    account,
    gasCost: requireBigint(args.gasCost, "gasCost"),
  };
}

function aggregateEvents(events: readonly object[], epoch: bigint): ChitEvent[] {
  const claims = new Map<string, ChitEvent>();
  for (const event of events) {
    const parsed = parseChitEvent(event, epoch);
    const key = parsed.account.toLowerCase();
    const existing = claims.get(key);
    claims.set(key, {
      account: existing?.account ?? parsed.account,
      gasCost: (existing?.gasCost ?? 0n) + parsed.gasCost,
    });
  }
  return [...claims.values()];
}

export class EpochSettlementAdapter {
  constructor(private readonly options: EpochSettlementOptions) {}

  async nextSettlementEpoch(signal: AbortSignal): Promise<bigint> {
    requireActive(signal);
    return (await this.readEpochs()).settled;
  }

  async settle(request: SettlementRequest): Promise<{
    epoch: bigint;
    settlementTransactionHash: Hex;
    closeTransactionHash?: Hex;
  }> {
    requireActive(request.signal);
    if (!this.options.policy.isSettlementReady(request.round)) {
      throw new Error("Round has unresolved operation reservations");
    }
    const epochs = await this.readEpochs();
    const closeTransactionHash = await this.closeIfNeeded(epochs, request.signal);
    const epoch = epochs.settled;
    const claims = await this.readClaims(epoch);
    await this.validateClaims(epoch, claims);
    requireActive(request.signal);
    const settlementTransactionHash = await submitTransaction(() =>
      this.options.wallet.writeContract({
        address: this.options.settlement,
        abi: SETTLE_EPOCH_ABI,
        functionName: "settleEpoch",
        args: [epoch, claims.map(({ account }) => account), claims.map(({ gasCost }) => gasCost)],
      }),
    );
    await requireSuccessfulReceipt(this.options.chain, settlementTransactionHash);
    return {
      epoch,
      settlementTransactionHash,
      ...(closeTransactionHash === undefined ? {} : { closeTransactionHash }),
    };
  }

  private async readEpochs(): Promise<{ current: bigint; settled: bigint }> {
    const [current, settled] = await Promise.all([
      this.readUint(this.options.paymaster, PAYMASTER_READ_ABI, "currentEpoch"),
      this.readUint(
        this.options.settlement,
        SETTLEMENT_READ_ABI,
        "settledEpochs",
      ),
    ]);
    if (settled > current) throw new Error("Settlement epoch exceeds current epoch");
    return { current, settled };
  }

  private async closeIfNeeded(
    epochs: { readonly current: bigint; readonly settled: bigint },
    signal: AbortSignal,
  ): Promise<Hex | undefined> {
    if (epochs.settled < epochs.current) return undefined;
    requireActive(signal);
    const state = await this.options.chain.readContract({
      address: this.options.paymaster,
      abi: ROUND_STATE_ABI,
      functionName: "roundState",
    });
    if (state !== 1 && state !== 1n) {
      throw new Error("No unsettled epoch is available to close");
    }
    const hash = await submitTransaction(() =>
      this.options.wallet.writeContract({
        address: this.options.paymaster,
        abi: CLOSE_EPOCH_ABI,
        functionName: "closeEpoch",
        args: [],
      }),
    );
    await requireSuccessfulReceipt(this.options.chain, hash);
    return hash;
  }

  private async readClaims(epoch: bigint): Promise<ChitEvent[]> {
    const events = await this.options.chain.getContractEvents({
      address: this.options.paymaster,
      abi: CHIT_RECORDED_EVENT,
      eventName: "ChitRecorded",
      args: { epoch },
      fromBlock: this.options.roundStartBlock,
    });
    return aggregateEvents(events, epoch);
  }

  private async validateClaims(epoch: bigint, claims: readonly ChitEvent[]): Promise<void> {
    const onChain = await Promise.all(
      claims.map(({ account }) =>
        this.options.chain.readContract({
          address: this.options.paymaster,
          abi: PAYMASTER_READ_ABI,
          functionName: "claim",
          args: [epoch, account],
        }),
      ),
    );
    const expectedTotal = await this.readUint(
      this.options.paymaster,
      PAYMASTER_READ_ABI,
      "epochTotal",
      [epoch],
    );
    const suppliedTotal = claims.reduce((total, claim) => total + claim.gasCost, 0n);
    if (suppliedTotal !== expectedTotal) throw new Error("Epoch total does not match events");
    onChain.forEach((value, index) => {
      if (requireBigint(value, "claim") !== claims[index]?.gasCost) {
        throw new Error("Account claim does not match events");
      }
    });
  }

  private async readUint(
    address: Address,
    abi: readonly object[],
    functionName: string,
    args?: readonly unknown[],
  ): Promise<bigint> {
    return requireBigint(
      await this.options.chain.readContract({
        address,
        abi,
        functionName,
        ...(args === undefined ? {} : { args }),
      }),
      functionName,
    );
  }
}

export class OperatorGasRecoveryAdapter {
  constructor(private readonly options: OperatorGasRecoveryOptions) {}

  async recover(request: { readonly signal: AbortSignal }): Promise<{
    transactionHash: Hex;
    recoveredValue: bigint;
    retainedGas: bigint;
  }> {
    requireActive(request.signal);
    await this.requireClosed();
    const quote = await this.quoteRecovery();
    requireActive(request.signal);
    const transactionHash = await this.sendRecovery(quote);
    await requireSuccessfulReceipt(this.options.chain, transactionHash);
    return {
      transactionHash,
      recoveredValue: quote.recoveredValue,
      retainedGas: quote.retainedGas,
    };
  }

  private async quoteRecovery(): Promise<RecoveryQuote> {
    const [balance, gasPrice, gas] = await Promise.all([
      this.options.chain.getBalance({ address: this.options.operator }),
      this.options.chain.getGasPrice(),
      this.options.chain.estimateGas({
        account: this.options.operator,
        to: this.options.creator,
        value: 0n,
      }),
    ]);
    if (gasPrice <= 0n) {
      throw new Error("Chain did not return a positive gas price");
    }
    const retainedGas = gas * gasPrice;
    if (balance <= retainedGas) throw new Error("Operator balance cannot cover recovery gas");
    const recoveredValue = balance - retainedGas;
    return { recoveredValue, retainedGas, gas, gasPrice };
  }

  private sendRecovery(quote: RecoveryQuote): Promise<Hex> {
    return submitTransaction(() =>
      this.options.wallet.sendTransaction({
        account: this.options.operator,
        to: this.options.creator,
        value: quote.recoveredValue,
        gas: quote.gas,
        gasPrice: quote.gasPrice,
      }),
    );
  }

  private async requireClosed(): Promise<void> {
    const state = await this.options.chain.readContract({
      address: this.options.paymaster,
      abi: ROUND_STATE_ABI,
      functionName: "roundState",
    });
    if (state !== 3 && state !== 3n) {
      throw new Error("Round must be closed before operator gas recovery");
    }
  }
}

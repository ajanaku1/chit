import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, type Hex } from "viem";
import {
  EpochSettlementAdapter,
  NoxEnrollmentAdapter,
  OperatorGasRecoveryAdapter,
} from "../src/live-adapters.js";

const SETTLEMENT = `0x${"11".repeat(20)}` as Address;
const ACCOUNT = `0x${"22".repeat(20)}` as Address;
const INPUT_HANDLE = `0x${"33".repeat(32)}` as Hex;
const INPUT_PROOF = `0x${"44".repeat(137)}` as Hex;
const TRANSACTION_HASH = `0x${"55".repeat(32)}` as Hex;
const PAYMASTER = `0x${"66".repeat(20)}` as Address;
const ROUND = `0x${"77".repeat(32)}`;

interface EnrollmentOptions {
  readonly settlement: Address;
  readonly nox: {
    encryptInput(value: bigint, type: "uint256", contract: Address): Promise<{
      readonly handle: Hex;
      readonly handleProof: Hex;
    }>;
  };
  readonly wallet: {
    writeContract(request: object): Promise<Hex>;
  };
  readonly chain: {
    waitForTransactionReceipt(request: { readonly hash: Hex }): Promise<{
      readonly status: "success" | "reverted";
    }>;
  };
}

const Enrollment = NoxEnrollmentAdapter as unknown as new (
  options: EnrollmentOptions,
) => {
  enroll(request: {
    readonly account: Address;
    readonly sponsorSlot: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly transactionHash: Hex }>;
};

interface SettlementOptions {
  readonly paymaster: Address;
  readonly settlement: Address;
  readonly roundStartBlock: bigint;
  readonly policy: { isSettlementReady(round: string): boolean };
  readonly wallet: { writeContract(request: object): Promise<Hex> };
  readonly chain: {
    readContract(request: Record<string, unknown>): Promise<unknown>;
    getContractEvents(request: Record<string, unknown>): Promise<readonly object[]>;
    waitForTransactionReceipt(request: { readonly hash: Hex }): Promise<{
      readonly status: "success" | "reverted";
    }>;
  };
}

const Settlement = EpochSettlementAdapter as unknown as new (
  options: SettlementOptions,
) => {
  nextSettlementEpoch(signal: AbortSignal): Promise<bigint>;
  settle(request: { readonly round: string; readonly signal: AbortSignal }): Promise<{
    readonly epoch: bigint;
    readonly settlementTransactionHash: Hex;
    readonly closeTransactionHash?: Hex;
  }>;
};

interface RecoveryOptions {
  readonly paymaster: Address;
  readonly operator: Address;
  readonly creator: Address;
  readonly wallet: {
    sendTransaction(request: object): Promise<Hex>;
  };
  readonly chain: {
    readContract(request: Record<string, unknown>): Promise<unknown>;
    getBalance(request: { readonly address: Address }): Promise<bigint>;
    getGasPrice(): Promise<bigint>;
    estimateGas(request: object): Promise<bigint>;
    waitForTransactionReceipt(request: { readonly hash: Hex }): Promise<{
      readonly status: "success" | "reverted";
    }>;
  };
}

const Recovery = OperatorGasRecoveryAdapter as unknown as new (
  options: RecoveryOptions,
) => {
  recover(request: { readonly signal: AbortSignal }): Promise<{
    readonly transactionHash: Hex;
    readonly recoveredValue: bigint;
    readonly retainedGas: bigint;
  }>;
};

describe("live operator adapters", () => {
  it("exports the enrollment, settlement, and recovery adapters", async () => {
    const modulePath = "../src/live-adapters.js";
    const adapters = await import(modulePath).catch(() => null);

    assert.notEqual(adapters, null);
    assert.equal(typeof adapters?.NoxEnrollmentAdapter, "function");
    assert.equal(typeof adapters?.EpochSettlementAdapter, "function");
    assert.equal(typeof adapters?.OperatorGasRecoveryAdapter, "function");
  });

  it("encrypts the sponsor slot for the settlement and submits exact enrollment", async () => {
    const encryptionCalls: unknown[] = [];
    const writes: object[] = [];
    const waits: object[] = [];
    const adapter = new Enrollment({
      settlement: SETTLEMENT,
      nox: {
        async encryptInput(value, type, contract) {
          encryptionCalls.push({ value, type, contract });
          return { handle: INPUT_HANDLE, handleProof: INPUT_PROOF };
        },
      },
      wallet: {
        async writeContract(request) {
          writes.push(request);
          return TRANSACTION_HASH;
        },
      },
      chain: {
        async waitForTransactionReceipt(request) {
          waits.push(request);
          return { status: "success" };
        },
      },
    });

    const result = await adapter.enroll({
      account: ACCOUNT,
      sponsorSlot: 2,
      signal: new AbortController().signal,
    });

    assert.deepEqual(encryptionCalls, [
      { value: 2n, type: "uint256", contract: SETTLEMENT },
    ]);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], {
      address: SETTLEMENT,
      abi: [
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
      ],
      functionName: "enroll",
      args: [ACCOUNT, INPUT_HANDLE, INPUT_PROOF],
    });
    assert.deepEqual(waits, [{ hash: TRANSACTION_HASH }]);
    assert.deepEqual(result, { transactionHash: TRANSACTION_HASH });
  });

  it("fails closed for aborts, malformed proofs, and unknown receipts", async () => {
    let encryptions = 0;
    let writes = 0;
    const baseOptions = {
      settlement: SETTLEMENT,
      nox: {
        async encryptInput() {
          encryptions += 1;
          return { handle: INPUT_HANDLE, handleProof: "0x1234" as Hex };
        },
      },
      wallet: {
        async writeContract() {
          writes += 1;
          return TRANSACTION_HASH;
        },
      },
      chain: {
        async waitForTransactionReceipt() {
          return { status: "success" as const };
        },
      },
    };
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      new Enrollment(baseOptions).enroll({
        account: ACCOUNT,
        sponsorSlot: 2,
        signal: aborted.signal,
      }),
      /aborted/,
    );
    assert.equal(encryptions, 0);

    await assert.rejects(
      new Enrollment(baseOptions).enroll({
        account: ACCOUNT,
        sponsorSlot: 4,
        signal: new AbortController().signal,
      }),
      /sponsor slot/,
    );
    assert.equal(encryptions, 0);

    await assert.rejects(
      new Enrollment(baseOptions).enroll({
        account: ACCOUNT,
        sponsorSlot: 2,
        signal: new AbortController().signal,
      }),
      /137 bytes/,
    );
    assert.equal(writes, 0);

    const unknown = new Enrollment({
      ...baseOptions,
      nox: {
        async encryptInput() {
          return { handle: INPUT_HANDLE, handleProof: INPUT_PROOF };
        },
      },
      chain: {
        async waitForTransactionReceipt() {
          throw new Error("RPC disconnected");
        },
      },
    });
    await assert.rejects(
      unknown.enroll({
        account: ACCOUNT,
        sponsorSlot: 2,
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "UnknownTransactionOutcomeError" &&
        "transactionHash" in error &&
        error.transactionHash === TRANSACTION_HASH,
    );
  });

  it("treats a broadcast RPC disconnect as unknown without retrying", async () => {
    let receiptReads = 0;
    const adapter = new Enrollment({
      settlement: SETTLEMENT,
      nox: {
        async encryptInput() {
          return { handle: INPUT_HANDLE, handleProof: INPUT_PROOF };
        },
      },
      wallet: {
        async writeContract() {
          throw new Error("RPC disconnected during broadcast");
        },
      },
      chain: {
        async waitForTransactionReceipt() {
          receiptReads += 1;
          return { status: "success" };
        },
      },
    });

    await assert.rejects(
      adapter.enroll({
        account: ACCOUNT,
        sponsorSlot: 2,
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "UnknownTransactionOutcomeError" &&
        "transactionHash" in error &&
        error.transactionHash === undefined,
    );
    assert.equal(receiptReads, 0);
  });

  it("reconstructs a closed epoch from public events and settles exact claims", async () => {
    const accountTwo = `0x${"88".repeat(20)}` as Address;
    const writes: object[] = [];
    const reads: Array<Record<string, unknown>> = [];
    const adapter = new Settlement({
      paymaster: PAYMASTER,
      settlement: SETTLEMENT,
      roundStartBlock: 100n,
      policy: { isSettlementReady: () => true },
      wallet: {
        async writeContract(request) {
          writes.push(request);
          return TRANSACTION_HASH;
        },
      },
      chain: {
        async readContract(request) {
          reads.push(request);
          const functionName = request.functionName;
          if (functionName === "currentEpoch") return 1n;
          if (functionName === "settledEpochs") return 0n;
          if (functionName === "epochTotal") return 12n;
          if (functionName === "claim") {
            const args = request.args as readonly unknown[];
            return args[1] === ACCOUNT ? 5n : 7n;
          }
          throw new Error(`Unexpected read ${String(functionName)}`);
        },
        async getContractEvents() {
          return [
            { args: { epoch: 0n, account: ACCOUNT, gasCost: 5n } },
            { args: { epoch: 0n, account: accountTwo, gasCost: 7n } },
          ];
        },
        async waitForTransactionReceipt() {
          return { status: "success" };
        },
      },
    });

    const result = await adapter.settle({
      round: ROUND,
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, {
      epoch: 0n,
      settlementTransactionHash: TRANSACTION_HASH,
    });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], {
      address: SETTLEMENT,
      abi: [
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
      ],
      functionName: "settleEpoch",
      args: [0n, [ACCOUNT, accountTwo], [5n, 7n]],
    });
    assert.equal(
      reads.filter((read) => read.functionName === "claim").length,
      2,
    );
    for (const read of reads) {
      const abi = read.abi as ReadonlyArray<{ readonly name?: string }>;
      assert.equal(
        abi.some((item) => item.name === read.functionName),
        true,
        `ABI must contain ${String(read.functionName)}`,
      );
    }
  });

  it("exposes the next durable settlement identity without writing", async () => {
    let writes = 0;
    const adapter = new Settlement({
      paymaster: PAYMASTER,
      settlement: SETTLEMENT,
      roundStartBlock: 100n,
      policy: { isSettlementReady: () => true },
      wallet: {
        async writeContract() {
          writes += 1;
          return TRANSACTION_HASH;
        },
      },
      chain: {
        async readContract(request) {
          if (request.functionName === "currentEpoch") return 4n;
          if (request.functionName === "settledEpochs") return 3n;
          throw new Error(`Unexpected read ${String(request.functionName)}`);
        },
        async getContractEvents() {
          return [];
        },
        async waitForTransactionReceipt() {
          return { status: "success" };
        },
      },
    });

    const epoch = await adapter.nextSettlementEpoch(
      new AbortController().signal,
    );

    assert.equal(epoch, 3n);
    assert.equal(writes, 0);
  });

  it("closes the active epoch once when no closed epoch is pending", async () => {
    const closeHash = `0x${"99".repeat(32)}` as Hex;
    const writes: object[] = [];
    const adapter = new Settlement({
      paymaster: PAYMASTER,
      settlement: SETTLEMENT,
      roundStartBlock: 100n,
      policy: { isSettlementReady: () => true },
      wallet: {
        async writeContract(request) {
          writes.push(request);
          return writes.length === 1 ? closeHash : TRANSACTION_HASH;
        },
      },
      chain: {
        async readContract(request) {
          if (request.functionName === "currentEpoch") return 0n;
          if (request.functionName === "settledEpochs") return 0n;
          if (request.functionName === "roundState") return 1;
          if (request.functionName === "epochTotal") return 0n;
          throw new Error(`Unexpected read ${String(request.functionName)}`);
        },
        async getContractEvents() {
          return [];
        },
        async waitForTransactionReceipt() {
          return { status: "success" };
        },
      },
    });

    const result = await adapter.settle({
      round: ROUND,
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, {
      epoch: 0n,
      closeTransactionHash: closeHash,
      settlementTransactionHash: TRANSACTION_HASH,
    });
    assert.deepEqual(writes[0], {
      address: PAYMASTER,
      abi: [
        {
          type: "function",
          name: "closeEpoch",
          stateMutability: "nonpayable",
          inputs: [],
          outputs: [{ name: "closedEpoch", type: "uint256" }],
        },
      ],
      functionName: "closeEpoch",
      args: [],
    });
    assert.equal(writes.length, 2);
  });

  it("does not attempt to close an already closed fully settled round", async () => {
    let writes = 0;
    const adapter = new Settlement({
      paymaster: PAYMASTER,
      settlement: SETTLEMENT,
      roundStartBlock: 100n,
      policy: { isSettlementReady: () => true },
      wallet: {
        async writeContract() {
          writes += 1;
          return TRANSACTION_HASH;
        },
      },
      chain: {
        async readContract(request) {
          if (request.functionName === "currentEpoch") return 1n;
          if (request.functionName === "settledEpochs") return 1n;
          if (request.functionName === "roundState") return 3;
          throw new Error(`Unexpected read ${String(request.functionName)}`);
        },
        async getContractEvents() {
          return [];
        },
        async waitForTransactionReceipt() {
          return { status: "success" };
        },
      },
    });

    await assert.rejects(
      adapter.settle({ round: ROUND, signal: new AbortController().signal }),
      /No unsettled epoch/,
    );
    assert.equal(writes, 0);
  });

  it("rejects malformed event accounts before constructing settlement calldata", async () => {
    let writes = 0;
    const adapter = new Settlement({
      paymaster: PAYMASTER,
      settlement: SETTLEMENT,
      roundStartBlock: 100n,
      policy: { isSettlementReady: () => true },
      wallet: {
        async writeContract() {
          writes += 1;
          return TRANSACTION_HASH;
        },
      },
      chain: {
        async readContract(request) {
          if (request.functionName === "currentEpoch") return 1n;
          if (request.functionName === "settledEpochs") return 0n;
          if (request.functionName === "claim") return 5n;
          if (request.functionName === "epochTotal") return 5n;
          throw new Error(`Unexpected read ${String(request.functionName)}`);
        },
        async getContractEvents() {
          return [{ args: { epoch: 0n, account: "not-an-address", gasCost: 5n } }];
        },
        async waitForTransactionReceipt() {
          return { status: "success" };
        },
      },
    });

    await assert.rejects(
      adapter.settle({ round: ROUND, signal: new AbortController().signal }),
      /event account is invalid/,
    );
    assert.equal(writes, 0);
  });

  it("blocks settlement while any authorization outcome is unresolved", async () => {
    let chainCalls = 0;
    const adapter = new Settlement({
      paymaster: PAYMASTER,
      settlement: SETTLEMENT,
      roundStartBlock: 100n,
      policy: { isSettlementReady: () => false },
      wallet: {
        async writeContract() {
          throw new Error("write must not run");
        },
      },
      chain: {
        async readContract() {
          chainCalls += 1;
          return 0n;
        },
        async getContractEvents() {
          chainCalls += 1;
          return [];
        },
        async waitForTransactionReceipt() {
          chainCalls += 1;
          return { status: "success" };
        },
      },
    });

    await assert.rejects(
      adapter.settle({ round: ROUND, signal: new AbortController().signal }),
      /unresolved operation reservations/,
    );
    assert.equal(chainCalls, 0);
  });

  it("recovers only the closed round operator balance after reserving exact gas", async () => {
    const operator = `0x${"aa".repeat(20)}` as Address;
    const creator = `0x${"bb".repeat(20)}` as Address;
    const sends: object[] = [];
    const adapter = new Recovery({
      paymaster: PAYMASTER,
      operator,
      creator,
      wallet: {
        async sendTransaction(request) {
          sends.push(request);
          return TRANSACTION_HASH;
        },
      },
      chain: {
        async readContract() {
          return 3;
        },
        async getBalance() {
          return 1_000_000n;
        },
        async getGasPrice() {
          return 2n;
        },
        async estimateGas() {
          return 21_000n;
        },
        async waitForTransactionReceipt() {
          return { status: "success" };
        },
      },
    });

    const result = await adapter.recover({
      signal: new AbortController().signal,
    });

    assert.deepEqual(sends, [
      {
        account: operator,
        to: creator,
        value: 958_000n,
        gas: 21_000n,
        gasPrice: 2n,
      },
    ]);
    assert.deepEqual(result, {
      transactionHash: TRANSACTION_HASH,
      recoveredValue: 958_000n,
      retainedGas: 42_000n,
    });
  });
});

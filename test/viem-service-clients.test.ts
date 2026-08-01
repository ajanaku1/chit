import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import {
  SelfBundlingOperationExecutor,
  ViemAccountChainReader,
  ViemLifecycleReconciler,
  ViemOperationChainReader,
  ViemSponsorChainReader,
  type ServiceExecutionClient,
  type ServicePublicClient,
  type ServiceWalletClient,
} from "../src/viem-service-clients.js";
import { type LifecycleActionRecord } from "../src/lifecycle-types.js";
import { deriveSimpleAccountSalt } from "../src/operator-service.js";
import { type UserOperation } from "viem/account-abstraction";

const ROUND = `0x${"11".repeat(32)}` as Hex;
const OTHER_ROUND = `0x${"12".repeat(32)}` as Hex;
const VAULT = `0x${"21".repeat(20)}` as Address;
const SETTLEMENT = `0x${"22".repeat(20)}` as Address;
const PAYMASTER = `0x${"23".repeat(20)}` as Address;
const WRAPPER = `0x${"24".repeat(20)}` as Address;
const TOKEN = `0x${"25".repeat(20)}` as Address;
const ENTRY_POINT = `0x${"26".repeat(20)}` as Address;
const ACCOUNT_FACTORY = `0x${"27".repeat(20)}` as Address;
const COUNTER = `0x${"28".repeat(20)}` as Address;
const SPONSOR = `0x${"31".repeat(20)}` as Address;
const OWNER = `0x${"32".repeat(20)}` as Address;
const ACCOUNT = `0x${"33".repeat(20)}` as Address;
const REGISTRATION_TX = `0x${"41".repeat(32)}` as Hex;
const ENROLLMENT_TX = `0x${"42".repeat(32)}` as Hex;
const SETTLEMENT_TX = `0x${"43".repeat(32)}` as Hex;

interface MockState {
  code?: Hex;
  claim?: bigint;
  receiptStatus?: "success" | "reverted";
  settledEpochs?: bigint;
}

class MockPublicClient implements ServicePublicClient {
  readonly state: MockState;
  readonly eventCalls: Array<{ readonly eventName: string; readonly args?: object }> = [];

  constructor(state: MockState = {}) {
    this.state = state;
  }

  async getCode(): Promise<Hex | undefined> {
    return this.state.code;
  }

  async getTransactionReceipt(input: { readonly hash: Hex }) {
    if (input.hash === REGISTRATION_TX) {
      return { status: "success" as const, blockNumber: 90n };
    }
    if (input.hash === SETTLEMENT_TX && this.state.receiptStatus !== undefined) {
      return { status: this.state.receiptStatus, blockNumber: 91n };
    }
    throw new Error("receipt not found");
  }

  async getTransaction(): Promise<{
    readonly from: Address;
    readonly to: Address | null;
    readonly value: bigint;
    readonly gas: bigint;
    readonly gasPrice: bigint;
  }> {
    return { from: OWNER, to: SPONSOR, value: 90n, gas: 5n, gasPrice: 2n };
  }

  async getContractEvents(input: {
    readonly eventName: string;
    readonly args?: object;
  }): Promise<readonly object[]> {
    this.eventCalls.push({ eventName: input.eventName, args: input.args });
    if (input.eventName === "SponsorRegistered") {
      return [{ transactionHash: REGISTRATION_TX, args: { sponsor: SPONSOR, slot: 2n } }];
    }
    if (input.eventName === "Transfer") {
      return [
        { args: { from: SPONSOR, to: WRAPPER, value: 60n } },
        { args: { from: SPONSOR, to: WRAPPER, value: 40n } },
      ];
    }
    if (input.eventName === "AccountEnrolled") {
      return [{ transactionHash: ENROLLMENT_TX, args: { account: ACCOUNT } }];
    }
    return [];
  }

  async readContract(input: { readonly functionName: string }): Promise<unknown> {
    const values: Record<string, unknown> = {
      getAddress: ACCOUNT,
      enrolled: true,
      owner: OWNER,
      getNonce: 7n,
      currentEpoch: 3n,
      claim: this.state.claim ?? 0n,
      settledEpochs: this.state.settledEpochs ?? 0n,
    };
    return values[input.functionName];
  }
}

const gasCeilings = {
  call: 300_000n,
  verification: 1_000_000n,
  preVerification: 120_000n,
  paymasterVerification: 300_000n,
  paymasterPostOp: 250_000n,
  feePerGas: 2_000_000_000n,
  priorityFeePerGas: 2_000_000_000n,
};

describe("ViemSponsorChainReader", () => {
  it("requires the exact successful registration transaction and sums public wraps", async () => {
    const client = new MockPublicClient();
    const reader = new ViemSponsorChainReader({
      client,
      round: ROUND,
      vault: VAULT,
      wrapper: WRAPPER,
      underlyingToken: TOKEN,
      fundingFromBlock: 10n,
    });

    assert.deepEqual(
      await reader.readSponsorRegistration(ROUND, SPONSOR, REGISTRATION_TX),
      { registered: true, slot: 2, confirmedFunding: 100n },
    );
    assert.deepEqual(client.eventCalls.map(({ eventName }) => eventName), [
      "SponsorRegistered",
      "Transfer",
    ]);
  });

  it("rejects a round outside its injected service context", async () => {
    const reader = new ViemSponsorChainReader({
      client: new MockPublicClient(),
      round: ROUND,
      vault: VAULT,
      wrapper: WRAPPER,
      underlyingToken: TOKEN,
      fundingFromBlock: 10n,
    });

    await assert.rejects(
      reader.readSponsorRegistration(OTHER_ROUND, SPONSOR, REGISTRATION_TX),
      /round.*context/i,
    );
  });
});

const operation = {
  sender: ACCOUNT,
  nonce: 7n,
  callData: "0x1234",
  callGasLimit: 300_000n,
  verificationGasLimit: 1_000_000n,
  preVerificationGas: 120_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: 300_000n,
  paymasterPostOpGasLimit: 250_000n,
  paymasterData: "0x1234",
  signature: "0x5678",
} satisfies UserOperation<"0.7">;

class ExecutionClient extends MockPublicClient implements ServiceExecutionClient {
  simulationError: Error | undefined;
  waitError: Error | undefined;

  async simulateContract(): Promise<{ readonly request: Readonly<Record<string, unknown>> }> {
    if (this.simulationError !== undefined) throw this.simulationError;
    return { request: { gas: 5_000_000n } };
  }

  async waitForTransactionReceipt(): Promise<{
    readonly status: "success" | "reverted";
  }> {
    if (this.waitError !== undefined) throw this.waitError;
    return { status: this.state.receiptStatus ?? "success" };
  }
}

class ExecutionWallet implements ServiceWalletClient {
  calls = 0;
  error: Error | undefined;

  async writeContract(): Promise<Hex> {
    this.calls += 1;
    if (this.error !== undefined) throw this.error;
    return SETTLEMENT_TX;
  }
}

describe("SelfBundlingOperationExecutor", () => {
  it("simulates, self-bundles, waits, and returns the confirmed public claim", async () => {
    const client = new ExecutionClient({ claim: 55n });
    const wallet = new ExecutionWallet();
    const executor = new SelfBundlingOperationExecutor({
      client,
      wallet,
      entryPoint: ENTRY_POINT,
      paymaster: PAYMASTER,
      beneficiary: OWNER,
    });

    assert.deepEqual(await executor.simulateAndSubmit(operation), {
      status: "confirmed",
      transactionHash: SETTLEMENT_TX,
      actualClaim: 55n,
    });
    assert.equal(wallet.calls, 1);
  });

  it("classifies a pre-broadcast simulation rejection as a known failure", async () => {
    const client = new ExecutionClient();
    client.simulationError = new Error("AA24 signature error");
    const wallet = new ExecutionWallet();
    const executor = new SelfBundlingOperationExecutor({
      client,
      wallet,
      entryPoint: ENTRY_POINT,
      paymaster: PAYMASTER,
      beneficiary: OWNER,
    });

    assert.deepEqual(await executor.simulateAndSubmit(operation), {
      status: "known-failure",
      reason: "AA24 signature error",
    });
    assert.equal(wallet.calls, 0);
  });

  it("keeps broadcast and receipt failures unknown instead of retrying", async () => {
    const firstClient = new ExecutionClient();
    const firstWallet = new ExecutionWallet();
    firstWallet.error = new Error("connection reset");
    const first = new SelfBundlingOperationExecutor({
      client: firstClient,
      wallet: firstWallet,
      entryPoint: ENTRY_POINT,
      paymaster: PAYMASTER,
      beneficiary: OWNER,
    });
    const secondClient = new ExecutionClient();
    secondClient.waitError = new Error("timeout");
    const second = new SelfBundlingOperationExecutor({
      client: secondClient,
      wallet: new ExecutionWallet(),
      entryPoint: ENTRY_POINT,
      paymaster: PAYMASTER,
      beneficiary: OWNER,
    });

    assert.deepEqual(await first.simulateAndSubmit(operation), { status: "unknown" });
    assert.deepEqual(await second.simulateAndSubmit(operation), {
      status: "unknown",
      transactionHash: SETTLEMENT_TX,
    });
  });
});

describe("Viem account and operation readers", () => {
  it("derives the canonical account through the injected v0.7 factory", async () => {
    const reader = new ViemAccountChainReader({
      client: new MockPublicClient(),
      factory: ACCOUNT_FACTORY,
    });

    assert.equal(await reader.predictSimpleAccount(OWNER, 9n), ACCOUNT);
  });

  it("builds exact undeployed-account and fixed-counter operation facts", async () => {
    const client = new MockPublicClient({ code: undefined });
    const reader = new ViemOperationChainReader({
      client,
      round: ROUND,
      settlement: SETTLEMENT,
      paymaster: PAYMASTER,
      entryPoint: ENTRY_POINT,
      accountFactory: ACCOUNT_FACTORY,
      counter: COUNTER,
      chainId: 11155111,
      gasCeilings,
    });

    const facts = await reader.readOperationFacts(ROUND, ACCOUNT, OWNER);
    const accountSalt = deriveSimpleAccountSalt(11155111, ROUND, OWNER);
    const increment = encodeFunctionData({
      abi: [{ type: "function", name: "increment", inputs: [], outputs: [] }],
      functionName: "increment",
    });

    assert.deepEqual(facts, {
      enrolled: true,
      deployed: false,
      nonce: 7n,
      accountFactory: ACCOUNT_FACTORY,
      accountFactoryData: encodeFunctionData({
        abi: [{
          type: "function",
          name: "createAccount",
          inputs: [
            { name: "owner", type: "address" },
            { name: "salt", type: "uint256" },
          ],
          outputs: [{ name: "account", type: "address" }],
        }],
        functionName: "createAccount",
        args: [OWNER, accountSalt],
      }),
      expectedCallData: encodeFunctionData({
        abi: [{
          type: "function",
          name: "execute",
          inputs: [
            { name: "dest", type: "address" },
            { name: "value", type: "uint256" },
            { name: "func", type: "bytes" },
          ],
          outputs: [],
        }],
        functionName: "execute",
        args: [COUNTER, 0n, increment],
      }),
      paymaster: PAYMASTER,
      currentEpochClaim: 0n,
      gasCeilings,
    });
  });
});

function lifecycleRecord(
  kind: LifecycleActionRecord["kind"],
  actionKey: string,
  transactionHash?: Hex,
): LifecycleActionRecord {
  return {
    actionKey,
    kind,
    round: ROUND,
    state: "unknown",
    requestHash: `0x${"51".repeat(32)}`,
    requestScope: "test",
    signer: OWNER,
    nonce: "nonce-1",
    ...(transactionHash === undefined ? {} : { transactionHash }),
  };
}

describe("ViemLifecycleReconciler", () => {
  it("recovers enrollment provenance from the account event when no hash was returned", async () => {
    const reconciler = new ViemLifecycleReconciler({
      client: new MockPublicClient(),
      round: ROUND,
      settlement: SETTLEMENT,
      operator: OWNER,
      creator: SPONSOR,
      roundStartBlock: 10n,
    });

    assert.deepEqual(
      await reconciler.reconcile(
        lifecycleRecord("enrollment", `enrollment:${ROUND}:${ACCOUNT}`),
        new AbortController().signal,
      ),
      {
        status: "confirmed",
        result: { kind: "enrollment", transactionHash: ENROLLMENT_TX },
      },
    );
  });

  it("confirms a successful settlement only after the epoch advanced", async () => {
    const reconciler = new ViemLifecycleReconciler({
      client: new MockPublicClient({ receiptStatus: "success", settledEpochs: 2n }),
      round: ROUND,
      settlement: SETTLEMENT,
      operator: OWNER,
      creator: SPONSOR,
      roundStartBlock: 10n,
    });

    assert.deepEqual(
      await reconciler.reconcile(
        lifecycleRecord("settlement", `settlement:${ROUND}:1`, SETTLEMENT_TX),
        new AbortController().signal,
      ),
      {
        status: "confirmed",
        result: {
          kind: "settlement",
          epoch: "1",
          settlementTransactionHash: SETTLEMENT_TX,
        },
      },
    );
  });

  it("marks a reverted known transaction retry-safe and keeps hashless settlement unresolved", async () => {
    const reverted = new ViemLifecycleReconciler({
      client: new MockPublicClient({ receiptStatus: "reverted" }),
      round: ROUND,
      settlement: SETTLEMENT,
      operator: OWNER,
      creator: SPONSOR,
      roundStartBlock: 10n,
    });
    const unknown = new ViemLifecycleReconciler({
      client: new MockPublicClient({ settledEpochs: 2n }),
      round: ROUND,
      settlement: SETTLEMENT,
      operator: OWNER,
      creator: SPONSOR,
      roundStartBlock: 10n,
    });

    assert.deepEqual(
      await reverted.reconcile(
        lifecycleRecord("settlement", `settlement:${ROUND}:1`, SETTLEMENT_TX),
        new AbortController().signal,
      ),
      { status: "retry-safe" },
    );
    assert.deepEqual(
      await unknown.reconcile(
        lifecycleRecord("settlement", `settlement:${ROUND}:1`),
        new AbortController().signal,
      ),
      { status: "unresolved" },
    );
  });

  it("reconstructs a confirmed operator-gas recovery from its public transaction", async () => {
    const reconciler = new ViemLifecycleReconciler({
      client: new MockPublicClient({ receiptStatus: "success" }),
      round: ROUND,
      settlement: SETTLEMENT,
      operator: OWNER,
      creator: SPONSOR,
      roundStartBlock: 10n,
    });

    assert.deepEqual(
      await reconciler.reconcile(
        lifecycleRecord(
          "operator-gas-recovery",
          `recovery:${ROUND}:${"61".repeat(32)}`,
          SETTLEMENT_TX,
        ),
        new AbortController().signal,
      ),
      {
        status: "confirmed",
        result: {
          kind: "operator-gas-recovery",
          transactionHash: SETTLEMENT_TX,
          recoveredValue: "90",
          retainedGas: "10",
        },
      },
    );
  });
});

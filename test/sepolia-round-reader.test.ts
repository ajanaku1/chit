import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, type Hex } from "viem";
import {
  SepoliaRoundReader,
  parseSepoliaServiceTarget,
  type SepoliaReadClient,
} from "../src/sepolia-round-reader.js";

const FACTORY = `0x${"11".repeat(20)}` as Address;
const CREATOR = `0x${"22".repeat(20)}` as Address;
const OPERATOR = `0x${"33".repeat(20)}` as Address;
const AUDITOR = `0x${"44".repeat(20)}` as Address;
const VAULT = `0x${"55".repeat(20)}` as Address;
const SETTLEMENT = `0x${"66".repeat(20)}` as Address;
const PAYMASTER = `0x${"77".repeat(20)}` as Address;
const ROUND = `0x${"88".repeat(32)}` as Hex;

class RecordingSepoliaClient implements SepoliaReadClient {
  chainId = 11_155_111;
  missingCode: Address | undefined;
  factoryOperator = OPERATOR;
  currentOperator = OPERATOR;
  readonly reads: Array<{ address: Address; functionName: string }> = [];

  async getChainId(): Promise<number> {
    return this.chainId;
  }

  async getCode(input: { address: Address }): Promise<Hex | undefined> {
    return input.address === this.missingCode ? "0x" : "0x6000";
  }

  async getBalance(input: { address: Address }): Promise<bigint> {
    assert.equal(input.address, OPERATOR);
    return 10n;
  }

  async readContract(input: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
    abi: readonly object[];
  }): Promise<unknown> {
    this.reads.push({ address: input.address, functionName: input.functionName });
    if (input.address === FACTORY && input.functionName === "getRound") {
      assert.deepEqual(input.args, [ROUND]);
      return {
        creator: CREATOR,
        operator: this.factoryOperator,
        verifier: this.factoryOperator,
        auditor: AUDITOR,
        vault: VAULT,
        settlement: SETTLEMENT,
        paymaster: PAYMASTER,
        initializedSteps: 31,
      };
    }
    const values: Record<string, unknown> = {
      [`${PAYMASTER}:roundState`]: 1,
      [`${PAYMASTER}:currentEpoch`]: 2n,
      [`${PAYMASTER}:entryPointBalance`]: 100n,
      [`${PAYMASTER}:creator`]: CREATOR,
      [`${PAYMASTER}:operator`]: this.currentOperator,
      [`${PAYMASTER}:verifier`]: this.currentOperator,
      [`${PAYMASTER}:settlement`]: SETTLEMENT,
      [`${SETTLEMENT}:settledEpochs`]: 1n,
      [`${SETTLEMENT}:paymaster`]: PAYMASTER,
      [`${SETTLEMENT}:operator`]: this.currentOperator,
      [`${VAULT}:sponsorCount`]: 2n,
      [`${VAULT}:creator`]: CREATOR,
      [`${VAULT}:settlement`]: SETTLEMENT,
    };
    const value = values[`${input.address}:${input.functionName}`];
    if (value === undefined) throw new Error("Unexpected contract read");
    return value;
  }
}

describe("Sepolia round reader", () => {
  it("parses only a complete Sepolia factory target", () => {
    assert.deepEqual(parseSepoliaServiceTarget({
      chainId: 11_155_111,
      factory: FACTORY,
      roundId: ROUND,
    }), {
      factory: FACTORY,
      round: ROUND,
    });
    assert.throws(
      () => parseSepoliaServiceTarget({
        chainId: 1,
        factory: FACTORY,
        roundId: ROUND,
      }),
      /Sepolia/i,
    );
    assert.throws(
      () => parseSepoliaServiceTarget({
        chainId: 11_155_111,
        factory: "0x1234",
        roundId: ROUND,
      }),
      /factory/i,
    );
  });

  it("returns a fully wired public snapshot without constructing a signer", async () => {
    const client = new RecordingSepoliaClient();
    const reader = new SepoliaRoundReader({
      client,
      factory: FACTORY,
      expectedOperator: OPERATOR,
    });

    const snapshot = await reader.read(ROUND, AbortSignal.timeout(1_000));

    assert.deepEqual(snapshot, {
      round: ROUND,
      creator: CREATOR,
      operator: OPERATOR,
      verifier: OPERATOR,
      factoryOperator: OPERATOR,
      factoryVerifier: OPERATOR,
      auditor: AUDITOR,
      vault: VAULT,
      settlement: SETTLEMENT,
      paymaster: PAYMASTER,
      initializedSteps: 31,
      state: "active",
      sponsorCount: 2,
      currentEpoch: "2",
      settledEpochs: "1",
      entryPointBalance: "100",
      operatorBalance: "10",
    });
    assert.equal(client.reads.length, 14);
  });

  it("accepts a creator-authorized live role rotation while preserving factory provenance", async () => {
    const client = new RecordingSepoliaClient();
    client.factoryOperator = `0x${"98".repeat(20)}`;
    const reader = new SepoliaRoundReader({
      client,
      factory: FACTORY,
      expectedOperator: OPERATOR,
    });

    const snapshot = await reader.read(ROUND, AbortSignal.timeout(1_000));

    assert.equal(snapshot.operator, OPERATOR);
    assert.equal(snapshot.verifier, OPERATOR);
    assert.equal(snapshot.factoryOperator, client.factoryOperator);
    assert.equal(snapshot.factoryVerifier, client.factoryOperator);
  });

  it("fails closed on the wrong chain, missing code, or another operator", async () => {
    const wrongChain = new RecordingSepoliaClient();
    wrongChain.chainId = 1;
    await assert.rejects(
      new SepoliaRoundReader({
        client: wrongChain,
        factory: FACTORY,
        expectedOperator: OPERATOR,
      }).read(ROUND, AbortSignal.timeout(1_000)),
      /Sepolia/i,
    );

    const missingCode = new RecordingSepoliaClient();
    missingCode.missingCode = SETTLEMENT;
    await assert.rejects(
      new SepoliaRoundReader({
        client: missingCode,
        factory: FACTORY,
        expectedOperator: OPERATOR,
      }).read(ROUND, AbortSignal.timeout(1_000)),
      /bytecode/i,
    );

    const wrongOperator = new RecordingSepoliaClient();
    wrongOperator.currentOperator = `0x${"99".repeat(20)}`;
    await assert.rejects(
      new SepoliaRoundReader({
        client: wrongOperator,
        factory: FACTORY,
        expectedOperator: OPERATOR,
      }).read(ROUND, AbortSignal.timeout(1_000)),
      /operator/i,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENTRY_POINT_V07,
  NOX_COMPUTE_SEPOLIA,
  SIMPLE_ACCOUNT_FACTORY_V07,
  parseDeploymentRecord,
} from "../src/deployment-record.js";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const transaction = (digit: string) => `0x${digit.repeat(64)}`;

const validRecord = {
  chainId: 11155111,
  entryPoint: ENTRY_POINT_V07,
  noxCompute: NOX_COMPUTE_SEPOLIA,
  simpleAccountFactory: SIMPLE_ACCOUNT_FACTORY_V07,
  chitToken: address("1"),
  chitBudgetToken: address("2"),
  chitPaymaster: address("3"),
  chitVault: address("4"),
  chitSettlement: address("5"),
  chitCounter: address("6"),
  simpleAccount: address("7"),
  deployTransactions: {
    chitToken: transaction("1"),
    chitBudgetToken: transaction("2"),
    chitPaymaster: transaction("3"),
    chitVault: transaction("4"),
    chitSettlement: transaction("5"),
    chitCounter: transaction("6"),
  },
  sponsorFundTx: transaction("7"),
  sponsorEnrollTx: transaction("8"),
  sponsoredUserOpTx: transaction("9"),
  settleEpochTx: transaction("a"),
};

describe("Sepolia deployment record", () => {
  it("accepts complete, canonical, live-verifiable evidence", () => {
    assert.deepEqual(parseDeploymentRecord(validRecord), validRecord);
  });

  it("rejects a non-Sepolia chain or substituted infrastructure", () => {
    assert.throws(
      () => parseDeploymentRecord({ ...validRecord, chainId: 1 }),
      /Sepolia/i,
    );
    assert.throws(
      () => parseDeploymentRecord({ ...validRecord, entryPoint: address("f") }),
      /EntryPoint/i,
    );
  });

  it("rejects placeholder addresses and malformed transaction hashes", () => {
    assert.throws(
      () => parseDeploymentRecord({ ...validRecord, chitVault: address("0") }),
      /chitVault/i,
    );
    assert.throws(
      () => parseDeploymentRecord({ ...validRecord, settleEpochTx: "0x1234" }),
      /settleEpochTx/i,
    );
    assert.throws(
      () =>
        parseDeploymentRecord({
          ...validRecord,
          settleEpochTx: transaction("0"),
        }),
      /settleEpochTx/i,
    );
  });
});

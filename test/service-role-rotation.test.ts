import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, type Hex } from "viem";
import {
  assertOperatorRotationSupported,
  parseServiceOperatorRecord,
  parseSecretHex,
  planServiceRoleRotation,
  type RoundServiceRoles,
  UnsupportedRotationError,
} from "../src/service-role-rotation.js";

const DEPLOYER = `0x${"11".repeat(20)}` as Address;
const SERVICE = `0x${"22".repeat(20)}` as Address;
const FACTORY = `0x${"33".repeat(20)}` as Address;
const PAYMASTER = `0x${"44".repeat(20)}` as Address;
const SETTLEMENT = `0x${"55".repeat(20)}` as Address;
const ROUND = `0x${"66".repeat(32)}` as Hex;

function roles(overrides: Partial<RoundServiceRoles> = {}): RoundServiceRoles {
  return {
    verifier: DEPLOYER,
    paymasterOperator: DEPLOYER,
    settlementOperator: DEPLOYER,
    ...overrides,
  };
}

describe("service role rotation planner", () => {
  it("rejects deployments that cannot rotate both operator roles", () => {
    const supported = `0x63b3ab15fb00` as Hex;
    const unsupported = "0x6000" as Hex;

    assert.doesNotThrow(() =>
      assertOperatorRotationSupported(supported, supported),
    );
    assert.throws(
      () => assertOperatorRotationSupported(unsupported, supported),
      UnsupportedRotationError,
    );
    assert.throws(
      () => assertOperatorRotationSupported(supported, unsupported),
      /settlement.*setOperator/i,
    );
  });

  it("parses only a complete public Sepolia rotation target", () => {
    const record = {
      chainId: 11_155_111,
      factory: FACTORY,
      round: ROUND,
      creator: DEPLOYER,
      paymaster: PAYMASTER,
      settlement: SETTLEMENT,
      serviceOperator: SERVICE,
    };
    assert.deepEqual(parseServiceOperatorRecord(record), record);
    assert.throws(
      () => parseServiceOperatorRecord({ ...record, chainId: 1 }),
      /Sepolia/i,
    );
    assert.throws(
      () => parseServiceOperatorRecord({ ...record, serviceOperator: "0x1234" }),
      /serviceOperator/i,
    );
  });

  it("normalizes either common 32-byte secret representation", () => {
    const raw = "ab".repeat(32);
    assert.equal(parseSecretHex(raw, "secret"), `0x${raw}`);
    assert.equal(parseSecretHex(`0x${raw}`, "secret"), `0x${raw}`);
    assert.equal(parseSecretHex(`  ${raw}\n`, "secret"), `0x${raw}`);
    assert.throws(() => parseSecretHex("abcd", "secret"), /32-byte/i);
  });

  it("orders verifier before both operator changes", () => {
    assert.deepEqual(planServiceRoleRotation(roles(), SERVICE), [
      { contract: "paymaster", functionName: "setVerifier" },
      { contract: "paymaster", functionName: "setOperator" },
      { contract: "settlement", functionName: "setOperator" },
    ]);
  });

  it("is resumable after any already-confirmed step", () => {
    assert.deepEqual(
      planServiceRoleRotation(roles({ verifier: SERVICE }), SERVICE),
      [
        { contract: "paymaster", functionName: "setOperator" },
        { contract: "settlement", functionName: "setOperator" },
      ],
    );
    assert.deepEqual(
      planServiceRoleRotation(roles({
        verifier: SERVICE,
        paymasterOperator: SERVICE,
        settlementOperator: SERVICE,
      }), SERVICE),
      [],
    );
  });

  it("rejects the zero address as a service authority", () => {
    assert.throws(
      () => planServiceRoleRotation(roles(), `0x${"00".repeat(20)}`),
      /zero/i,
    );
  });
});

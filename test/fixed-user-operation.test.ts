import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildFixedUserOperation,
  contractInteger,
  FIXED_BUNDLER_GAS,
  hostedOperationReservationDigest,
  parseSerializedUserOperation,
  serializeUserOperation,
  verifyOwnerOperationSignature,
} from "../src/fixed-user-operation.js";
import { userOperationHash } from "../src/user-operation.js";
import { POST } from "../api/user-operation.js";

const OWNER = privateKeyToAccount(`0x${"17".repeat(32)}`);
const SENDER = `0x${"22".repeat(20)}` as const;
const FACTORY = `0x${"33".repeat(20)}` as const;
const COUNTER = `0x${"44".repeat(20)}` as const;
const PAYMASTER = `0x${"55".repeat(20)}` as const;
const ENTRY_POINT = `0x${"66".repeat(20)}` as const;
const FACTORY_DATA = `0x${"77".repeat(32)}` as const;

describe("hosted fixed UserOperation", () => {
  it("returns JSON when asynchronous submit validation rejects", async () => {
    const response = await POST(new Request("https://chit.example/api/user-operation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Request body is invalid" });
  });

  it("uses the proven bounded outer handleOps gas limit", () => {
    assert.equal(FIXED_BUNDLER_GAS, 5_000_000n);
  });

  it("normalizes viem integer results across uint widths", () => {
    assert.equal(contractInteger(1n, "uint256"), 1n);
    assert.equal(contractInteger(1, "uint8"), 1n);
    assert.throws(() => contractInteger(-1, "uint8"), /invalid/i);
  });

  it("builds only the canonical counter increment action", () => {
    const operation = buildFixedUserOperation({
      sender: SENDER,
      nonce: 0n,
      deployed: false,
      factory: FACTORY,
      factoryData: FACTORY_DATA,
      counter: COUNTER,
      paymaster: PAYMASTER,
      maxFeePerGas: 2_000_000_000n,
    });
    const increment = encodeFunctionData({
      abi: parseAbi(["function increment()"]),
      functionName: "increment",
    });

    assert.equal(operation.callData, encodeFunctionData({
      abi: parseAbi(["function execute(address dest,uint256 value,bytes func)"]),
      functionName: "execute",
      args: [COUNTER, 0n, increment],
    }));
    assert.equal(operation.factory, FACTORY);
    assert.equal(operation.factoryData, FACTORY_DATA);
    assert.equal(operation.signature, "0x");
    assert.equal(operation.paymasterData, "0x");
  });

  it("round-trips the exact operation without accepting unknown fields", () => {
    const operation = buildFixedUserOperation({
      sender: SENDER,
      nonce: 4n,
      deployed: true,
      factory: FACTORY,
      factoryData: FACTORY_DATA,
      counter: COUNTER,
      paymaster: PAYMASTER,
      maxFeePerGas: 3_000_000_000n,
    });
    const serialized = serializeUserOperation(operation);

    assert.deepEqual(parseSerializedUserOperation(serialized), operation);
    assert.throws(
      () => parseSerializedUserOperation({ ...serialized, callTarget: COUNTER }),
      /unknown fields/i,
    );
  });

  it("accepts only the owner signature over the authorized UserOperation hash", async () => {
    const operation = buildFixedUserOperation({
      sender: SENDER,
      nonce: 0n,
      deployed: true,
      factory: FACTORY,
      factoryData: FACTORY_DATA,
      counter: COUNTER,
      paymaster: PAYMASTER,
      maxFeePerGas: 2_000_000_000n,
    });
    const hash = userOperationHash(operation, ENTRY_POINT, 11_155_111);
    const signature = await OWNER.signMessage({ message: { raw: hash } });

    await verifyOwnerOperationSignature(operation, signature, OWNER.address, ENTRY_POINT, 11_155_111);
    await assert.rejects(
      verifyOwnerOperationSignature(operation, signature, `0x${"88".repeat(20)}`, ENTRY_POINT, 11_155_111),
      /creator signature/i,
    );
  });

  it("binds a hosted reservation to the operation hash and expiry", () => {
    const first = hostedOperationReservationDigest(
      `0x${"91".repeat(32)}`,
      2_000_000_000,
    );
    const changedExpiry = hostedOperationReservationDigest(
      `0x${"91".repeat(32)}`,
      2_000_000_001,
    );

    assert.notEqual(first, changedExpiry);
    assert.equal(first.length, 66);
  });
});

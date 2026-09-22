import assert from "node:assert/strict";
import test from "node:test";

import { encodeAbiParameters, getAddress, parseAbi, type Hex } from "viem";

import { constructorArgsOf, contractsOf } from "../../src/fleet/explorer-set.js";

/** T092: what the explorer is asked to verify is what the record names and what the creation transaction carried. */

const POOL_ABI = parseAbi(["constructor(address admin_, address operator_, uint256 depositorCap_, uint256 drawCap_, uint256 poolCap_)"]);
const OP = "0x34b0ba20669f3ec4f1056853780c381e5e35f724";

test("the set is every contract the record names with both an address and a creation hash, the pool and the session factory included", () => {
  const set = contractsOf({
    campaignEscrow: "0x4c33", campaignEscrowTx: "0xb554",
    paymaster: "0x5c80", // no paymasterTx: left out, never guessed
    sessionPolicy: "0x4a0c", sessionPolicyTx: "0x1ed0",
    accountFactory: "0x7478", accountFactoryTx: "0xd8c5",
    pool: { address: "0x5c61", deployTx: "0xb479" },
    sessionKeys: { factory: "0xe6ab", deployTx: "0x057f" },
  });
  assert.deepEqual(set.map((c) => c.key), ["campaignEscrow", "sessionPolicy", "accountFactory", "pool", "sessionKeys.factory"]);
  assert.equal(set.find((c) => c.key === "pool")?.contract, "contracts/fleet/FleetPool.sol:FleetPool");
  assert.deepEqual(contractsOf({}), []);
});

test("the constructor arguments are what followed the creation bytecode, decoded against the constructor", () => {
  const bytecode = "0x60e060405234801561000f575f5ffd5b50" as Hex;
  const encoded = encodeAbiParameters(POOL_ABI[0]!.inputs, [OP, OP, 100n, 50n, 1000n]);
  const args = constructorArgsOf(`${bytecode}${encoded.slice(2)}` as Hex, bytecode, POOL_ABI);
  assert.equal(args?.encoded, encoded);
  assert.deepEqual(args?.decoded, [getAddress(OP), getAddress(OP), 100n, 50n, 1000n], "addresses come back checksummed, as the explorer form wants them");
  const none = constructorArgsOf(bytecode, bytecode, parseAbi(["function f()"]));
  assert.deepEqual(none, { encoded: "0x", decoded: [] }, "no constructor: no arguments, still verifiable");
});

test("creation code that is not this checkout's bytecode gives no arguments: the source deployed is not the source here", () => {
  const bytecode = "0x60e060405234801561000f575f5ffd5b50" as Hex;
  assert.equal(constructorArgsOf("0x60e060405234801561000f575f5ffd5b51ffff" as Hex, bytecode, POOL_ABI), undefined);
});

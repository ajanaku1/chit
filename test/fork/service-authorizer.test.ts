import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256, stringToHex, type UserOperation } from "viem";
import { requiredPrefund, type OperationPolicy } from "../../src/operation-policy.js";
import {
  PaymasterAuthorizer,
  authorizationDigest,
} from "../../src/service-crypto.js";
import { packChitUserOperation } from "../../src/user-operation.js";

describe("protected verifier contract compatibility", () => {
  it("matches ChitPaymaster's authorization digest exactly", async () => {
    const { viem } = await network.connect();
    const [creator, owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();
    const context = {
      chainId,
      factory: creator.account.address,
      creator: creator.account.address,
      roundSalt: keccak256(stringToHex("service-authorizer")),
    };
    const authorizer = new PaymasterAuthorizer({
      masterSecret: Buffer.alloc(32, 19),
      operatorContext: context,
      entryPoint: creator.account.address,
      paymaster: owner.account.address,
    });
    const paymaster = await viem.deployContract("ChitPaymaster", [
      creator.account.address,
      creator.account.address,
      creator.account.address,
      creator.account.address,
      authorizer.address,
      authorizer.address,
      creator.account.address,
    ]);
    const operation: UserOperation<"0.7"> = {
      sender: owner.account.address,
      nonce: 0n,
      callData: "0x12345678",
      callGasLimit: 150_000n,
      verificationGasLimit: 400_000n,
      preVerificationGas: 70_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      paymaster: paymaster.address,
      paymasterVerificationGasLimit: 200_000n,
      paymasterPostOpGasLimit: 80_000n,
      paymasterData: "0x",
      signature: "0x",
    };
    const policy: OperationPolicy = {
      account: operation.sender,
      expectedNonce: operation.nonce,
      accountDeployed: true,
      accountFactory: creator.account.address,
      accountFactoryData: "0x",
      expectedCallData: operation.callData,
      paymaster: paymaster.address,
      maximumCost: requiredPrefund(operation),
      validUntil: 2_000_000_000,
      now: 1_900_000_000,
      currentEpochClaim: 0n,
      gasCeilings: {
        call: operation.callGasLimit,
        verification: operation.verificationGasLimit,
        preVerification: operation.preVerificationGas,
        paymasterVerification: operation.paymasterVerificationGasLimit ?? 0n,
        paymasterPostOp: operation.paymasterPostOpGasLimit ?? 0n,
        feePerGas: operation.maxFeePerGas,
        priorityFeePerGas: operation.maxPriorityFeePerGas,
      },
    };
    const configured = new PaymasterAuthorizer({
      masterSecret: Buffer.alloc(32, 19),
      operatorContext: context,
      entryPoint: creator.account.address,
      paymaster: paymaster.address,
    });
    const authorization = await configured.authorize(operation, policy);
    const packed = packChitUserOperation({
      ...operation,
      paymasterData: authorization.paymasterData,
    });
    const contractDigest = await paymaster.read.authorizationDigest([
      packed,
      policy.maximumCost,
      policy.validUntil,
    ]);

    assert.equal(
      contractDigest,
      authorizationDigest({
        operation,
        entryPoint: creator.account.address,
        chainId,
        paymaster: paymaster.address,
        maximumCost: policy.maximumCost,
        validUntil: policy.validUntil,
      }),
    );
  });
});

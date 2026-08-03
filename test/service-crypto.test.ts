import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  decodeAbiParameters,
  recoverMessageAddress,
  type Hex,
} from "viem";
import { type UserOperation } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { PolicyStore } from "../src/policy-store.js";
import { type OperationPolicy } from "../src/operation-policy.js";
import {
  InviteCodec,
  PaymasterAuthorizer,
  authorizationDigest,
  buildRequestMessage,
  deriveOperatorAccount,
  deriveOperatorAddress,
  verifyRequestSignature,
} from "../src/service-crypto.js";

const CHAIN_ID = 11155111;
const FACTORY = `0x${"11".repeat(20)}` as const;
const CREATOR = `0x${"22".repeat(20)}` as const;
const ROUND = `0x${"33".repeat(32)}`;
const ROUND_SALT = `0x${"44".repeat(32)}`;
const SPONSOR = `0x${"55".repeat(20)}` as const;
const OWNER = `0x${"66".repeat(20)}` as const;
const ACCOUNT = `0x${"77".repeat(20)}` as const;
const MASTER_SECRET = Buffer.alloc(32, 9);
const temporaryDirectories: string[] = [];

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const PAYMASTER = `0x${"99".repeat(20)}` as const;
const ACCOUNT_FACTORY = `0x${"aa".repeat(20)}` as const;

const preparedOperation: UserOperation<"0.7"> = {
  sender: ACCOUNT,
  nonce: 0n,
  factory: ACCOUNT_FACTORY,
  factoryData: "0x1234",
  callData: "0x5678",
  callGasLimit: 150_000n,
  verificationGasLimit: 400_000n,
  preVerificationGas: 70_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: 200_000n,
  paymasterPostOpGasLimit: 80_000n,
  paymasterData: "0x",
  signature: "0x",
};

const operationPolicy: OperationPolicy = {
  account: ACCOUNT,
  expectedNonce: 0n,
  accountDeployed: false,
  accountFactory: ACCOUNT_FACTORY,
  accountFactoryData: "0x1234",
  expectedCallData: "0x5678",
  paymaster: PAYMASTER,
  maximumCost: 1_800_000_000_000_000n,
  validUntil: 2_000_000_000,
  now: 1_900_000_000,
  currentEpochClaim: 0n,
  gasCeilings: {
    call: 200_000n,
    verification: 500_000n,
    preVerification: 100_000n,
    paymasterVerification: 250_000n,
    paymasterPostOp: 100_000n,
    feePerGas: 3_000_000_000n,
    priorityFeePerGas: 2_000_000_000n,
  },
};

function inviteCodec(chainId = CHAIN_ID): InviteCodec {
  return new InviteCodec({
    masterSecret: MASTER_SECRET,
    origin: "https://chit.example",
    chainId,
    factory: FACTORY,
  });
}

function invitePayload() {
  return {
    round: ROUND,
    sponsor: SPONSOR,
    sponsorSlot: 2,
    owner: OWNER,
    account: ACCOUNT,
    expiresAt: 2_000_000_000,
    nonce: "invite-7",
    action: "counter.increment" as const,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("round-scoped key derivation", () => {
  it("returns only a deterministic public operator address bound to every domain", () => {
    const context = {
      chainId: CHAIN_ID,
      factory: FACTORY,
      creator: CREATOR,
      roundSalt: ROUND_SALT,
    };
    const address = deriveOperatorAddress(MASTER_SECRET, context);

    assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(deriveOperatorAccount(MASTER_SECRET, context).address, address);
    assert.equal(deriveOperatorAddress(MASTER_SECRET, context), address);
    assert.notEqual(
      deriveOperatorAddress(MASTER_SECRET, { ...context, chainId: 11155112 }),
      address,
    );
    assert.notEqual(
      deriveOperatorAddress(MASTER_SECRET, {
        ...context,
        roundSalt: `0x${"45".repeat(32)}`,
      }),
      address,
    );
  });
});

describe("opaque invite capability", () => {
  it("hides and authenticates the sponsor graph while binding its full context", () => {
    const codec = inviteCodec();
    const payload = invitePayload();
    const token = codec.issue(payload);

    assert.equal(token.includes(SPONSOR.slice(2)), false);
    assert.equal(token.includes(OWNER.slice(2)), false);
    assert.equal(token.includes(ACCOUNT.slice(2)), false);
    assert.deepEqual(
      codec.open(token, {
        round: ROUND,
        owner: OWNER,
        account: ACCOUNT,
        action: "counter.increment",
        now: 1_900_000_000,
      }),
      payload,
    );
    assert.throws(
      () =>
        codec.open(token, {
          round: `0x${"34".repeat(32)}`,
          owner: OWNER,
          account: ACCOUNT,
          action: "counter.increment",
          now: 1_900_000_000,
        }),
      /round/i,
    );
    assert.throws(
      () =>
        codec.open(token, {
          round: ROUND,
          owner: SPONSOR,
          account: ACCOUNT,
          action: "counter.increment",
          now: 1_900_000_000,
        }),
      /owner/i,
    );
    assert.throws(
      () =>
        codec.open(token, {
          round: ROUND,
          owner: OWNER,
          account: SPONSOR,
          action: "counter.increment",
          now: 1_900_000_000,
        }),
      /account/i,
    );
  });

  it("rejects tampering, another chain context, and expired capabilities", () => {
    const token = inviteCodec().issue(invitePayload());
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const expected = {
      round: ROUND,
      owner: OWNER,
      account: ACCOUNT,
      action: "counter.increment" as const,
      now: 1_900_000_000,
    };

    assert.throws(() => inviteCodec().open(tampered, expected), /authenticate|token/i);
    assert.throws(() => inviteCodec(CHAIN_ID + 1).open(token, expected), /authenticate|token/i);
    assert.throws(
      () => inviteCodec().open(token, { ...expected, now: 2_000_000_001 }),
      /expired/i,
    );
  });
});

describe("privileged request proof", () => {
  it("binds origin, chain, factory, round, body hash, nonce, and expiry", async () => {
    const signer = privateKeyToAccount(`0x${"12".repeat(32)}`);
    const request = {
      origin: "https://chit.example",
      chainId: CHAIN_ID,
      factory: FACTORY,
      round: ROUND,
      bodyHash: `0x${"88".repeat(32)}`,
      nonce: "creator-4",
      expiresAt: 2_000_000_000,
    };
    const signature = await signer.signMessage({
      message: buildRequestMessage(request),
    });

    await verifyRequestSignature(request, signature, signer.address, 1_900_000_000);
    for (const changed of [
      { ...request, origin: "https://evil.example" },
      { ...request, chainId: CHAIN_ID + 1 },
      { ...request, round: `0x${"34".repeat(32)}` },
      { ...request, bodyHash: `0x${"89".repeat(32)}` },
      { ...request, nonce: "creator-5" },
    ]) {
      await assert.rejects(
        verifyRequestSignature(changed, signature, signer.address, 1_900_000_000),
        /signature/i,
      );
    }
    await assert.rejects(
      verifyRequestSignature(request, signature, signer.address, 2_000_000_001),
      /expired/i,
    );
  });

  it("persists request nonces as single-use values", () => {
    const directory = mkdtempSync(join(tmpdir(), "chit-nonce-"));
    temporaryDirectories.push(directory);
    const store = new PolicyStore({
      path: join(directory, "policy.sqlite"),
      encryptionKey: Buffer.alloc(32, 3),
    });
    const nonce = {
      scope: "creator",
      round: ROUND,
      signer: CREATOR,
      nonce: "creator-4",
      expiresAt: 2_000_000_000,
    };

    store.consumeRequestNonce(nonce);
    assert.throws(() => store.consumeRequestNonce(nonce), /nonce/i);
    store.close();
  });
});

describe("restricted paymaster authorizer", () => {
  it("signs only the fully validated Chit authorization digest", async () => {
    const context = {
      chainId: CHAIN_ID,
      factory: FACTORY,
      creator: CREATOR,
      roundSalt: ROUND_SALT,
    };
    const authorizer = new PaymasterAuthorizer({
      masterSecret: MASTER_SECRET,
      operatorContext: context,
      entryPoint: ENTRY_POINT,
      paymaster: PAYMASTER,
    });
    const result = await authorizer.authorize(
      preparedOperation,
      operationPolicy,
    );
    const digest = authorizationDigest({
      operation: preparedOperation,
      entryPoint: ENTRY_POINT,
      chainId: CHAIN_ID,
      paymaster: PAYMASTER,
      maximumCost: operationPolicy.maximumCost,
      validUntil: operationPolicy.validUntil,
    });
    const recovered = await recoverMessageAddress({
      message: { raw: digest },
      signature: result.signature,
    });
    const [expiry, embeddedSignature] = decodeAbiParameters(
      [{ type: "uint48" }, { type: "bytes" }],
      result.paymasterData,
    );

    assert.equal(authorizer.address, deriveOperatorAddress(MASTER_SECRET, context));
    assert.equal(recovered, authorizer.address);
    assert.equal(expiry, operationPolicy.validUntil);
    assert.equal(embeddedSignature, result.signature);
    assert.equal("signMessage" in authorizer, false);
    assert.equal("signHash" in authorizer, false);
  });

  it("rejects generic-sign attempts represented by any changed operation", async () => {
    const authorizer = new PaymasterAuthorizer({
      masterSecret: MASTER_SECRET,
      operatorContext: {
        chainId: CHAIN_ID,
        factory: FACTORY,
        creator: CREATOR,
        roundSalt: ROUND_SALT,
      },
      entryPoint: ENTRY_POINT,
      paymaster: PAYMASTER,
    });
    const changed = {
      ...preparedOperation,
      callData: "0xbeef" as Hex,
    };

    await assert.rejects(
      authorizer.authorize(changed, operationPolicy),
      /call data/i,
    );
  });
});

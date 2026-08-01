import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  encodeAbiParameters,
  hexToBigInt,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  OperatorService,
  type AccountChainReader,
  type OperationChainReader,
  type OperationChainFacts,
  type OperationExecutor,
  type SubmissionOutcome,
  type SponsorChainReader,
  type WalletProof,
} from "../src/operator-service.js";
import { PolicyStore } from "../src/policy-store.js";
import {
  InviteCodec,
  PaymasterAuthorizer,
  buildRequestMessage,
  hashRequestBody,
} from "../src/service-crypto.js";

const CHAIN_ID = 11155111;
const ORIGIN = "https://chit.example";
const FACTORY = `0x${"11".repeat(20)}` as Address;
const ROUND = `0x${"22".repeat(32)}`;
const REGISTRATION_TX = `0x${"33".repeat(32)}`;
const creator = privateKeyToAccount(`0x${"44".repeat(32)}`);
const sponsor = privateKeyToAccount(`0x${"55".repeat(32)}`);
const otherSponsor = privateKeyToAccount(`0x${"56".repeat(32)}`);
const temporaryDirectories: string[] = [];
const OWNER = `0x${"66".repeat(20)}` as Address;
const ACCOUNT = `0x${"77".repeat(20)}` as Address;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const PAYMASTER = `0x${"88".repeat(20)}` as Address;
const ACCOUNT_FACTORY = `0x${"99".repeat(20)}` as Address;

class RecordingSponsorReader implements SponsorChainReader {
  calls = 0;
  registration = {
    registered: true,
    slot: 2,
    confirmedFunding: 100n,
  };

  async readSponsorRegistration(): Promise<{
    registered: boolean;
    slot: number;
    confirmedFunding: bigint;
  }> {
    this.calls += 1;
    return this.registration;
  }
}

class RecordingAccountReader implements AccountChainReader {
  calls: Array<{ owner: Address; salt: bigint }> = [];

  async predictSimpleAccount(owner: Address, salt: bigint): Promise<Address> {
    this.calls.push({ owner, salt });
    return ACCOUNT;
  }
}

class RecordingOperationReader implements OperationChainReader {
  facts: OperationChainFacts = {
    enrolled: true,
    deployed: false,
    nonce: 0n,
    accountFactory: ACCOUNT_FACTORY,
    accountFactoryData: "0x1234" as Hex,
    expectedCallData: "0x5678" as Hex,
    paymaster: PAYMASTER,
    currentEpochClaim: 0n,
    gasCeilings: {
      call: 2n,
      verification: 2n,
      preVerification: 2n,
      paymasterVerification: 2n,
      paymasterPostOp: 2n,
      feePerGas: 2n,
      priorityFeePerGas: 2n,
    },
  };

  async readOperationFacts() {
    return this.facts;
  }
}

class RecordingExecutor implements OperationExecutor {
  calls = 0;
  outcome: SubmissionOutcome = {
    status: "confirmed",
    transactionHash: `0x${"ab".repeat(32)}`,
    actualClaim: 3n,
  };
  error: Error | undefined;

  async simulateAndSubmit(): Promise<SubmissionOutcome> {
    this.calls += 1;
    if (this.error !== undefined) throw this.error;
    return this.outcome;
  }
}

function createService(
  reader = new RecordingSponsorReader(),
  accountReader = new RecordingAccountReader(),
  operationReader = new RecordingOperationReader(),
  operationExecutor = new RecordingExecutor(),
) {
  const directory = mkdtempSync(join(tmpdir(), "chit-service-"));
  temporaryDirectories.push(directory);
  const store = new PolicyStore({
    path: join(directory, "policy.sqlite"),
    encryptionKey: Buffer.alloc(32, 31),
  });
  const service = new OperatorService({
    origin: ORIGIN,
    chainId: CHAIN_ID,
    factory: FACTORY,
    creator: creator.address,
    round: ROUND,
    store,
    sponsorReader: reader,
    accountReader,
    inviteCodec: new InviteCodec({
      masterSecret: Buffer.alloc(32, 29),
      origin: ORIGIN,
      chainId: CHAIN_ID,
      factory: FACTORY,
    }),
    operationReader,
    operationExecutor,
    authorizer: new PaymasterAuthorizer({
      masterSecret: Buffer.alloc(32, 29),
      operatorContext: {
        chainId: CHAIN_ID,
        factory: FACTORY,
        creator: creator.address,
        roundSalt: ROUND,
      },
      entryPoint: ENTRY_POINT,
      paymaster: PAYMASTER,
    }),
    entryPoint: ENTRY_POINT,
    authorizationTtlSeconds: 60,
    clock: () => 1_900_000_000,
  });
  return {
    accountReader,
    operationExecutor,
    operationReader,
    reader,
    service,
    store,
  };
}

async function proof(
  signer: PrivateKeyAccount,
  body: object,
  nonce: string,
): Promise<WalletProof> {
  const expiresAt = 2_000_000_000;
  const fields = {
    origin: ORIGIN,
    chainId: CHAIN_ID,
    factory: FACTORY,
    round: ROUND,
    bodyHash: hashRequestBody(body),
    nonce,
    expiresAt,
  };
  return {
    nonce,
    expiresAt,
    signature: await signer.signMessage({ message: buildRequestMessage(fields) }),
  };
}

async function request(sponsorAccount = sponsor) {
  const admissionBody = {
    sponsor: sponsorAccount.address,
    slot: 2,
  };
  const registrationBody = {
    sponsor: sponsorAccount.address,
    slot: 2,
    registrationTx: REGISTRATION_TX,
    declaredBudget: "100",
  };
  return {
    round: ROUND,
    sponsor: sponsorAccount.address,
    slot: 2,
    registrationTx: REGISTRATION_TX,
    declaredBudget: 100n,
    admission: await proof(creator, admissionBody, "admit-1"),
    sponsorProof: await proof(sponsorAccount, registrationBody, "sponsor-1"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("protected sponsor admission", () => {
  it("requires both wallets and confirmed chain facts before encrypted persistence", async () => {
    const { reader, service, store } = createService();

    await service.registerSponsor(await request());

    assert.equal(reader.calls, 1);
    assert.deepEqual(store.readSponsorPolicy(ROUND, sponsor.address), {
      declaredBudget: 100n,
      claimed: 0n,
      reserved: 0n,
      slot: 2,
    });
    store.close();
  });

  it("rejects a tampered sponsor admission before consulting the chain", async () => {
    const { reader, service, store } = createService();
    const valid = await request(sponsor);
    const tampered = {
      ...valid,
      sponsor: otherSponsor.address,
      sponsorProof: {
        ...valid.sponsorProof,
        signature: valid.sponsorProof.signature as Hex,
      },
    };

    await assert.rejects(service.registerSponsor(tampered), /signature/i);
    assert.equal(reader.calls, 0);
    store.close();
  });

  it("rejects any round outside its round-scoped key context", async () => {
    const { reader, service, store } = createService();
    const valid = await request();

    await assert.rejects(
      service.registerSponsor({
        ...valid,
        round: `0x${"23".repeat(32)}`,
      }),
      /service context/i,
    );
    assert.equal(reader.calls, 0);
    store.close();
  });

  it("rejects an unregistered slot and a declaration above confirmed funding", async () => {
    const unregisteredReader = new RecordingSponsorReader();
    unregisteredReader.registration = {
      registered: false,
      slot: 2,
      confirmedFunding: 100n,
    };
    const first = createService(unregisteredReader);
    await assert.rejects(
      first.service.registerSponsor(await request()),
      /registered/i,
    );
    first.store.close();

    const underfundedReader = new RecordingSponsorReader();
    underfundedReader.registration = {
      registered: true,
      slot: 2,
      confirmedFunding: 99n,
    };
    const second = createService(underfundedReader);
    await assert.rejects(
      second.service.registerSponsor(await request()),
      /funding/i,
    );
    second.store.close();
  });

  it("consumes both privileged nonces atomically", async () => {
    const { service, store } = createService();
    const signed = await request();

    await service.registerSponsor(signed);
    await assert.rejects(service.registerSponsor(signed), /nonce/i);
    store.close();
  });
});

describe("opaque invite issuance", () => {
  async function inviteRequest() {
    const body = {
      sponsor: sponsor.address,
      slot: 2,
      owner: OWNER,
      inviteNonce: "invite-1",
      inviteExpiresAt: 2_000_000_000,
    };
    return {
      round: ROUND,
      sponsor: sponsor.address,
      slot: 2,
      owner: OWNER,
      inviteNonce: "invite-1",
      inviteExpiresAt: 2_000_000_000,
      sponsorProof: await proof(sponsor, body, "invite-request-1"),
    };
  }

  it("derives the canonical account and returns an owner-bound opaque capability", async () => {
    const { accountReader, service, store } = createService();
    await service.registerSponsor(await request());

    const result = await service.issueInvite(await inviteRequest());

    assert.equal(result.account, ACCOUNT);
    assert.equal(accountReader.calls.length, 1);
    assert.equal(accountReader.calls[0]?.owner, OWNER);
    assert.equal(
      accountReader.calls[0]?.salt,
      hexToBigInt(
        keccak256(
          encodeAbiParameters(
            [
              { type: "string" },
              { type: "uint256" },
              { type: "bytes32" },
              { type: "address" },
            ],
            ["CHIT_ACCOUNT_V1", BigInt(CHAIN_ID), ROUND as Hex, OWNER],
          ),
        ),
      ),
    );
    assert.equal(result.token.includes(sponsor.address.slice(2)), false);
    assert.equal(result.token.includes(OWNER.slice(2)), false);
    assert.equal(result.token.includes(ACCOUNT.slice(2)), false);
    store.close();
  });

  it("rejects a changed owner and duplicate request nonce", async () => {
    const { accountReader, service, store } = createService();
    await service.registerSponsor(await request());
    const valid = await inviteRequest();

    await assert.rejects(
      service.issueInvite({
        ...valid,
        owner: otherSponsor.address,
      }),
      /signature/i,
    );
    assert.equal(accountReader.calls.length, 0);

    await service.issueInvite(valid);
    await assert.rejects(service.issueInvite(valid), /nonce|assigned/i);
    store.close();
  });
});

describe("restricted UserOperation prepare and submit", () => {
  const unsignedOperation = {
    sender: ACCOUNT,
    nonce: 0n,
    factory: ACCOUNT_FACTORY,
    factoryData: "0x1234" as Hex,
    callData: "0x5678" as Hex,
    callGasLimit: 1n,
    verificationGasLimit: 1n,
    preVerificationGas: 1n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: 1n,
    paymasterPostOpGasLimit: 1n,
    paymasterData: "0x" as Hex,
    signature: "0x" as Hex,
  };

  async function setupJourney() {
    const fixture = createService();
    await fixture.service.registerSponsor(await request());
    const invite = await fixture.service.issueInvite(await (async () => {
      const body = {
        sponsor: sponsor.address,
        slot: 2,
        owner: OWNER,
        inviteNonce: "operation-invite",
        inviteExpiresAt: 2_000_000_000,
      };
      return {
        round: ROUND,
        sponsor: sponsor.address,
        slot: 2,
        owner: OWNER,
        inviteNonce: "operation-invite",
        inviteExpiresAt: 2_000_000_000,
        sponsorProof: await proof(sponsor, body, "operation-invite-proof"),
      };
    })());
    return { ...fixture, invite };
  }

  it("reserves exact canonical prefund and returns the signed paymaster data", async () => {
    const { invite, service, store } = await setupJourney();

    const prepared = await service.prepareUserOperation({
      round: ROUND,
      token: invite.token,
      owner: OWNER,
      operation: unsignedOperation,
    });

    assert.notEqual(prepared.operation.paymasterData, "0x");
    assert.equal(prepared.validUntil, 1_900_000_060);
    assert.equal(store.availableAllowance(ROUND, sponsor.address), 95n);
    assert.equal(store.reservationState(prepared.operationKey), "reserved");
    store.close();
  });

  it("rejects unenrolled, already-claimed, and concurrent second operations", async () => {
    const first = await setupJourney();
    first.operationReader.facts = {
      ...first.operationReader.facts,
      enrolled: false,
    };
    await assert.rejects(
      first.service.prepareUserOperation({
        round: ROUND,
        token: first.invite.token,
        owner: OWNER,
        operation: unsignedOperation,
      }),
      /enrolled/i,
    );
    first.store.close();

    const wrongOwner = await setupJourney();
    wrongOwner.operationReader.facts = {
      ...wrongOwner.operationReader.facts,
      deployed: true,
      owner: otherSponsor.address,
    };
    await assert.rejects(
      wrongOwner.service.prepareUserOperation({
        round: ROUND,
        token: wrongOwner.invite.token,
        owner: OWNER,
        operation: {
          ...unsignedOperation,
          factory: undefined,
          factoryData: undefined,
        },
      }),
      /owner/i,
    );
    wrongOwner.store.close();

    const second = await setupJourney();
    second.operationReader.facts = {
      ...second.operationReader.facts,
      currentEpochClaim: 1n,
    };
    await assert.rejects(
      second.service.prepareUserOperation({
        round: ROUND,
        token: second.invite.token,
        owner: OWNER,
        operation: unsignedOperation,
      }),
      /claim/i,
    );
    second.store.close();

    const third = await setupJourney();
    await third.service.prepareUserOperation({
      round: ROUND,
      token: third.invite.token,
      owner: OWNER,
      operation: unsignedOperation,
    });
    await assert.rejects(
      third.service.prepareUserOperation({
        round: ROUND,
        token: third.invite.token,
        owner: OWNER,
        operation: { ...unsignedOperation, callGasLimit: 2n },
      }),
      /pending/i,
    );
    third.store.close();
  });

  it("submits only an exact user-signed match and records the confirmed claim", async () => {
    const { invite, operationExecutor, service, store } = await setupJourney();
    const prepared = await service.prepareUserOperation({
      round: ROUND,
      token: invite.token,
      owner: OWNER,
      operation: unsignedOperation,
    });
    const signed = { ...prepared.operation, signature: "0xab" as Hex };

    await assert.rejects(
      service.submitUserOperation(prepared.operationKey, {
        ...signed,
        callData: "0xbeef",
      }),
      /reserved field/i,
    );
    assert.equal(operationExecutor.calls, 0);
    const outcome = await service.submitUserOperation(
      prepared.operationKey,
      signed,
    );

    assert.equal(outcome.status, "confirmed");
    assert.equal(operationExecutor.calls, 1);
    assert.equal(store.availableAllowance(ROUND, sponsor.address), 97n);
    await assert.rejects(
      service.submitUserOperation(prepared.operationKey, signed),
      /not ready/i,
    );
    store.close();
  });

  it("releases known failures but retains unknown outcomes", async () => {
    const known = await setupJourney();
    known.operationExecutor.outcome = {
      status: "known-failure",
      reason: "simulation reverted",
    };
    const first = await known.service.prepareUserOperation({
      round: ROUND,
      token: known.invite.token,
      owner: OWNER,
      operation: unsignedOperation,
    });
    await known.service.submitUserOperation(first.operationKey, {
      ...first.operation,
      signature: "0xab",
    });
    assert.equal(known.store.availableAllowance(ROUND, sponsor.address), 100n);
    known.store.close();

    const unknown = await setupJourney();
    unknown.operationExecutor.error = new Error("RPC connection reset");
    const second = await unknown.service.prepareUserOperation({
      round: ROUND,
      token: unknown.invite.token,
      owner: OWNER,
      operation: unsignedOperation,
    });
    await assert.rejects(
      unknown.service.submitUserOperation(second.operationKey, {
        ...second.operation,
        signature: "0xab",
      }),
      /unknown/i,
    );
    assert.equal(unknown.store.reservationState(second.operationKey), "unknown");
    assert.equal(unknown.store.availableAllowance(ROUND, sponsor.address), 95n);
    assert.equal(unknown.store.isSettlementReady(ROUND), false);
    unknown.store.close();
  });
});

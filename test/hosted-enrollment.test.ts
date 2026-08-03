import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  HostedEnrollmentService,
  type BeginEnrollment,
  type EnrollmentIdentity,
  type EnrollmentChallengeRecord,
  type EnrollmentRepository,
} from "../src/hosted-enrollment.js";

const OWNER_ACCOUNT = privateKeyToAccount(`0x${"31".repeat(32)}`);
const ROUND = `0x${"42".repeat(32)}`;
const FACTORY = `0x${"53".repeat(20)}` as const;
const PREDICTED_ACCOUNT = `0x${"64".repeat(20)}` as const;
const TRANSACTION_HASH = `0x${"75".repeat(32)}` as const;

class MemoryEnrollmentRepository implements EnrollmentRepository {
  readonly records = new Map<string, EnrollmentChallengeRecord>();

  async create(record: EnrollmentChallengeRecord): Promise<void> {
    this.records.set(record.nonce, record);
  }

  async begin(identity: EnrollmentIdentity): Promise<BeginEnrollment | undefined> {
    const record = this.records.get(identity.nonce);
    if (record === undefined) return undefined;
    if (record.state !== "ready" && record.state !== "failed") {
      return { started: false, record };
    }
    const pending = { ...record, state: "pending" as const };
    this.records.set(identity.nonce, pending);
    return { started: true, record: pending };
  }

  async complete(nonce: string, transactionHash: `0x${string}`): Promise<void> {
    const record = this.records.get(nonce);
    if (record === undefined) throw new Error("missing challenge");
    this.records.set(nonce, { ...record, state: "confirmed", transactionHash });
  }

  async fail(nonce: string): Promise<void> {
    const record = this.records.get(nonce);
    if (record !== undefined) this.records.set(nonce, { ...record, state: "failed" });
  }
}

function fixture() {
  const repository = new MemoryEnrollmentRepository();
  let enrollmentCount = 0;
  const service = new HostedEnrollmentService({
    origin: "https://chit.example",
    chainId: 11_155_111,
    factory: FACTORY,
    round: ROUND,
    owner: OWNER_ACCOUNT.address,
    sponsorSlot: 0,
    challengeTtlSeconds: 600,
    clock: () => 1_900_000_000,
    nonce: () => "challenge-1",
    repository,
    enrollment: {
      predict: async () => PREDICTED_ACCOUNT,
      enroll: async () => {
        enrollmentCount += 1;
        return TRANSACTION_HASH;
      },
    },
  });
  return { service, repository, enrollmentCount: () => enrollmentCount };
}

describe("hosted judge enrollment", () => {
  it("requires the configured owner signature and confirms one encrypted enrollment", async () => {
    const { service, repository, enrollmentCount } = fixture();
    const challenge = await service.challenge(OWNER_ACCOUNT.address);
    const signature = await OWNER_ACCOUNT.signMessage({ message: challenge.message });

    const result = await service.enroll({
      owner: OWNER_ACCOUNT.address,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      signature,
    });

    assert.equal(result.account, PREDICTED_ACCOUNT);
    assert.equal(result.transactionHash, TRANSACTION_HASH);
    assert.equal(enrollmentCount(), 1);
    assert.equal(repository.records.get(challenge.nonce)?.state, "confirmed");
  });

  it("rejects another wallet and does not execute enrollment", async () => {
    const { service, enrollmentCount } = fixture();
    const challenge = await service.challenge(OWNER_ACCOUNT.address);
    const attacker = privateKeyToAccount(`0x${"76".repeat(32)}`);
    const signature = await attacker.signMessage({ message: challenge.message });

    await assert.rejects(
      service.enroll({
        owner: OWNER_ACCOUNT.address,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        signature,
      }),
      /signature/i,
    );
    assert.equal(enrollmentCount(), 0);
  });
});

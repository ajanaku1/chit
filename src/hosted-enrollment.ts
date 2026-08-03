import { getAddress, type Address, type Hex } from "viem";
import {
  buildRequestMessage,
  hashRequestBody,
  verifyRequestSignature,
  type SignedRequestFields,
} from "./service-crypto.js";

export type EnrollmentState = "ready" | "pending" | "failed" | "confirmed";

export interface EnrollmentIdentity {
  readonly round: string;
  readonly owner: Address;
  readonly account: Address;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface EnrollmentChallengeRecord extends EnrollmentIdentity {
  readonly state: EnrollmentState;
  readonly transactionHash?: Hex;
}

export interface BeginEnrollment {
  readonly started: boolean;
  readonly record: EnrollmentChallengeRecord;
}

export interface EnrollmentRepository {
  create(record: EnrollmentChallengeRecord): Promise<void>;
  begin(identity: EnrollmentIdentity): Promise<BeginEnrollment | undefined>;
  complete(nonce: string, transactionHash: Hex): Promise<void>;
  fail(nonce: string): Promise<void>;
}

interface EnrollmentExecutor {
  predict(owner: Address): Promise<Address>;
  enroll(account: Address, sponsorSlot: number): Promise<Hex>;
}

interface HostedEnrollmentOptions {
  readonly origin: string;
  readonly chainId: number;
  readonly factory: Address;
  readonly round: string;
  readonly owner: Address;
  readonly sponsorSlot: number;
  readonly challengeTtlSeconds: number;
  readonly clock: () => number;
  readonly nonce: () => string;
  readonly repository: EnrollmentRepository;
  readonly enrollment: EnrollmentExecutor;
}

export interface EnrollmentChallenge {
  readonly account: Address;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly message: string;
}

export interface EnrollHostedAccountRequest {
  readonly owner: Address;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly signature: Hex;
}

export interface HostedEnrollmentResult {
  readonly account: Address;
  readonly transactionHash: Hex;
}

function enrollmentBody(owner: Address, account: Address): object {
  return { action: "enroll-hosted-demo", owner, account };
}

export class HostedEnrollmentService {
  constructor(private readonly options: HostedEnrollmentOptions) {}

  async challenge(ownerValue: Address): Promise<EnrollmentChallenge> {
    const owner = this.requireOwner(ownerValue);
    const account = await this.options.enrollment.predict(owner);
    const nonce = this.options.nonce();
    const expiresAt = this.options.clock() + this.options.challengeTtlSeconds;
    const fields = this.requestFields(owner, account, nonce, expiresAt);
    await this.options.repository.create({
      round: this.options.round,
      owner,
      account,
      nonce,
      expiresAt,
      state: "ready",
    });
    return { account, nonce, expiresAt, message: buildRequestMessage(fields) };
  }

  async enroll(request: EnrollHostedAccountRequest): Promise<HostedEnrollmentResult> {
    const owner = this.requireOwner(request.owner);
    const account = await this.options.enrollment.predict(owner);
    const identity = this.identity(request, owner, account);
    await this.verify(identity, request.signature);
    const begun = await this.options.repository.begin(identity);
    if (begun === undefined) throw new Error("Enrollment challenge was not found");
    if (!begun.started) return this.existingResult(begun.record);
    return this.executeEnrollment(identity);
  }

  private identity(
    request: EnrollHostedAccountRequest,
    owner: Address,
    account: Address,
  ): EnrollmentIdentity {
    return {
      round: this.options.round,
      owner,
      account,
      nonce: request.nonce,
      expiresAt: request.expiresAt,
    };
  }

  private async verify(identity: EnrollmentIdentity, signature: Hex): Promise<void> {
    await verifyRequestSignature(
      this.requestFields(
        identity.owner,
        identity.account,
        identity.nonce,
        identity.expiresAt,
      ),
      signature,
      identity.owner,
      this.options.clock(),
    );
  }

  private requestFields(
    owner: Address,
    account: Address,
    nonce: string,
    expiresAt: number,
  ): SignedRequestFields {
    return {
      origin: this.options.origin,
      chainId: this.options.chainId,
      factory: this.options.factory,
      round: this.options.round,
      bodyHash: hashRequestBody(enrollmentBody(owner, account)),
      nonce,
      expiresAt,
    };
  }

  private async executeEnrollment(identity: EnrollmentIdentity): Promise<HostedEnrollmentResult> {
    try {
      const transactionHash = await this.options.enrollment.enroll(
        identity.account,
        this.options.sponsorSlot,
      );
      await this.options.repository.complete(identity.nonce, transactionHash);
      return { account: identity.account, transactionHash };
    } catch (error) {
      await this.options.repository.fail(identity.nonce);
      throw error;
    }
  }

  private existingResult(record: EnrollmentChallengeRecord): HostedEnrollmentResult {
    if (record.state !== "confirmed" || record.transactionHash === undefined) {
      throw new Error("Enrollment is already pending");
    }
    return { account: record.account, transactionHash: record.transactionHash };
  }

  private requireOwner(value: Address): Address {
    const owner = getAddress(value);
    if (owner !== getAddress(this.options.owner)) {
      throw new Error("Hosted demo enrollment is restricted to the creator wallet");
    }
    return owner;
  }
}

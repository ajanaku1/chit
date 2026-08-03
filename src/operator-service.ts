import {
  encodeAbiParameters,
  hexToBigInt,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { type UserOperation } from "viem/account-abstraction";
import {
  type PolicyStore,
  type RequestNonce,
} from "./policy-store.js";
import {
  assertSubmittedOperationFingerprint,
  operationFingerprint,
  requiredPrefund,
  type GasCeilings,
  type OperationPolicy,
} from "./operation-policy.js";
import {
  hashRequestBody,
  type InviteCodec,
  type InvitePayload,
  verifyRequestSignature,
  type SignedRequestFields,
  type PaymasterAuthorizer,
} from "./service-crypto.js";
import { userOperationHash } from "./user-operation.js";

export interface SponsorChainFacts {
  readonly registered: boolean;
  readonly slot: number;
  readonly confirmedFunding: bigint;
}

export interface SponsorChainReader {
  readSponsorRegistration(
    round: string,
    sponsor: Address,
    registrationTx: string,
  ): Promise<SponsorChainFacts>;
}

export interface AccountChainReader {
  predictSimpleAccount(owner: Address, salt: bigint): Promise<Address>;
}

export interface OperationChainFacts {
  readonly enrolled: boolean;
  readonly deployed: boolean;
  readonly owner?: Address;
  readonly nonce: bigint;
  readonly accountFactory: Address;
  readonly accountFactoryData: Hex;
  readonly expectedCallData: Hex;
  readonly paymaster: Address;
  readonly currentEpochClaim: bigint;
  readonly gasCeilings: GasCeilings;
}

export interface OperationChainReader {
  readOperationFacts(
    round: string,
    account: Address,
    owner: Address,
  ): Promise<OperationChainFacts>;
}

export type SubmissionOutcome =
  | { readonly status: "confirmed"; readonly transactionHash: Hex; readonly actualClaim: bigint }
  | { readonly status: "known-failure"; readonly reason: string }
  | { readonly status: "unknown"; readonly transactionHash?: Hex };

export interface OperationExecutor {
  simulateAndSubmit(
    operation: UserOperation<"0.7">,
  ): Promise<SubmissionOutcome>;
}

export interface WalletProof {
  readonly nonce: string;
  readonly expiresAt: number;
  readonly signature: Hex;
}

export interface OperatorServiceOptions {
  readonly origin: string;
  readonly chainId: number;
  readonly factory: Address;
  readonly creator: Address;
  readonly round: string;
  readonly store: PolicyStore;
  readonly sponsorReader: SponsorChainReader;
  readonly accountReader: AccountChainReader;
  readonly inviteCodec: InviteCodec;
  readonly operationReader: OperationChainReader;
  readonly authorizer: PaymasterAuthorizer;
  readonly operationExecutor: OperationExecutor;
  readonly entryPoint: Address;
  readonly authorizationTtlSeconds: number;
  readonly clock: () => number;
  readonly sponsoredActionName?: string;
}

export interface RegisterSponsorRequest {
  readonly round: string;
  readonly sponsor: Address;
  readonly slot: number;
  readonly registrationTx: string;
  readonly declaredBudget: bigint;
  readonly admission: WalletProof;
  readonly sponsorProof: WalletProof;
}

export interface IssueInviteRequest {
  readonly round: string;
  readonly sponsor: Address;
  readonly slot: number;
  readonly owner: Address;
  readonly inviteNonce: string;
  readonly inviteExpiresAt: number;
  readonly sponsorProof: WalletProof;
}

export interface IssuedInvite {
  readonly account: Address;
  readonly token: string;
}

export interface PrepareOperationRequest {
  readonly round: string;
  readonly token: string;
  readonly owner: Address;
  readonly operation: UserOperation<"0.7">;
}

export interface PreparedOperation {
  readonly operationKey: Hex;
  readonly validUntil: number;
  readonly operation: UserOperation<"0.7">;
}

function sponsorAdmissionBody(request: RegisterSponsorRequest): object {
  return { sponsor: request.sponsor, slot: request.slot };
}

function sponsorRegistrationBody(request: RegisterSponsorRequest): object {
  return {
    sponsor: request.sponsor,
    slot: request.slot,
    registrationTx: request.registrationTx,
    declaredBudget: request.declaredBudget.toString(),
  };
}

function inviteRequestBody(request: IssueInviteRequest): object {
  return {
    sponsor: request.sponsor,
    slot: request.slot,
    owner: request.owner,
    inviteNonce: request.inviteNonce,
    inviteExpiresAt: request.inviteExpiresAt,
  };
}

function invitePayload(
  request: IssueInviteRequest,
  account: Address,
  action: string,
): InvitePayload {
  return {
    round: request.round,
    sponsor: request.sponsor,
    sponsorSlot: request.slot,
    owner: request.owner,
    account,
    expiresAt: request.inviteExpiresAt,
    nonce: request.inviteNonce,
    action,
  };
}

const DEFAULT_SPONSORED_ACTION_NAME = "counter.increment";

function sponsoredActionName(options: OperatorServiceOptions): string {
  const action = options.sponsoredActionName ?? DEFAULT_SPONSORED_ACTION_NAME;
  if (action.trim().length === 0) throw new Error("Sponsored action name is required");
  return action;
}

export class OperatorService {
  constructor(private readonly options: OperatorServiceOptions) {}

  async registerSponsor(request: RegisterSponsorRequest): Promise<void> {
    this.requireConfiguredRound(request.round);
    const now = this.options.clock();
    await this.verifySponsorProofs(request, now);
    const facts = await this.options.sponsorReader.readSponsorRegistration(
      request.round,
      request.sponsor,
      request.registrationTx,
    );
    this.validateSponsorFacts(request, facts);
    this.persistSponsor(request, facts.confirmedFunding);
  }

  async issueInvite(request: IssueInviteRequest): Promise<IssuedInvite> {
    this.requireConfiguredRound(request.round);
    const now = this.options.clock();
    await this.verifyProof(
      request.round,
      inviteRequestBody(request),
      request.sponsorProof,
      request.sponsor,
      now,
    );
    if (request.inviteExpiresAt < now) {
      throw new Error("Invite expiry is in the past");
    }
    const account = await this.predictInvitedAccount(request);
    const payload = invitePayload(request, account, sponsoredActionName(this.options));
    const token = this.options.inviteCodec.issue(payload);
    this.persistInvite(request, account);
    return { account, token };
  }

  async prepareUserOperation(
    request: PrepareOperationRequest,
  ): Promise<PreparedOperation> {
    this.requireConfiguredRound(request.round);
    const now = this.options.clock();
    const payload = this.options.inviteCodec.open(request.token, {
      round: request.round,
      owner: request.owner,
      account: request.operation.sender,
      action: sponsoredActionName(this.options),
      now,
    });
    const facts = await this.options.operationReader.readOperationFacts(
      request.round,
      request.operation.sender,
      payload.owner,
    );
    this.validateAccountFacts(payload.owner, facts);
    const validUntil = Math.min(
      payload.expiresAt,
      now + this.options.authorizationTtlSeconds,
    );
    return this.authorizeAndReserve(request, facts, validUntil, now);
  }

  async submitUserOperation(
    operationKey: Hex,
    operation: UserOperation<"0.7">,
  ): Promise<SubmissionOutcome> {
    if (this.options.store.reservationState(operationKey) !== "reserved") {
      throw new Error("Operation reservation is not ready for submission");
    }
    assertSubmittedOperationFingerprint(
      this.options.store.readPreparedFingerprint(operationKey),
      operation,
    );
    let outcome: SubmissionOutcome;
    try {
      outcome = await this.options.operationExecutor.simulateAndSubmit(operation);
    } catch (error) {
      this.options.store.markUnknown(operationKey);
      throw new Error("UserOperation submission outcome is unknown", {
        cause: error,
      });
    }
    this.recordSubmissionOutcome(operationKey, outcome);
    return outcome;
  }

  private async verifyProof(
    round: string,
    body: object,
    proof: WalletProof,
    signer: Address,
    now: number,
  ): Promise<void> {
    const fields: SignedRequestFields = {
      origin: this.options.origin,
      chainId: this.options.chainId,
      factory: this.options.factory,
      round,
      bodyHash: hashRequestBody(body),
      nonce: proof.nonce,
      expiresAt: proof.expiresAt,
    };
    await verifyRequestSignature(fields, proof.signature, signer, now);
  }

  private async verifySponsorProofs(
    request: RegisterSponsorRequest,
    now: number,
  ): Promise<void> {
    await Promise.all([
      this.verifyProof(
        request.round,
        sponsorAdmissionBody(request),
        request.admission,
        this.options.creator,
        now,
      ),
      this.verifyProof(
        request.round,
        sponsorRegistrationBody(request),
        request.sponsorProof,
        request.sponsor,
        now,
      ),
    ]);
  }

  private async predictInvitedAccount(
    request: IssueInviteRequest,
  ): Promise<Address> {
    const salt = deriveSimpleAccountSalt(
      this.options.chainId,
      request.round as Hex,
      request.owner,
    );
    return this.options.accountReader.predictSimpleAccount(request.owner, salt);
  }

  private async authorizeAndReserve(
    request: PrepareOperationRequest,
    facts: OperationChainFacts,
    validUntil: number,
    now: number,
  ): Promise<PreparedOperation> {
    const policy = this.operationPolicy(request, facts, validUntil, now);
    const authorization = await this.options.authorizer.authorize(
      request.operation,
      policy,
    );
    const operation = {
      ...request.operation,
      paymasterData: authorization.paymasterData,
    };
    const operationKey = userOperationHash(
      operation,
      this.options.entryPoint,
      this.options.chainId,
    );
    this.reserveOperation(request.round, operationKey, operation, policy);
    return { operationKey, validUntil, operation };
  }

  private reserveOperation(
    round: string,
    operationKey: Hex,
    operation: UserOperation<"0.7">,
    policy: OperationPolicy,
  ): void {
    this.options.store.reserve({
      operationKey,
      round,
      account: operation.sender,
      maximumCost: policy.maximumCost,
      expiresAt: policy.validUntil,
      preparedFingerprint: operationFingerprint(operation),
    });
  }

  private operationPolicy(
    request: PrepareOperationRequest,
    facts: OperationChainFacts,
    validUntil: number,
    now: number,
  ): OperationPolicy {
    return {
      account: request.operation.sender,
      expectedNonce: facts.nonce,
      accountDeployed: facts.deployed,
      accountFactory: facts.accountFactory,
      accountFactoryData: facts.accountFactoryData,
      expectedCallData: facts.expectedCallData,
      paymaster: facts.paymaster,
      maximumCost: requiredPrefund(request.operation),
      validUntil,
      now,
      currentEpochClaim: facts.currentEpochClaim,
      gasCeilings: facts.gasCeilings,
    };
  }

  private validateAccountFacts(
    invitedOwner: Address,
    facts: OperationChainFacts,
  ): void {
    if (!facts.enrolled) throw new Error("Account is not enrolled in the round");
    if (
      facts.deployed &&
      (facts.owner === undefined ||
        facts.owner.toLowerCase() !== invitedOwner.toLowerCase())
    ) {
      throw new Error("Deployed account owner does not match the invite");
    }
  }

  private recordSubmissionOutcome(
    operationKey: Hex,
    outcome: SubmissionOutcome,
  ): void {
    if (outcome.status === "confirmed") {
      this.options.store.confirmClaim(operationKey, outcome.actualClaim);
    } else if (outcome.status === "known-failure") {
      this.options.store.releaseKnownFailure(operationKey);
    } else {
      this.options.store.markUnknown(operationKey);
    }
  }

  private nonce(
    scope: string,
    request: RegisterSponsorRequest,
    proof: WalletProof,
  ): RequestNonce {
    return {
      scope,
      round: request.round,
      signer: scope === "creator-admission" ? this.options.creator : request.sponsor,
      nonce: proof.nonce,
      expiresAt: proof.expiresAt,
    };
  }

  private persistSponsor(
    request: RegisterSponsorRequest,
    confirmedFunding: bigint,
  ): void {
    this.options.store.registerSponsorAuthorized(
      {
        round: request.round,
        sponsor: request.sponsor,
        slot: request.slot,
        registrationTx: request.registrationTx,
        declaredBudget: request.declaredBudget,
        confirmedFunding,
      },
      [
        this.nonce("creator-admission", request, request.admission),
        this.nonce("sponsor-registration", request, request.sponsorProof),
      ],
    );
  }

  private persistInvite(request: IssueInviteRequest, account: Address): void {
    this.options.store.registerInviteAuthorized(
      {
        round: request.round,
        sponsor: request.sponsor,
        slot: request.slot,
        owner: request.owner,
        account,
        inviteNonce: request.inviteNonce,
        expiresAt: request.inviteExpiresAt,
        action: sponsoredActionName(this.options),
      },
      {
        scope: "sponsor-invite",
        round: request.round,
        signer: request.sponsor,
        nonce: request.sponsorProof.nonce,
        expiresAt: request.sponsorProof.expiresAt,
      },
    );
  }

  private validateSponsorFacts(
    request: RegisterSponsorRequest,
    facts: SponsorChainFacts,
  ): void {
    if (request.declaredBudget <= 0n) {
      throw new Error("Declared budget must be positive");
    }
    if (!facts.registered) throw new Error("Sponsor is not registered on-chain");
    if (facts.slot !== request.slot) {
      throw new Error("Sponsor slot does not match the registration event");
    }
    if (request.declaredBudget > facts.confirmedFunding) {
      throw new Error("Declared budget exceeds confirmed public funding");
    }
  }

  private requireConfiguredRound(round: string): void {
    if (round.toLowerCase() !== this.options.round.toLowerCase()) {
      throw new Error("Request round does not match the service context");
    }
  }
}

export function deriveSimpleAccountSalt(
  chainId: number,
  round: Hex,
  owner: Address,
): bigint {
  const encoded = encodeAbiParameters(
    [
      { type: "string" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "address" },
    ],
    ["CHIT_ACCOUNT_V1", BigInt(chainId), round, owner],
  );
  return hexToBigInt(keccak256(encoded));
}

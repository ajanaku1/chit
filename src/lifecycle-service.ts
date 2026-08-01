import { type Address, type Hex } from "viem";
import {
  type EnrollAccountRequest,
  type RecoverOperatorGasRequest,
  type SettleRoundRequest,
} from "./http-service.js";
import { UnknownTransactionOutcomeError } from "./live-adapters.js";
import {
  type BegunLifecycleAction,
  type PolicyStore,
  type RequestNonce,
} from "./policy-store.js";
import {
  type LifecycleActionRecord,
  type LifecycleReconciliation,
  type LifecycleResult,
} from "./lifecycle-types.js";
import {
  hashRequestBody,
  type InviteCodec,
  type SignedRequestFields,
  verifyRequestSignature,
} from "./service-crypto.js";

export {
  type LifecycleActionRecord,
  type LifecycleReconciliation,
  type LifecycleResult,
} from "./lifecycle-types.js";

interface EnrollmentExecutor {
  enroll(input: {
    readonly account: Address;
    readonly sponsorSlot: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly transactionHash: Hex }>;
}

interface SettlementExecutor {
  nextSettlementEpoch(signal: AbortSignal): Promise<bigint>;
  settle(input: { readonly round: string; readonly signal: AbortSignal }): Promise<{
    readonly epoch: bigint;
    readonly settlementTransactionHash: Hex;
    readonly closeTransactionHash?: Hex;
  }>;
}

interface RecoveryExecutor {
  recover(input: { readonly signal: AbortSignal }): Promise<{
    readonly transactionHash: Hex;
    readonly recoveredValue: bigint;
    readonly retainedGas: bigint;
  }>;
}

interface LifecycleReconciler {
  reconcile(
    record: LifecycleActionRecord,
    signal: AbortSignal,
  ): Promise<LifecycleReconciliation>;
}

interface RoundLifecycleOptions {
  readonly origin: string;
  readonly chainId: number;
  readonly factory: Address;
  readonly creator: Address;
  readonly round: string;
  readonly clock: () => number;
  readonly store: PolicyStore;
  readonly inviteCodec: InviteCodec;
  readonly enrollment: EnrollmentExecutor;
  readonly settlement: SettlementExecutor;
  readonly recovery: RecoveryExecutor;
  readonly reconciler: LifecycleReconciler;
}

interface ReconciliationSummary {
  readonly confirmed: number;
  readonly retrySafe: number;
  readonly unresolved: number;
}

function enrollmentBody(request: EnrollAccountRequest): object {
  return {
    action: "enroll-account",
    token: request.token,
    owner: request.owner,
    account: request.account,
  };
}

function settlementBody(): object {
  return { action: "settle-round" };
}

function recoveryBody(request: RecoverOperatorGasRequest): object {
  return {
    action: "recover-operator-gas",
    closedBlockHash: request.closedBlockHash,
  };
}

function actionKey(kind: string, round: string, identity: string): string {
  return `${kind}:${round.toLowerCase()}:${identity.toLowerCase()}`;
}

function settlementEpoch(record: LifecycleActionRecord): bigint {
  const value = record.actionKey.split(":").at(-1);
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Settlement action has an invalid epoch identity");
  }
  return BigInt(value);
}

export class RoundLifecycleService {
  constructor(private readonly options: RoundLifecycleOptions) {}

  async enrollAccount(
    request: EnrollAccountRequest,
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    this.requireRound(request.round);
    const body = enrollmentBody(request);
    await this.verifyProof(body, request.ownerProof, request.owner);
    const invite = this.options.inviteCodec.open(request.token, {
      round: request.round,
      owner: request.owner,
      account: request.account,
      action: "counter.increment",
      now: this.options.clock(),
    });
    const begun = await this.beginAction(
      "enrollment",
      body,
      "owner-enrollment",
      request.owner,
      request.ownerProof,
      () => actionKey("enrollment", request.round, request.account),
    );
    return this.runAction(begun, signal, () =>
      this.executeEnrollment(request, invite.sponsorSlot, signal),
    );
  }

  async settleRound(
    request: SettleRoundRequest,
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    this.requireRound(request.round);
    const body = settlementBody();
    await this.verifyProof(body, request.creatorProof, this.options.creator);
    const begun = await this.beginAction(
      "settlement",
      body,
      "creator-settlement",
      this.options.creator,
      request.creatorProof,
      async () => actionKey(
        "settlement",
        request.round,
        (await this.options.settlement.nextSettlementEpoch(signal)).toString(),
      ),
    );
    return this.runAction(begun, signal, () =>
      this.executeSettlement(request, begun.record, signal),
    );
  }

  async recoverOperatorGas(
    request: RecoverOperatorGasRequest,
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    this.requireRound(request.round);
    const body = recoveryBody(request);
    await this.verifyProof(body, request.creatorProof, this.options.creator);
    const begun = await this.beginAction(
      "operator-gas-recovery",
      body,
      "creator-gas-recovery",
      this.options.creator,
      request.creatorProof,
      () => actionKey("recovery", request.round, request.closedBlockHash),
    );
    return this.runAction(begun, signal, () =>
      this.executeRecovery(request.round, signal),
    );
  }

  async reconcilePending(signal: AbortSignal): Promise<ReconciliationSummary> {
    const summary = { confirmed: 0, retrySafe: 0, unresolved: 0 };
    const records = this.options.store.unresolvedLifecycleActions(
      this.options.round,
    );
    for (const record of records) {
      const status = await this.reconcileRecord(record, signal);
      summary[status] += 1;
    }
    return summary;
  }

  private async executeEnrollment(
    request: EnrollAccountRequest,
    sponsorSlot: number,
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    const result = await this.options.enrollment.enroll({
      account: request.account,
      sponsorSlot,
      signal,
    });
    return { kind: "enrollment", transactionHash: result.transactionHash };
  }

  private async executeSettlement(
    request: SettleRoundRequest,
    record: LifecycleActionRecord,
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    const result = await this.options.settlement.settle({
      round: request.round,
      signal,
    });
    if (result.epoch !== settlementEpoch(record)) {
      throw new Error("Settlement epoch does not match its durable identity");
    }
    return {
      kind: "settlement",
      epoch: result.epoch.toString(),
      settlementTransactionHash: result.settlementTransactionHash,
      ...(result.closeTransactionHash === undefined
        ? {}
        : { closeTransactionHash: result.closeTransactionHash }),
    };
  }

  private async executeRecovery(
    round: string,
    signal: AbortSignal,
  ): Promise<LifecycleResult> {
    if (!this.options.store.isSettlementReady(round)) {
      throw new Error("Round has unresolved operation reservations");
    }
    const result = await this.options.recovery.recover({ signal });
    return {
      kind: "operator-gas-recovery",
      transactionHash: result.transactionHash,
      recoveredValue: result.recoveredValue.toString(),
      retainedGas: result.retainedGas.toString(),
    };
  }

  private async beginAction(
    kind: LifecycleResult["kind"],
    body: object,
    scope: string,
    signer: Address,
    proof: EnrollAccountRequest["ownerProof"],
    key: () => string | Promise<string>,
  ): Promise<BegunLifecycleAction> {
    const authorization = this.authorization(scope, signer, proof);
    const requestHash = hashRequestBody(body);
    const existing = this.options.store.findLifecycleActionByNonce(authorization);
    if (existing !== undefined) {
      this.requireExisting(existing, kind, requestHash);
      return { created: false, record: existing };
    }
    return this.options.store.beginLifecycleAction({
      actionKey: await key(),
      kind,
      round: this.options.round,
      requestHash,
      authorization,
    });
  }

  private async runAction(
    begun: BegunLifecycleAction,
    signal: AbortSignal,
    execute: () => Promise<LifecycleResult>,
  ): Promise<LifecycleResult> {
    if (begun.created) return this.executeAction(begun.record, execute);
    if (begun.record.state === "confirmed") {
      if (begun.record.result === undefined) {
        throw new Error("Confirmed action has no result");
      }
      return begun.record.result;
    }
    if (begun.record.state === "failed") {
      this.options.store.markLifecyclePending(begun.record.actionKey);
      return this.executeAction(begun.record, execute);
    }
    return this.reconcileAction(begun.record, signal, execute);
  }

  private async reconcileAction(
    record: LifecycleActionRecord,
    signal: AbortSignal,
    execute: () => Promise<LifecycleResult>,
  ): Promise<LifecycleResult> {
    const reconciliation = await this.options.reconciler.reconcile(record, signal);
    if (reconciliation.status === "confirmed") {
      this.requireResultKind(record, reconciliation.result);
      this.options.store.confirmLifecycleAction(record.actionKey, reconciliation.result);
      return reconciliation.result;
    }
    if (reconciliation.status === "unresolved") {
      throw new Error("Lifecycle transaction outcome remains unknown");
    }
    this.options.store.markLifecyclePending(record.actionKey);
    return this.executeAction(record, execute);
  }

  private async reconcileRecord(
    record: LifecycleActionRecord,
    signal: AbortSignal,
  ): Promise<keyof ReconciliationSummary> {
    const reconciliation = await this.options.reconciler.reconcile(record, signal);
    if (reconciliation.status === "confirmed") {
      this.requireResultKind(record, reconciliation.result);
      this.options.store.confirmLifecycleAction(record.actionKey, reconciliation.result);
      return "confirmed";
    }
    if (reconciliation.status === "retry-safe") {
      this.options.store.markLifecycleFailed(record.actionKey);
      return "retrySafe";
    }
    return "unresolved";
  }

  private async executeAction(
    record: LifecycleActionRecord,
    execute: () => Promise<LifecycleResult>,
  ): Promise<LifecycleResult> {
    let result: LifecycleResult;
    try {
      result = await execute();
    } catch (error) {
      if (error instanceof UnknownTransactionOutcomeError) {
        this.options.store.markLifecycleUnknown(
          record.actionKey,
          error.transactionHash,
        );
      } else {
        this.options.store.markLifecycleFailed(record.actionKey);
      }
      throw error;
    }
    this.options.store.confirmLifecycleAction(record.actionKey, result);
    return result;
  }

  private authorization(
    scope: string,
    signer: Address,
    proof: EnrollAccountRequest["ownerProof"],
  ): RequestNonce {
    return {
      scope,
      round: this.options.round,
      signer,
      nonce: proof.nonce,
      expiresAt: proof.expiresAt,
    };
  }

  private requireExisting(
    record: LifecycleActionRecord,
    kind: LifecycleResult["kind"],
    requestHash: Hex,
  ): void {
    if (
      record.kind !== kind ||
      record.round !== this.options.round.toLowerCase() ||
      record.requestHash !== requestHash.toLowerCase()
    ) {
      throw new Error("Lifecycle authorization belongs to another request");
    }
  }

  private requireResultKind(
    record: LifecycleActionRecord,
    result: LifecycleResult,
  ): void {
    if (record.kind !== result.kind) {
      throw new Error("Reconciled result does not match the lifecycle action");
    }
  }

  private async verifyProof(
    body: object,
    proof: EnrollAccountRequest["ownerProof"],
    signer: Address,
  ): Promise<void> {
    const fields: SignedRequestFields = {
      origin: this.options.origin,
      chainId: this.options.chainId,
      factory: this.options.factory,
      round: this.options.round,
      bodyHash: hashRequestBody(body),
      nonce: proof.nonce,
      expiresAt: proof.expiresAt,
    };
    await verifyRequestSignature(
      fields,
      proof.signature,
      signer,
      this.options.clock(),
    );
  }

  private requireRound(round: string): void {
    if (round.toLowerCase() !== this.options.round.toLowerCase()) {
      throw new Error("Request round does not match the lifecycle context");
    }
  }
}

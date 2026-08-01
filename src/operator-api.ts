import { type Address, type Hex } from "viem";
import { type UserOperation } from "viem/account-abstraction";
import {
  type EnrollAccountRequest,
  type OperatorApiRequest,
  type OperatorHttpApi,
  type OperatorRequestContext,
  type RecoverOperatorGasRequest,
  type SettleRoundRequest,
} from "./http-service.js";
import { type LifecycleResult } from "./lifecycle-types.js";
import {
  type IssueInviteRequest,
  type IssuedInvite,
  type PreparedOperation,
  type PrepareOperationRequest,
  type RegisterSponsorRequest,
  type SubmissionOutcome,
} from "./operator-service.js";

interface RoundOperatorCommands {
  registerSponsor(request: RegisterSponsorRequest): Promise<void>;
  issueInvite(request: IssueInviteRequest): Promise<IssuedInvite>;
  prepareUserOperation(request: PrepareOperationRequest): Promise<PreparedOperation>;
  submitUserOperation(
    operationKey: Hex,
    operation: UserOperation<"0.7">,
  ): Promise<SubmissionOutcome>;
}

interface RoundLifecycleCommands {
  enrollAccount(
    request: EnrollAccountRequest,
    signal: AbortSignal,
  ): Promise<LifecycleResult>;
  settleRound(
    request: SettleRoundRequest,
    signal: AbortSignal,
  ): Promise<LifecycleResult>;
  recoverOperatorGas(
    request: RecoverOperatorGasRequest,
    signal: AbortSignal,
  ): Promise<LifecycleResult>;
}

export interface RoundApiContext {
  readonly round: string;
  readonly operator: RoundOperatorCommands;
  readonly lifecycle: RoundLifecycleCommands;
  readPublicRound(signal: AbortSignal): Promise<object>;
}

interface RoundApiRegistry {
  get(round: string, signal: AbortSignal): Promise<RoundApiContext | undefined>;
}

interface OperatorAddressDeriver {
  derive(creator: Address, roundSalt: Hex): Address;
}

interface ServiceHealthReader {
  read(signal: AbortSignal): Promise<object>;
}

interface OperatorApiOptions {
  readonly rounds: RoundApiRegistry;
  readonly deriver: OperatorAddressDeriver;
  readonly health: ServiceHealthReader;
}

type RoundRequest = Exclude<
  OperatorApiRequest,
  { readonly kind: "health" } | { readonly kind: "derive-operator" }
>;

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Request was aborted");
}

export class OperatorApiRouter implements OperatorHttpApi {
  constructor(private readonly options: OperatorApiOptions) {}

  async execute(
    request: OperatorApiRequest,
    context: OperatorRequestContext,
  ): Promise<object> {
    requireActive(context.signal);
    if (request.kind === "health") {
      return this.options.health.read(context.signal);
    }
    if (request.kind === "derive-operator") {
      return {
        operator: this.options.deriver.derive(
          request.body.creator,
          request.body.roundSalt,
        ),
      };
    }
    const round = await this.roundContext(request.round, context.signal);
    return this.executeRound(round, request, context.signal);
  }

  private async roundContext(
    round: string,
    signal: AbortSignal,
  ): Promise<RoundApiContext> {
    const context = await this.options.rounds.get(round, signal);
    if (context === undefined) throw new Error("Round was not found");
    if (context.round.toLowerCase() !== round.toLowerCase()) {
      throw new Error("Round registry returned a context pinned to another round");
    }
    return context;
  }

  private async executeRound(
    context: RoundApiContext,
    request: RoundRequest,
    signal: AbortSignal,
  ): Promise<object> {
    switch (request.kind) {
      case "get-round":
        return context.readPublicRound(signal);
      case "register-sponsor":
        await context.operator.registerSponsor(request.body);
        return { registered: true };
      case "issue-invite":
        return context.operator.issueInvite(request.body);
      case "prepare-operation":
        return context.operator.prepareUserOperation(request.body);
      case "submit-operation":
        return context.operator.submitUserOperation(
          request.body.operationKey,
          request.body.operation,
        );
      case "enroll-account":
        return context.lifecycle.enrollAccount(request.body, signal);
      case "settle-round":
        return context.lifecycle.settleRound(request.body, signal);
      case "recover-operator-gas":
        return context.lifecycle.recoverOperatorGas(request.body, signal);
    }
  }
}

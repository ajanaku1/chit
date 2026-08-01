import { type Hex } from "viem";

export type LifecycleResult =
  | { readonly kind: "enrollment"; readonly transactionHash: Hex }
  | {
      readonly kind: "settlement";
      readonly epoch: string;
      readonly settlementTransactionHash: Hex;
      readonly closeTransactionHash?: Hex;
    }
  | {
      readonly kind: "operator-gas-recovery";
      readonly transactionHash: Hex;
      readonly recoveredValue: string;
      readonly retainedGas: string;
    };

export type LifecycleActionState =
  | "pending"
  | "unknown"
  | "failed"
  | "confirmed";

export interface LifecycleActionRecord {
  readonly actionKey: string;
  readonly kind: LifecycleResult["kind"];
  readonly round: string;
  readonly state: LifecycleActionState;
  readonly requestHash: Hex;
  readonly requestScope: string;
  readonly signer: string;
  readonly nonce: string;
  readonly transactionHash?: Hex;
  readonly result?: LifecycleResult;
}

export type LifecycleReconciliation =
  | { readonly status: "confirmed"; readonly result: LifecycleResult }
  | { readonly status: "retry-safe" }
  | { readonly status: "unresolved" };

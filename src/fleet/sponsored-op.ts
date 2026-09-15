/**
 * A sponsored operation from a smart account that holds no ETH.
 *
 * This is the builder behind the gas-sponsorship spike
 * (proposals/gas-sponsorship-2026-09-15): the fork test and the live script
 * both go through it, so what the test proves is what the script runs. No
 * route uses it. The pieces are all existing ones: the canonical ERC-4337
 * SimpleAccount factory that is live on 46630, `FleetPaymaster` for the
 * operator-signed sponsorship, `FleetCampaignEscrow` for the budget, and the
 * operator as the bundler through `EntryPoint.handleOps`.
 *
 * The sender's first operation carries its own `initCode`, so the account is
 * deployed, sponsored, and used in one transaction, and it never needs to be
 * funded at any point: the EntryPoint asks the account for no prefund when a
 * paymaster is set. The operator's sponsorship signature binds the sender
 * address, and the EntryPoint refuses an `initCode` that does not produce
 * that sender ("AA14"), so the deployment is bound through the address.
 */

import { concatHex, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import {
  DEFAULT_PAYMASTER_POSTOP_GAS,
  DEFAULT_PAYMASTER_VERIFICATION_GAS,
  buildFleetPaymasterData,
  type DigestSigner,
} from "./paymaster-data.js";
import { ENTRYPOINT_V07, buildPackedUserOp, encodeExecuteCall } from "./user-operation.js";

/**
 * Canonical SimpleAccountFactory for EntryPoint v0.7 (eth-infinitism
 * account-abstraction v0.7.0). Answered `eth_getCode` with 2,288 bytes on
 * 46630 on 2026-09-15; the spike asserts its implementation's `entryPoint()`
 * before trusting it.
 */
export const SIMPLE_ACCOUNT_FACTORY_V07: Address = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985";

export const SIMPLE_ACCOUNT_FACTORY_ABI = parseAbi([
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function accountImplementation() view returns (address)",
]);

export const SIMPLE_ACCOUNT_ABI = parseAbi([
  "function entryPoint() view returns (address)",
  "function owner() view returns (address)",
]);

/** The op as `EntryPoint.handleOps` and `getUserOpHash` take it. */
export type EntryPointUserOp = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type SponsoredGasPlan = {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGas: bigint;
  paymasterPostOpGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/**
 * Room for one sponsored call whose first op also deploys the account. The
 * limits are ceilings: the budget is charged what the op used, never these.
 * The fee is a multiple of the base fee with no priority, so the op pays the
 * base fee and the ceiling is what the operator signs for.
 */
export const spikeGasPlan = (baseFeePerGas: bigint): SponsoredGasPlan => ({
  verificationGasLimit: 600_000n,
  callGasLimit: 150_000n,
  preVerificationGas: 60_000n,
  paymasterVerificationGas: DEFAULT_PAYMASTER_VERIFICATION_GAS,
  paymasterPostOpGas: DEFAULT_PAYMASTER_POSTOP_GAS,
  maxFeePerGas: baseFeePerGas * 4n,
  maxPriorityFeePerGas: 0n,
});

/**
 * The EntryPoint's own prefund (v0.7 `_getRequiredPrefund`): every gas limit
 * on the op times the max fee. The paymaster receives it as `maxCost`, the
 * escrow reserves it, and the operator's signature binds it, so it has to be
 * computed here exactly as the contract does.
 */
export const requiredPrefund = (plan: SponsoredGasPlan): bigint =>
  (plan.verificationGasLimit +
    plan.callGasLimit +
    plan.paymasterVerificationGas +
    plan.paymasterPostOpGas +
    plan.preVerificationGas) *
  plan.maxFeePerGas;

/** The `initCode` that deploys a SimpleAccount for `owner` at the factory's counterfactual address. */
export const simpleAccountInitCode = (owner: Address, salt: bigint, factory: Address = SIMPLE_ACCOUNT_FACTORY_V07): Hex =>
  concatHex([
    factory,
    encodeFunctionData({ abi: SIMPLE_ACCOUNT_FACTORY_ABI, functionName: "createAccount", args: [owner, salt] }),
  ]);

export type SponsoredOpInput = {
  /** The counterfactual (or already deployed) SimpleAccount. */
  sender: Address;
  /** `0x` once the account exists; the factory call on its first op. */
  initCode: Hex;
  /** `EntryPoint.getNonce(sender, 0)`. */
  nonce: bigint;
  /** What the account calls, with no value. */
  target: Address;
  data: Hex;
  plan: SponsoredGasPlan;
  paymaster: Address;
  /** The sponsor's budget in the escrow (a campaign id on chain). */
  sponsor: Hex;
  /** The escrow reservation key for this one op; unique per op. */
  key: Hex;
  chainId: number;
  /** Unix seconds; the sponsorship signature is worthless after it. */
  validUntil: number;
  /** The operator's EIP-191 signer over the sponsorship digest. */
  signSponsorship: DigestSigner;
};

/**
 * Builds the op with the operator's sponsorship in `paymasterAndData` and an
 * empty account signature. The caller then hashes it through the EntryPoint,
 * has the account's owner sign that hash, and submits it.
 */
export const buildSponsoredOp = async (
  input: SponsoredOpInput,
): Promise<{ op: EntryPointUserOp; maxCost: bigint }> => {
  const { plan } = input;
  const callData = encodeExecuteCall(input.target, "0", input.data);
  const packed = buildPackedUserOp({
    sender: input.sender,
    nonce: input.nonce.toString(),
    callData,
    callGasLimit: plan.callGasLimit.toString(),
    verificationGasLimit: plan.verificationGasLimit.toString(),
    preVerificationGas: plan.preVerificationGas.toString(),
    maxFeePerGas: plan.maxFeePerGas.toString(),
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(),
    paymasterAndData: "0x",
  });
  const maxCost = requiredPrefund(plan);
  const paymasterAndData = await buildFleetPaymasterData(
    {
      paymaster: input.paymaster,
      campaign: input.sponsor,
      key: input.key,
      maxCost,
      chainId: input.chainId,
      validUntil: input.validUntil,
      verificationGas: plan.paymasterVerificationGas,
      postOpGas: plan.paymasterPostOpGas,
      operation: {
        sender: input.sender,
        nonce: input.nonce,
        callData,
        accountGasLimits: packed.accountGasLimits,
        preVerificationGas: plan.preVerificationGas,
        gasFees: packed.gasFees,
      },
    },
    input.signSponsorship,
  );
  return {
    maxCost,
    op: {
      sender: input.sender,
      nonce: input.nonce,
      initCode: input.initCode,
      callData,
      accountGasLimits: packed.accountGasLimits,
      preVerificationGas: plan.preVerificationGas,
      gasFees: packed.gasFees,
      paymasterAndData,
      signature: "0x",
    },
  };
};

export { ENTRYPOINT_V07 };

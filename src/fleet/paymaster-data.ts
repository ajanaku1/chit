/**
 * Fleet paymaster sponsorship data.
 *
 * Builds the `paymasterAndData` field the deployed FleetPaymaster accepts in
 * `validatePaymasterUserOp`. The operator authorizes each sponsored op by
 * signing a digest over the userOpHash plus the campaign, reservation key, and
 * cost bound; the paymaster verifies that signature on chain and settles the
 * cost against the escrow. This module is the service-side counterpart to
 * `contracts/fleet/FleetPaymaster.sol` — the byte layout and digest here must
 * match `_verify` there exactly, which the fork test asserts against the real
 * contract.
 */

import { concatHex, encodeAbiParameters, keccak256, numberToHex, type Address, type Hex } from "viem";

/** Default paymaster verification and postOp gas limits packed into the header. */
export const DEFAULT_PAYMASTER_VERIFICATION_GAS = 200_000n;
export const DEFAULT_PAYMASTER_POSTOP_GAS = 100_000n;

/** The operation fields the operator's signature is bound to (no signatures, no userOpHash). */
export type SponsoredOperation = {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
};

export type SponsorshipInput = {
  paymaster: Address;
  campaign: Hex;
  /** The escrow reservation key this op settles against. */
  key: Hex;
  /** The maximum cost the paymaster reserves (EntryPoint's maxCost for the op). */
  maxCost: bigint;
  /** The operation being sponsored. Its fields are what the operator signs. */
  operation: SponsoredOperation;
  chainId: number;
  /** 0 means no expiry (ERC-4337 convention). */
  validUntil?: number;
  validAfter?: number;
  verificationGas?: bigint;
  postOpGas?: bigint;
};

/**
 * The exact digest the operator signs. Mirrors `FleetPaymaster._verify`:
 * keccak256(abi.encode(sender, nonce, keccak256(callData), accountGasLimits,
 * preVerificationGas, gasFees, chainId, paymaster, campaign, key, maxCost,
 * validUntil, validAfter)). Binding the operation's own fields (not the
 * EntryPoint userOpHash, which would be circular) pins the exact op. The
 * operator applies the EIP-191 prefix over this digest, which the contract
 * undoes via `toEthSignedMessageHash`.
 */
export const sponsorshipDigest = (input: SponsorshipInput): Hex => {
  const op = input.operation;
  // Two-step hash, matching FleetPaymaster._verify.
  const opHash = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [op.sender, op.nonce, keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint48" },
        { type: "uint48" },
      ],
      [
        opHash,
        BigInt(input.chainId),
        input.paymaster,
        input.campaign,
        input.key,
        input.maxCost,
        input.validUntil ?? 0,
        input.validAfter ?? 0,
      ],
    ),
  );
};

/** EIP-191 signer over the raw 32-byte digest (the operator's `personal_sign`). */
export type DigestSigner = (digest: Hex) => Promise<Hex>;

/**
 * Builds the full `paymasterAndData`:
 *   paymaster(20) | verificationGas(16) | postOpGas(16) | campaign(32) |
 *   key(32) | validUntil(6) | validAfter(6) | signature(65)
 */
export const buildFleetPaymasterData = async (
  input: SponsorshipInput,
  signDigest: DigestSigner,
): Promise<Hex> => {
  const signature = await signDigest(sponsorshipDigest(input));
  return concatHex([
    input.paymaster,
    numberToHex(input.verificationGas ?? DEFAULT_PAYMASTER_VERIFICATION_GAS, { size: 16 }),
    numberToHex(input.postOpGas ?? DEFAULT_PAYMASTER_POSTOP_GAS, { size: 16 }),
    input.campaign,
    input.key,
    numberToHex(input.validUntil ?? 0, { size: 6 }),
    numberToHex(input.validAfter ?? 0, { size: 6 }),
    signature,
  ]);
};

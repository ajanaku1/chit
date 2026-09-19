/**
 * Gas sponsorship for dapps: the service.
 *
 * A dapp registers as a sponsor, sets a policy, funds a budget in the escrow
 * from its own wallet, and from then on its users transact from smart
 * accounts that hold no ETH. For each operation the dapp asks this service
 * for sponsorship; the service runs every check the policy implies (nothing
 * is signed if any fails), signs the sponsorship with the operator key, and
 * hands back `paymasterAndData`. The dapp has the user sign the op and sends
 * it back; the service bundles it through the EntryPoint, reads what the
 * escrow was charged, and writes it down for the sponsor's dashboard.
 *
 * Chit holds no user money. The budget is the sponsor's, in the escrow, and
 * `close` on the escrow returns what was not spent to the sponsor's wallet.
 * The one thing this service keeps is the ledger of what it signed, so the
 * daily caps hold across instances (FR-005) and the dashboard can show where
 * the budget went (FR-008) without ever naming a user.
 *
 * Proposal: proposals/gas-sponsorship-2026-09-15/spec.md.
 */

import { encodePacked, keccak256, recoverMessageAddress, type Hex } from "viem";

import { ServiceError } from "./campaign-service.js";
import { DEFAULT_PAYMASTER_POSTOP_GAS, DEFAULT_PAYMASTER_VERIFICATION_GAS, buildFleetPaymasterData, sponsorshipDigest } from "./paymaster-data.js";
import type { SponsorChain } from "./sponsor-chain.js";
import {
  chargedWithFee,
  checkSponsorship,
  decodeSponsoredCall,
  parseSponsorPolicy,
  utcDay,
  type Refusal,
  type SponsorPolicy,
} from "./sponsor-policy.js";
import { foldSpend, type SponsorRecord, type SponsorStore, type SponsoredOpRecord } from "./sponsor-store.js";
import { requiredPrefund, type EntryPointUserOp, type SponsoredGasPlan } from "./sponsored-op.js";
import { buildPackedUserOp } from "./user-operation.js";
import { FleetValidationError, isAddress, isHex32, isUint, normalizeAddress, type Address, type Uint } from "./types.js";

/** The sponsorship signature is worthless after this (FR-004: at most ten minutes). */
export const SPONSORSHIP_VALIDITY_SECONDS = 600;

export type SponsorOpInput = {
  sender: Address;
  nonce: Uint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: Uint;
  verificationGasLimit: Uint;
  preVerificationGas: Uint;
  maxFeePerGas: Uint;
  maxPriorityFeePerGas: Uint;
};

export type Sponsorship = {
  paymasterAndData: Hex;
  paymaster: Address;
  entryPoint: Address;
  key: Hex;
  /** The EntryPoint prefund the operator signed for, in wei. */
  maxCost: Uint;
  /** The most the budget can be charged: prefund plus fee, in wei. */
  maxCharged: Uint;
  validUntil: number;
  feeBps: number;
};

export type Registration = { sponsor: Hex; escrow: Address; registerTx: Hex; policy: SponsorPolicy };

export type SponsorStatus = {
  sponsor: Hex;
  owner: Address;
  paused: boolean;
  closed: boolean;
  policy: SponsorPolicy;
  budget: { funded: Uint; reserved: Uint; spent: Uint; unused: Uint };
  feeBps: number;
  paymaster: Address;
  escrow: Address;
  /** The operator's float in the EntryPoint; sponsorship stops when it cannot front an op. */
  paymasterDeposit: Uint;
  spend: ReturnType<typeof foldSpend>;
  ops: Array<Omit<SponsoredOpRecord, "sender">>;
  /** Reservation keys signed but never landed and past their window; what a close should roll back. */
  staleKeys: Hex[];
};

const HEX = /^0x([0-9a-fA-F]{2})*$/;
const isHexBytes = (v: unknown): v is Hex => typeof v === "string" && HEX.test(v);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const parseSponsorOp = (value: unknown): SponsorOpInput => {
  const r = asRecord(value);
  if (!isAddress(r["sender"])) throw new FleetValidationError("invalid_sender");
  if (!isUint(r["nonce"])) throw new FleetValidationError("invalid_nonce");
  const initCode = r["initCode"] ?? "0x";
  if (!isHexBytes(initCode)) throw new FleetValidationError("invalid_init_code");
  if (!isHexBytes(r["callData"]) || r["callData"].length < 10) throw new FleetValidationError("invalid_call_data");
  const gas = (key: string): Uint => {
    const v = r[key];
    if (!isUint(v) || BigInt(v) === 0n || BigInt(v) > 2n ** 120n) throw new FleetValidationError(`invalid_${key}`);
    return v;
  };
  return {
    sender: normalizeAddress(r["sender"]),
    nonce: r["nonce"],
    initCode,
    callData: r["callData"],
    callGasLimit: gas("callGasLimit"),
    verificationGasLimit: gas("verificationGasLimit"),
    preVerificationGas: gas("preVerificationGas"),
    maxFeePerGas: gas("maxFeePerGas"),
    maxPriorityFeePerGas: isUint(r["maxPriorityFeePerGas"]) ? r["maxPriorityFeePerGas"] : "0",
  };
};

/** A packed op as a dapp sends it back, signed. */
export const parsePackedOp = (value: unknown): EntryPointUserOp => {
  const r = asRecord(value);
  if (!isAddress(r["sender"])) throw new FleetValidationError("invalid_sender");
  if (!isUint(r["nonce"])) throw new FleetValidationError("invalid_nonce");
  for (const key of ["initCode", "callData", "paymasterAndData", "signature"]) {
    if (!isHexBytes(r[key])) throw new FleetValidationError(`invalid_${key}`);
  }
  if (!isHex32(r["accountGasLimits"]) || !isHex32(r["gasFees"])) throw new FleetValidationError("invalid_gas_words");
  if (!isUint(r["preVerificationGas"])) throw new FleetValidationError("invalid_preVerificationGas");
  return {
    sender: normalizeAddress(r["sender"]),
    nonce: BigInt(r["nonce"]),
    initCode: r["initCode"] as Hex,
    callData: r["callData"] as Hex,
    accountGasLimits: r["accountGasLimits"] as Hex,
    preVerificationGas: BigInt(r["preVerificationGas"]),
    gasFees: r["gasFees"] as Hex,
    paymasterAndData: r["paymasterAndData"] as Hex,
    signature: r["signature"] as Hex,
  };
};

/** keccak256(sender ++ sponsor): the same user under two sponsors is two hashes. */
export const userHashOf = (sender: Address, sponsor: Hex): Hex => keccak256(encodePacked(["address", "bytes32"], [sender, sponsor]));

/** The escrow reservation key for one op; unique because the account's nonce is. */
export const reservationKey = (sponsor: Hex, sender: Address, nonce: bigint): Hex =>
  keccak256(encodePacked(["bytes32", "address", "uint256"], [sponsor, sender, nonce]));

/** The gas words as the EntryPoint packs them; what the digest is taken over. */
const packedWords = (op: SponsorOpInput) =>
  buildPackedUserOp({
    sender: op.sender, nonce: op.nonce, callData: op.callData,
    callGasLimit: op.callGasLimit, verificationGasLimit: op.verificationGasLimit, preVerificationGas: op.preVerificationGas,
    maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas, paymasterAndData: "0x",
  });

const planOf = (op: SponsorOpInput): SponsoredGasPlan => ({
  verificationGasLimit: BigInt(op.verificationGasLimit),
  callGasLimit: BigInt(op.callGasLimit),
  preVerificationGas: BigInt(op.preVerificationGas),
  paymasterVerificationGas: DEFAULT_PAYMASTER_VERIFICATION_GAS,
  paymasterPostOpGas: DEFAULT_PAYMASTER_POSTOP_GAS,
  maxFeePerGas: BigInt(op.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
});

/** The fields FleetPaymaster reads back out of paymasterAndData. */
export const decodePaymasterAndData = (data: Hex): { paymaster: Address; campaign: Hex; key: Hex; validUntil: number; validAfter: number; signature: Hex } | null => {
  // paymaster(20) | verGas(16) | postGas(16) | campaign(32) | key(32) | validUntil(6) | validAfter(6) | signature(65)
  const bytes = data.slice(2);
  if (bytes.length !== (20 + 16 + 16 + 32 + 32 + 6 + 6 + 65) * 2) return null;
  const at = (from: number, len: number) => `0x${bytes.slice(from * 2, (from + len) * 2)}` as Hex;
  return {
    paymaster: at(0, 20).toLowerCase() as Address,
    campaign: at(52, 32),
    key: at(84, 32),
    validUntil: Number(BigInt(at(116, 6))),
    validAfter: Number(BigInt(at(122, 6))),
    signature: at(128, 65),
  };
};

export class SponsorService {
  readonly #store: SponsorStore;
  readonly #chain: SponsorChain;
  readonly #now: () => Date;
  readonly #randomId: () => Hex;
  readonly #validity: number;

  constructor(deps: { store: SponsorStore; chain: SponsorChain; now?: () => Date; randomId?: () => Hex; validitySeconds?: number }) {
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#now = deps.now ?? (() => new Date());
    this.#randomId = deps.randomId ?? (() => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex);
    this.#validity = deps.validitySeconds ?? SPONSORSHIP_VALIDITY_SECONDS;
  }

  /** Public facts a dapp needs before its first request: where to fund, what the fee is. */
  async info() {
    return {
      chainId: this.#chain.chainId,
      entryPoint: this.#chain.entryPoint,
      paymaster: this.#chain.paymaster,
      escrow: this.#chain.escrow,
      feeBps: await this.#chain.feeBps(),
      validitySeconds: this.#validity,
      paymasterVerificationGas: DEFAULT_PAYMASTER_VERIFICATION_GAS.toString(),
      paymasterPostOpGas: DEFAULT_PAYMASTER_POSTOP_GAS.toString(),
    };
  }

  /* ---------- the sponsor's side ---------- */

  async register(owner: Address, policyInput: unknown): Promise<Registration> {
    const policy = parseSponsorPolicy(policyInput);
    const id = this.#randomId();
    const registerTx = await this.#chain.registerSponsor(id, owner);
    const record: SponsorRecord = { id, owner, policy, paused: false, closed: false, createdAt: this.#now().toISOString(), registerTx };
    await this.#store.putSponsor(record);
    return { sponsor: id, escrow: this.#chain.escrow, registerTx, policy };
  }

  async setPolicy(owner: Address, id: Hex, policyInput: unknown): Promise<SponsorPolicy> {
    const record = await this.#owned(owner, id);
    record.policy = parseSponsorPolicy(policyInput);
    await this.#store.putSponsor(record);
    return record.policy;
  }

  async setPaused(owner: Address, id: Hex, paused: boolean): Promise<{ paused: boolean }> {
    const record = await this.#owned(owner, id);
    record.paused = paused;
    await this.#store.putSponsor(record);
    return { paused };
  }

  /**
   * The sponsor is closing: the service stops signing for it. The budget
   * itself comes back through `close` on the escrow, which only the sponsor's
   * wallet can call (FR-007); the response says what is still in it.
   */
  async markClosed(owner: Address, id: Hex): Promise<{ closed: boolean; unused: Uint; staleKeys: Hex[] }> {
    const record = await this.#owned(owner, id);
    record.closed = true;
    await this.#store.putSponsor(record);
    const [budget, staleKeys] = await Promise.all([
      this.#chain.budgetOf(id),
      this.#store.staleKeys(id, Math.floor(this.#now().getTime() / 1000)),
    ]);
    return { closed: true, unused: budget.unused.toString(), staleKeys };
  }

  async list(owner: Address): Promise<Array<{ sponsor: Hex; paused: boolean; closed: boolean; createdAt: string }>> {
    const records = await this.#store.listSponsors(owner);
    return records.map((r) => ({ sponsor: r.id, paused: r.paused, closed: r.closed, createdAt: r.createdAt }));
  }

  async status(owner: Address, id: Hex): Promise<SponsorStatus> {
    const record = await this.#owned(owner, id);
    const [budget, deposit, feeBps, ops, staleKeys] = await Promise.all([
      this.#chain.budgetOf(id),
      this.#chain.paymasterDeposit(),
      this.#chain.feeBps(),
      this.#store.listOps(id, 200),
      this.#store.staleKeys(id, Math.floor(this.#now().getTime() / 1000)),
    ]);
    return {
      sponsor: id,
      owner: record.owner,
      paused: record.paused,
      closed: record.closed,
      policy: record.policy,
      budget: { funded: budget.funded.toString(), reserved: budget.reserved.toString(), spent: budget.spent.toString(), unused: budget.unused.toString() },
      feeBps,
      paymaster: this.#chain.paymaster,
      escrow: this.#chain.escrow,
      paymasterDeposit: deposit.toString(),
      spend: foldSpend(ops),
      // The dashboard never shows a user's address in clear (FR-008): the hash stands in for it.
      ops: ops.map(({ sender: _sender, ...rest }) => rest),
      staleKeys,
    };
  }

  async #owned(owner: Address, id: Hex): Promise<SponsorRecord> {
    if (!isHex32(id)) throw new FleetValidationError("invalid_sponsor");
    const record = await this.#store.getSponsor(id);
    if (!record || record.owner !== owner) throw new ServiceError("ineligible", "not_the_sponsor");
    return record;
  }

  /* ---------- the user's side: no login ---------- */

  /**
   * Every FR-002 check, then a signature. A refusal is a ServiceError with the
   * reason as its message; nothing is signed and nothing is recorded (SC-003).
   */
  async sponsor(sponsorId: unknown, opInput: unknown): Promise<Sponsorship> {
    if (!isHex32(sponsorId)) throw new FleetValidationError("invalid_sponsor");
    const op = parseSponsorOp(opInput);
    const record = await this.#store.getSponsor(sponsorId);
    const refuse = (why: Refusal): never => { throw new ServiceError("policy_rejected", why); };
    if (!record) return refuse("sponsor_unknown");
    if (record.closed) return refuse("sponsor_closed");
    if (record.paused) return refuse("sponsor_paused");

    const feeBps = await this.#chain.feeBps();
    const plan = planOf(op);
    const maxCost = requiredPrefund(plan);
    const maxCharged = chargedWithFee(maxCost, feeBps);
    const now = this.#now();
    const day = utcDay(now);
    const userHash = userHashOf(op.sender, sponsorId);
    const call = decodeSponsoredCall(op.callData);
    const [userSpentToday, sponsorSpentToday, budget] = await Promise.all([
      this.#store.spentOn(sponsorId, day, userHash),
      this.#store.spentOn(sponsorId, day),
      this.#chain.budgetOf(sponsorId),
    ]);
    const refusal = checkSponsorship(record.policy, call, { maxCharged, userSpentToday, sponsorSpentToday, budgetUnused: budget.unused });
    if (refusal) return refuse(refusal);

    const key = reservationKey(sponsorId, op.sender, BigInt(op.nonce));
    if (await this.#store.getOp(key)) throw new ServiceError("idempotency_conflict", "op_already_sponsored");
    const validUntil = Math.floor(now.getTime() / 1000) + this.#validity;
    const words = packedWords(op);
    const paymasterAndData = await buildFleetPaymasterData(
      {
        paymaster: this.#chain.paymaster,
        campaign: sponsorId,
        key,
        maxCost,
        chainId: this.#chain.chainId,
        validUntil,
        operation: {
          sender: op.sender, nonce: BigInt(op.nonce), callData: op.callData,
          accountGasLimits: words.accountGasLimits as Hex, preVerificationGas: BigInt(op.preVerificationGas), gasFees: words.gasFees as Hex,
        },
      },
      this.#chain.signSponsorship,
    );
    await this.#store.addOp({
      key, sponsor: sponsorId, userHash, sender: op.sender,
      target: call!.target, selector: call!.selector,
      maxCharged: maxCharged.toString(), signedAt: now.toISOString(), validUntil,
    });
    return {
      paymasterAndData, paymaster: this.#chain.paymaster, entryPoint: this.#chain.entryPoint, key,
      maxCost: maxCost.toString(), maxCharged: maxCharged.toString(), validUntil, feeBps,
    };
  }

  /**
   * Bundles a signed op the service sponsored. Refuses anything it did not
   * sign, before spending a wei of gas: the paymaster field must be ours, the
   * key must be one we recorded, the sponsorship signature must recover to
   * the operator over these exact fields, and the window must be open.
   */
  async submit(opInput: unknown): Promise<{ txHash: Hex; userOpHash: Hex; success: boolean; charged: Uint; key: Hex }> {
    const op = parsePackedOp(opInput);
    const pm = decodePaymasterAndData(op.paymasterAndData);
    if (!pm || pm.paymaster !== this.#chain.paymaster.toLowerCase()) throw new FleetValidationError("not_our_paymaster");
    const record = await this.#store.getOp(pm.key);
    if (!record || record.sponsor !== pm.campaign || record.sender !== op.sender) throw new ServiceError("policy_rejected", "op_not_sponsored");
    if (record.landedAt && record.txHash && record.userOpHash) {
      return { txHash: record.txHash, userOpHash: record.userOpHash, success: record.success ?? false, charged: record.charged ?? "0", key: pm.key };
    }
    const nowSeconds = Math.floor(this.#now().getTime() / 1000);
    if (pm.validUntil !== 0 && pm.validUntil < nowSeconds) throw new ServiceError("policy_rejected", "sponsorship_expired");
    const maxCost = requiredPrefund({
      verificationGasLimit: BigInt(`0x${op.accountGasLimits.slice(2, 34)}`),
      callGasLimit: BigInt(`0x${op.accountGasLimits.slice(34)}`),
      preVerificationGas: op.preVerificationGas,
      paymasterVerificationGas: BigInt(`0x${op.paymasterAndData.slice(42, 74)}`),
      paymasterPostOpGas: BigInt(`0x${op.paymasterAndData.slice(74, 106)}`),
      maxFeePerGas: BigInt(`0x${op.gasFees.slice(34)}`),
      maxPriorityFeePerGas: BigInt(`0x${op.gasFees.slice(2, 34)}`),
    });
    const digest = sponsorshipDigest({
      paymaster: this.#chain.paymaster, campaign: pm.campaign, key: pm.key, maxCost, chainId: this.#chain.chainId,
      validUntil: pm.validUntil, validAfter: pm.validAfter,
      operation: { sender: op.sender, nonce: op.nonce, callData: op.callData, accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas, gasFees: op.gasFees },
    });
    const signer = await recoverMessageAddress({ message: { raw: digest }, signature: pm.signature }).catch(() => null);
    if (!signer || signer.toLowerCase() !== this.#chain.operator.toLowerCase()) throw new ServiceError("policy_rejected", "sponsorship_not_ours");
    if (op.signature === "0x") throw new FleetValidationError("op_unsigned");

    const landed = await this.#chain.submit(op);
    // What the budget was really charged is the escrow's word, not the EntryPoint's:
    // postOp adds the fee, and it runs whether the inner call succeeded or reverted.
    const charged = await this.#chain.committedOf(pm.campaign, pm.key);
    await this.#store.updateOp(pm.key, {
      userOpHash: landed.userOpHash, txHash: landed.txHash, success: landed.success,
      charged: charged.toString(), landedAt: this.#now().toISOString(),
    });
    return { txHash: landed.txHash, userOpHash: landed.userOpHash, success: landed.success, charged: charged.toString(), key: pm.key };
  }
}

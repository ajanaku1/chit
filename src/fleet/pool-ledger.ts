/**
 * Stage 2 pool ledger.
 *
 * The pool holds custody state on chain, so no service database is needed and
 * any function instance can serve any trader. The one fact that must not be
 * public, which depositor a campaign belongs to, travels on chain as a
 * ciphertext only the operator's ledger key opens; this module seals and opens
 * it and recomputes a trader's available balance from what the chain reports.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { keccak256, parseEther, stringToBytes, type Address, type Hex } from "viem";

/** Published deposit sizes, ascending. Fixed so one deposit looks like another. */
export const DEPOSIT_SIZES: readonly bigint[] = [
  parseEther("0.01"),
  parseEther("0.05"),
  parseEther("0.1"),
];

const NONCE_BYTES = 12;
const ADDRESS_BYTES = 20;
const TAG_BYTES = 16;
const SEALED_BYTES = NONCE_BYTES + ADDRESS_BYTES + TAG_BYTES;

/**
 * The ledger key, derived from the operator key already in the environment and
 * domain-separated from every other use of it. Every instance derives the same
 * key, and none of them stores it.
 */
export const ledgerKey = (operatorKey: Hex): Hex =>
  keccak256(stringToBytes(`chit-fleet-ledger-v1|${operatorKey}`));

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

/** Seals one depositor address for on-chain storage. A fresh nonce each time,
 *  so two campaigns of the same trader do not share a ciphertext. */
export const sealDepositor = (key: Hex, depositor: Address): Hex => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", bytes(key), nonce);
  const sealed = Buffer.concat([cipher.update(bytes(depositor as Hex)), cipher.final()]);
  return `0x${Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("hex")}`;
};

/** Opens a sealed depositor, or undefined if it is not ours and not intact. */
export const openDepositor = (key: Hex, sealed: Hex): Address | undefined => {
  try {
    const raw = bytes(sealed);
    if (raw.length !== SEALED_BYTES) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", bytes(key), raw.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES + ADDRESS_BYTES));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(NONCE_BYTES, NONCE_BYTES + ADDRESS_BYTES)),
      decipher.final(),
    ]);
    return `0x${plain.toString("hex")}` as Address;
  } catch {
    return undefined;
  }
};

/** A draw as the chain reports it. State follows the contract enum. */
export type DrawView = { ownerRef: Hex; amount: bigint; state: number };

/** A queued spend as the chain reports it. */
export type QueuedView = { encDepositor: Hex; amount: bigint; posted: boolean };

export type LedgerInputs = {
  deposited: bigint;
  spent: bigint;
  queued: readonly QueuedView[];
  draws: readonly DrawView[];
};

const DRAW_OPEN = new Set([1, 2]); // Pending, Funded

/**
 * What a trader may still spend or withdraw: their deposits, less spend already
 * posted, less spend queued against them but not yet posted, less every draw
 * still standing. A posted queued spend is already inside `spent`, so counting
 * it again would strand the trader's ETH.
 */
export const availableBalance = (key: Hex, depositor: Address, inputs: LedgerInputs): bigint => {
  const mine = (ref: Hex): boolean =>
    openDepositor(key, ref)?.toLowerCase() === depositor.toLowerCase();

  let available = inputs.deposited - inputs.spent;
  for (const entry of inputs.queued) {
    if (!entry.posted && mine(entry.encDepositor)) available -= entry.amount;
  }
  for (const draw of inputs.draws) {
    if (DRAW_OPEN.has(draw.state) && mine(draw.ownerRef)) available -= draw.amount;
  }
  return available > 0n ? available : 0n;
};

/** The published sizes both caps still admit, so the app never offers a
 *  deposit the contract would refuse. */
export const depositSizes = (perDepositor: bigint, perPool: bigint): bigint[] => {
  const room = perDepositor < perPool ? perDepositor : perPool;
  return DEPOSIT_SIZES.filter((size) => size <= room);
};

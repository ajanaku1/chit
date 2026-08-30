/**
 * Recovery Vault v1 (FR-005, FR-006, SC-008).
 *
 * Exact implementation of `specs/001-fleet-mission/contracts/fleet-vault.md`.
 * Owner keys exist in plaintext only inside browser memory; what leaves is a
 * downloaded AES-256-GCM envelope whose KEK derives from a primary-wallet
 * EIP-191 signature via HKDF-SHA256. Every recovery failure — wrong wallet,
 * changed origin or chain, any tampered field, a payload that fails validation —
 * collapses into the single non-oracular `vault_decryption_failed`.
 */

import { hexToBytes, keccak256, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Hex = `0x${string}`;
export type VaultAccount = { ownerAddress: Hex; privateKey: Hex; salt: Hex };
export type VaultContext = {
  origin: string;
  primaryChainId: string;
  primaryWallet: Hex;
  signMessage: (message: string) => Promise<Hex>;
};
export type VaultRandomness = { vaultId: Hex; kdfSalt: Hex; payloadIv: Hex; wrapIv: Hex; dek: Hex };
export type CreatedVault = { envelopeJson: string; commitment: Hex };

const DOMAIN = "chit:fleet:vault:v1";
const KEK_INFO = "chit:fleet:vault:kek:v1";
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export class VaultError extends Error {
  readonly code: "vault_invalid" | "vault_decryption_failed";
  readonly reason: string;

  constructor(code: VaultError["code"], reason: string) {
    // Recovery failures expose nothing beyond the single code (non-oracular).
    super(code === "vault_decryption_failed" ? code : `${code}: ${reason}`);
    this.name = "VaultError";
    this.code = code;
    this.reason = reason;
  }
}

const invalid = (reason: string): never => {
  throw new VaultError("vault_invalid", reason);
};

/** The one recovery failure. The reason stays internal for debugging only. */
const failClosed = (reason: string): never => {
  throw new VaultError("vault_decryption_failed", reason);
};

const isHexOf = (value: unknown, bytes: number): value is Hex =>
  typeof value === "string" && new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(value);

/** The exact UTF-8, LF-delimited message the primary wallet signs. */
export const buildSigningMessage = (context: VaultContext, vaultId: Hex, kdfSalt: Hex): string =>
  [
    "Chit Fleet Mission Recovery Vault",
    "version=1",
    `origin=${context.origin}`,
    `primaryChainId=${context.primaryChainId}`,
    `primaryWallet=${context.primaryWallet.toLowerCase()}`,
    `vaultId=${vaultId}`,
    `kdfSalt=${kdfSalt}`,
  ].join("\n");

/** Canonical 65-byte low-s signature bytes with v normalized to 27/28. */
const normalizeSignature = (signature: Hex): Uint8Array => {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) invalid("malformed_signature");
  const v = bytes[64] as number;
  if (v === 0 || v === 1) bytes[64] = v + 27;
  else if (v !== 27 && v !== 28) invalid("malformed_signature");
  return bytes;
};

/** HKDF-SHA256(signature, kdfSalt, "chit:fleet:vault:kek:v1") → 32-byte AES-GCM KEK. */
const deriveKek = async (signatureBytes: Uint8Array, kdfSalt: Hex): Promise<CryptoKey> => {
  const ikm = await crypto.subtle.importKey("raw", signatureBytes as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: hexToBytes(kdfSalt) as BufferSource, info: utf8(KEK_INFO) as BufferSource },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
};

const aad = (context: VaultContext, vaultId: Hex, kind: "payload" | "wrap"): Uint8Array =>
  utf8(`${DOMAIN}|${context.origin}|${context.primaryChainId}|${context.primaryWallet.toLowerCase()}|${vaultId}|${kind}`);

const toHex = (bytes: Uint8Array): Hex =>
  `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;

/** AES-256-GCM with a 128-bit tag; WebCrypto appends the tag, we split it. */
const encrypt = async (key: CryptoKey, iv: Hex, plaintext: Uint8Array, aadBytes: Uint8Array) => {
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: hexToBytes(iv) as BufferSource, additionalData: aadBytes as BufferSource, tagLength: 128 },
    key,
    plaintext as BufferSource,
  ));
  return { ciphertext: toHex(sealed.slice(0, -16)), tag: toHex(sealed.slice(-16)) };
};

const decrypt = async (key: CryptoKey, iv: Hex, ciphertext: Hex, tag: Hex, aadBytes: Uint8Array): Promise<Uint8Array> => {
  const sealed = new Uint8Array([...hexToBytes(ciphertext), ...hexToBytes(tag)]);
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(iv) as BufferSource, additionalData: aadBytes as BufferSource, tagLength: 128 },
    key,
    sealed as BufferSource,
  );
  return new Uint8Array(opened);
};

/** Sorted, validated account list: distinct owners, distinct salts, keys derive owners. */
const canonicalAccounts = (accounts: readonly VaultAccount[]): VaultAccount[] => {
  const sorted = accounts
    .map((account) => ({
      ownerAddress: account.ownerAddress.toLowerCase() as Hex,
      privateKey: account.privateKey.toLowerCase() as Hex,
      salt: account.salt.toLowerCase() as Hex,
    }))
    .sort((left, right) =>
      left.ownerAddress < right.ownerAddress ? -1 : left.ownerAddress > right.ownerAddress ? 1
      : left.salt < right.salt ? -1 : 1);

  const owners = new Set<string>();
  const salts = new Set<string>();
  for (const account of sorted) {
    if (!isHexOf(account.ownerAddress, 20)) invalid("malformed_owner");
    if (!isHexOf(account.privateKey, 32)) invalid("malformed_private_key");
    if (!isHexOf(account.salt, 32)) invalid("malformed_salt");
    if (owners.has(account.ownerAddress)) invalid("duplicate_owner");
    if (salts.has(account.salt)) invalid("duplicate_salt");
    owners.add(account.ownerAddress);
    salts.add(account.salt);
    if (privateKeyToAccount(account.privateKey).address.toLowerCase() !== account.ownerAddress) {
      invalid("owner_derivation_mismatch");
    }
  }
  return sorted;
};

/** canonicalJsonUtf8 of the exact payload schema and key order. */
const payloadJson = (accounts: readonly VaultAccount[], vaultId: Hex): string =>
  `{"accounts":[${accounts
    .map((account) =>
      `{"ownerAddress":"${account.ownerAddress}","privateKey":"${account.privateKey}","salt":"${account.salt}"}`)
    .join(",")}],"vaultId":"${vaultId}","version":1}`;

const ownerCommitmentOf = (accounts: readonly VaultAccount[]): Hex =>
  keccak256(utf8(`${DOMAIN}|owners|${accounts.map((account) => account.ownerAddress).join("\n")}`));

const accountCommitmentOf = (accounts: readonly VaultAccount[]): Hex =>
  keccak256(utf8(`${DOMAIN}|accounts|${accounts.map((account) => `${account.ownerAddress}|${account.salt}`).join("\n")}`));

const randomHex = (bytes: number): Hex => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
};

const validateRandomness = (randomness: VaultRandomness): VaultRandomness => {
  if (!isHexOf(randomness.vaultId, 32)) invalid("malformed_vault_id");
  if (!isHexOf(randomness.kdfSalt, 32)) invalid("malformed_kdf_salt");
  if (!isHexOf(randomness.payloadIv, 12) || !isHexOf(randomness.wrapIv, 12)) invalid("malformed_iv");
  if (randomness.payloadIv === randomness.wrapIv) invalid("iv_reuse");
  if (!isHexOf(randomness.dek, 32)) invalid("malformed_dek");
  return randomness;
};

export const createRecoveryVault = async (
  context: VaultContext,
  accounts: readonly VaultAccount[],
  randomness?: VaultRandomness,
): Promise<CreatedVault> => {
  const rand = validateRandomness(
    randomness ?? {
      vaultId: randomHex(32),
      kdfSalt: randomHex(32),
      payloadIv: randomHex(12),
      wrapIv: randomHex(12),
      dek: randomHex(32),
    },
  );
  const sorted = canonicalAccounts(accounts);
  const wallet = context.primaryWallet.toLowerCase() as Hex;

  const signature = await context.signMessage(buildSigningMessage(context, rand.vaultId, rand.kdfSalt));
  const kek = await deriveKek(normalizeSignature(signature), rand.kdfSalt);
  const dekKey = await crypto.subtle.importKey("raw", hexToBytes(rand.dek) as BufferSource, "AES-GCM", false, ["encrypt"]);

  const payload = await encrypt(dekKey, rand.payloadIv, utf8(payloadJson(sorted, rand.vaultId)), aad(context, rand.vaultId, "payload"));
  const wrap = await encrypt(kek, rand.wrapIv, hexToBytes(rand.dek), aad(context, rand.vaultId, "wrap"));

  // canonicalJsonUtf8: this literal IS the sorted-key, no-whitespace form.
  const envelopeJson =
    `{"accountCommitment":"${accountCommitmentOf(sorted)}","kdfSalt":"${rand.kdfSalt}","origin":"${context.origin}"` +
    `,"ownerCommitment":"${ownerCommitmentOf(sorted)}","payloadAlgorithm":"AES-256-GCM"` +
    `,"payloadCiphertext":"${payload.ciphertext}","payloadIv":"${rand.payloadIv}","payloadTag":"${payload.tag}"` +
    `,"primaryChainId":"${context.primaryChainId}","primaryWallet":"${wallet}","vaultId":"${rand.vaultId}"` +
    `,"version":1,"wrapAlgorithm":"AES-256-GCM","wrapIv":"${rand.wrapIv}","wrapTag":"${wrap.tag}"` +
    `,"wrappedDek":"${wrap.ciphertext}"}`;

  return { envelopeJson, commitment: keccak256(utf8(envelopeJson)) };
};

type Envelope = {
  accountCommitment: Hex; kdfSalt: Hex; origin: string; ownerCommitment: Hex;
  payloadAlgorithm: string; payloadCiphertext: Hex; payloadIv: Hex; payloadTag: Hex;
  primaryChainId: string; primaryWallet: Hex; vaultId: Hex; version: number;
  wrapAlgorithm: string; wrapIv: Hex; wrapTag: Hex; wrappedDek: Hex;
};

/** Pre-decryption validation: version, algorithms, lengths, origin, chain, wallet, IVs. */
const validateEnvelope = (context: VaultContext, raw: string): Envelope => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return failClosed("not_json");
  }
  const envelope = parsed as unknown as Envelope;
  if (envelope.version !== 1) failClosed("unknown_version");
  if (envelope.payloadAlgorithm !== "AES-256-GCM" || envelope.wrapAlgorithm !== "AES-256-GCM") {
    failClosed("unknown_algorithm");
  }
  if (!isHexOf(envelope.vaultId, 32) || !isHexOf(envelope.kdfSalt, 32)) failClosed("malformed_field");
  if (!isHexOf(envelope.payloadIv, 12) || !isHexOf(envelope.wrapIv, 12)) failClosed("malformed_iv");
  if (envelope.payloadIv === envelope.wrapIv) failClosed("iv_reuse");
  if (!isHexOf(envelope.ownerCommitment, 32) || !isHexOf(envelope.accountCommitment, 32)) failClosed("malformed_commitment");
  if (!isHexOf(envelope.payloadTag, 16) || !isHexOf(envelope.wrapTag, 16)) failClosed("malformed_tag");
  if (!isHexOf(envelope.wrappedDek, 32)) failClosed("malformed_wrapped_dek");
  if (envelope.origin !== context.origin) failClosed("origin_mismatch");
  if (envelope.primaryChainId !== context.primaryChainId) failClosed("chain_mismatch");
  if (envelope.primaryWallet !== context.primaryWallet.toLowerCase()) failClosed("wallet_mismatch");
  return envelope;
};

export const recoverVault = async (
  context: VaultContext,
  envelopeJson: string,
): Promise<{ accounts: VaultAccount[] }> => {
  const envelope = validateEnvelope(context, envelopeJson);
  try {
    const message = buildSigningMessage(context, envelope.vaultId, envelope.kdfSalt);
    const signature = await context.signMessage(message);
    const signatureBytes = normalizeSignature(signature);

    // A wallet that signs for a different address than the envelope's cannot
    // proceed even if HKDF would happily derive a (wrong) key from it.
    const signer = await recoverMessageAddress({ message, signature });
    if (signer.toLowerCase() !== envelope.primaryWallet) failClosed("wrong_wallet");

    const kek = await deriveKek(signatureBytes, envelope.kdfSalt);
    const dekBytes = await decrypt(kek, envelope.wrapIv, envelope.wrappedDek, envelope.wrapTag, aad(context, envelope.vaultId, "wrap"));
    const dekKey = await crypto.subtle.importKey("raw", dekBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
    const payloadBytes = await decrypt(dekKey, envelope.payloadIv, envelope.payloadCiphertext, envelope.payloadTag, aad(context, envelope.vaultId, "payload"));

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { accounts: VaultAccount[]; vaultId: Hex; version: number };
    if (payload.version !== 1 || payload.vaultId !== envelope.vaultId) failClosed("payload_mismatch");

    const accounts = canonicalAccounts(payload.accounts);
    if (payloadJson(accounts, payload.vaultId) !== new TextDecoder().decode(payloadBytes)) failClosed("payload_not_canonical");
    if (ownerCommitmentOf(accounts) !== envelope.ownerCommitment) failClosed("owner_commitment_mismatch");
    if (accountCommitmentOf(accounts) !== envelope.accountCommitment) failClosed("account_commitment_mismatch");

    // Best-effort release of intermediate plaintext buffers.
    dekBytes.fill(0);
    payloadBytes.fill(0);
    return { accounts };
  } catch (error) {
    // Every failure is externally identical; only the already-collapsed code
    // may pass through, so validation reasons never leak into recovery.
    if (error instanceof VaultError && error.code === "vault_decryption_failed") throw error;
    return failClosed("recovery_failed");
  }
};

/** Fresh second signature + full decrypt round-trip, gating funding (FR-006). */
export const confirmRecovery = async (
  context: VaultContext,
  envelopeJson: string,
  expectedCommitment: Hex,
): Promise<true> => {
  if (keccak256(utf8(envelopeJson)) !== expectedCommitment) failClosed("commitment_mismatch");
  await recoverVault(context, envelopeJson);
  return true;
};

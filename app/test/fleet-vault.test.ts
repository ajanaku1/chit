import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hexToBytes, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  VaultError,
  buildSigningMessage,
  confirmRecovery,
  createRecoveryVault,
  recoverVault,
  type VaultContext,
} from "../src/fleet/vault.js";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type Vector = {
  origin: string; primaryChainId: string; primaryWallet: `0x${string}`;
  primaryPrivateKey: `0x${string}`;
  vaultId: `0x${string}`; kdfSalt: `0x${string}`;
  payloadIv: `0x${string}`; wrapIv: `0x${string}`; dek: `0x${string}`;
  accounts: { ownerAddress: `0x${string}`; privateKey: `0x${string}`; salt: `0x${string}` }[];
  signingMessage: string; signature: `0x${string}`; kek: `0x${string}`;
  payloadCanonical: string; payloadCiphertext: `0x${string}`; payloadTag: `0x${string}`;
  wrappedDek: `0x${string}`; wrapTag: `0x${string}`;
  ownerCommitment: `0x${string}`; accountCommitment: `0x${string}`;
  envelopeJson: string; commitment: `0x${string}`;
};

const vectorPromise = readFile(join(appRoot, "test/fixtures/fleet-vault-v1.json"), "utf8")
  .then((raw) => JSON.parse(raw) as Vector);

const context = (vector: Vector, overrides: Partial<VaultContext> = {}): VaultContext => {
  const signer = privateKeyToAccount(vector.primaryPrivateKey);
  return {
    origin: vector.origin,
    primaryChainId: vector.primaryChainId,
    primaryWallet: vector.primaryWallet,
    signMessage: (message: string) => signer.signMessage({ message }),
    ...overrides,
  };
};

const randomness = (vector: Vector) => ({
  vaultId: vector.vaultId,
  kdfSalt: vector.kdfSalt,
  payloadIv: vector.payloadIv,
  wrapIv: vector.wrapIv,
  dek: vector.dek,
});

const failsClosed = async (run: () => Promise<unknown>): Promise<VaultError> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof VaultError, `expected VaultError, got ${String(error)}`);
    assert.equal(error.code, "vault_decryption_failed");
    assert.equal(error.message, "vault_decryption_failed", "the failure must be non-oracular");
    return error;
  }
  return assert.fail("expected vault_decryption_failed");
};

test("the signing message is the exact specified UTF-8 LF-delimited bytes", async () => {
  const vector = await vectorPromise;
  assert.equal(
    buildSigningMessage(context(vector), vector.vaultId, vector.kdfSalt),
    vector.signingMessage,
  );
});

test("the fixed vector reproduces every intermediate and the final envelope exactly", async () => {
  const vector = await vectorPromise;
  const created = await createRecoveryVault(context(vector), vector.accounts, randomness(vector));

  const envelope = JSON.parse(created.envelopeJson) as Record<string, unknown>;
  assert.equal(envelope["payloadCiphertext"], vector.payloadCiphertext, "AES-GCM payload ciphertext");
  assert.equal(envelope["payloadTag"], vector.payloadTag, "AES-GCM payload tag");
  assert.equal(envelope["wrappedDek"], vector.wrappedDek, "HKDF KEK wrap of the DEK");
  assert.equal(envelope["wrapTag"], vector.wrapTag, "AES-GCM wrap tag");
  assert.equal(envelope["ownerCommitment"], vector.ownerCommitment);
  assert.equal(envelope["accountCommitment"], vector.accountCommitment);

  assert.equal(created.envelopeJson, vector.envelopeJson, "canonical envelope serialization");
  assert.equal(created.commitment, vector.commitment, "keccak256 of the canonical envelope bytes");
  assert.equal(created.commitment, keccak256(new TextEncoder().encode(vector.envelopeJson)));
});

test("creation sorts unsorted accounts into the canonical order", async () => {
  const vector = await vectorPromise;
  const shuffled = [...vector.accounts].reverse();
  const created = await createRecoveryVault(context(vector), shuffled, randomness(vector));
  assert.equal(created.commitment, vector.commitment);
});

test("recovery round-trips the exact account set", async () => {
  const vector = await vectorPromise;
  const recovered = await recoverVault(context(vector), vector.envelopeJson);
  assert.deepEqual(recovered.accounts, vector.accounts);
});

test("recovery confirmation takes a fresh second signature and validates the commitment", async () => {
  const vector = await vectorPromise;
  const signer = privateKeyToAccount(vector.primaryPrivateKey);
  let signatures = 0;
  const ctx = context(vector, {
    signMessage: (message: string) => {
      signatures += 1;
      return signer.signMessage({ message });
    },
  });

  assert.equal(await confirmRecovery(ctx, vector.envelopeJson, vector.commitment), true);
  assert.equal(signatures, 1, "confirmation performs its own fresh signature");

  await failsClosed(() => confirmRecovery(ctx, vector.envelopeJson, `0x${"9".repeat(64)}`));
});

test("a wrong wallet cannot decrypt", async () => {
  const vector = await vectorPromise;
  const stranger = privateKeyToAccount(`0x${"77".repeat(32)}`);
  await failsClosed(() =>
    recoverVault(
      context(vector, { signMessage: (message: string) => stranger.signMessage({ message }) }),
      vector.envelopeJson,
    ),
  );
  await failsClosed(() =>
    recoverVault(context(vector, { primaryWallet: stranger.address.toLowerCase() as `0x${string}` }), vector.envelopeJson),
  );
});

test("changed origin or chain fails closed", async () => {
  const vector = await vectorPromise;
  await failsClosed(() => recoverVault(context(vector, { origin: "https://evil.example" }), vector.envelopeJson));
  await failsClosed(() => recoverVault(context(vector, { primaryChainId: "1" }), vector.envelopeJson));
});

test("every tampered envelope field fails closed with the same result", async () => {
  const vector = await vectorPromise;
  const tamper = (field: string, value: unknown): string => {
    const parsed = JSON.parse(vector.envelopeJson) as Record<string, unknown>;
    parsed[field] = value;
    // Re-serialize in the same sorted order the canonical form uses.
    return JSON.stringify(parsed, Object.keys(parsed).sort());
  };
  const flip = (hexValue: string): string =>
    hexValue.slice(0, -1) + (hexValue.endsWith("0") ? "1" : "0");

  for (const field of ["payloadCiphertext", "payloadTag", "wrappedDek", "wrapTag", "kdfSalt", "vaultId"]) {
    const original = (JSON.parse(vector.envelopeJson) as Record<string, string>)[field] as string;
    await failsClosed(() => recoverVault(context(vector), tamper(field, flip(original))));
  }
  await failsClosed(() => recoverVault(context(vector), tamper("ownerCommitment", `0x${"1".repeat(64)}`)));
  await failsClosed(() => recoverVault(context(vector), tamper("accountCommitment", `0x${"1".repeat(64)}`)));
  await failsClosed(() => recoverVault(context(vector), tamper("version", 2)));
  await failsClosed(() => recoverVault(context(vector), tamper("payloadAlgorithm", "AES-256-CBC")));
  await failsClosed(() => recoverVault(context(vector), tamper("wrapAlgorithm", "AES-128-GCM")));
  await failsClosed(() => recoverVault(context(vector), tamper("payloadIv", vector.wrapIv)));
  await failsClosed(() => recoverVault(context(vector), tamper("payloadIv", "0x" + "c3".repeat(11))));
  await failsClosed(() => recoverVault(context(vector), "not json"));
});

test("a payload whose keys do not derive their declared owners fails closed", async () => {
  const vector = await vectorPromise;

  // Forge a payload that swaps two owner addresses, re-encrypted with the
  // vector's own DEK so only the derivation check can catch it.
  const forged = JSON.parse(vector.payloadCanonical) as { accounts: { ownerAddress: string }[] };
  const first = forged.accounts[0]!.ownerAddress;
  forged.accounts[0]!.ownerAddress = forged.accounts[1]!.ownerAddress;
  forged.accounts[1]!.ownerAddress = first;
  const forgedBytes = new TextEncoder().encode(canonicalize(forged));

  const aad = new TextEncoder().encode(
    `chit:fleet:vault:v1|${vector.origin}|${vector.primaryChainId}|${vector.primaryWallet}|${vector.vaultId}|payload`,
  );
  const cipher = createCipheriv("aes-256-gcm", hexToBytes(vector.dek), hexToBytes(vector.payloadIv));
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(forgedBytes), cipher.final()]);

  const parsed = JSON.parse(vector.envelopeJson) as Record<string, unknown>;
  parsed["payloadCiphertext"] = `0x${ciphertext.toString("hex")}`;
  parsed["payloadTag"] = `0x${cipher.getAuthTag().toString("hex")}`;
  const forgedEnvelope = JSON.stringify(parsed, Object.keys(parsed).sort());

  await failsClosed(() => recoverVault(context(vector), forgedEnvelope));
});

test("creation rejects malformed randomness, IV reuse, and inconsistent accounts", async () => {
  const vector = await vectorPromise;
  const create = (accounts: Vector["accounts"], rand: ReturnType<typeof randomness>) =>
    createRecoveryVault(context(vector), accounts, rand);
  const creationFails = async (run: () => Promise<unknown>, reason: string) => {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof VaultError);
      assert.equal(error.code, "vault_invalid");
      assert.equal(error.reason, reason);
      return;
    }
    assert.fail(`expected vault_invalid:${reason}`);
  };

  await creationFails(() => create(vector.accounts, { ...randomness(vector), wrapIv: vector.payloadIv }), "iv_reuse");
  await creationFails(() => create(vector.accounts, { ...randomness(vector), payloadIv: ("0x" + "c3".repeat(11)) as `0x${string}` }), "malformed_iv");
  await creationFails(() => create(vector.accounts, { ...randomness(vector), vaultId: ("0x" + "a1".repeat(31)) as `0x${string}` }), "malformed_vault_id");
  await creationFails(() => create(vector.accounts, { ...randomness(vector), dek: ("0x" + "e5".repeat(16)) as `0x${string}` }), "malformed_dek");
  await creationFails(
    // Copy owner AND key so derivation passes and only distinctness can refuse it.
    () => create(vector.accounts.map((a, i) => (i === 1 ? { ...a, ownerAddress: vector.accounts[0]!.ownerAddress, privateKey: vector.accounts[0]!.privateKey } : a)), randomness(vector)),
    "duplicate_owner",
  );
  await creationFails(
    () => create(vector.accounts.map((a, i) => (i === 0 ? { ...a, privateKey: vector.accounts[1]!.privateKey } : a)), randomness(vector)),
    "owner_derivation_mismatch",
  );
});

/** Minimal canonical serializer for the forged payload in this test file only. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

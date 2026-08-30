# Fleet Recovery Vault v1 Contract

## Generation and signature

The browser uses `crypto.getRandomValues` to generate a 32-byte `vaultId`, 32-byte HKDF `kdfSalt`, distinct 12-byte `payloadIv` and `wrapIv`, and a random 32-byte DEK. It asks the primary wallet for EIP-191 `personal_sign` over this exact UTF-8, LF-delimited message:

```text
Chit Fleet Mission Recovery Vault
version=1
origin=<normalized URL origin>
primaryChainId=<decimal>
primaryWallet=<lowercase 20-byte address>
vaultId=<0x 32-byte hex>
kdfSalt=<0x 32-byte hex>
```

Only a canonical 65-byte, low-s secp256k1 signature is accepted; normalize `v` to 27 or 28. Import its normalized bytes as HKDF IKM with `kdfSalt`, SHA-256, and exact UTF-8 info `chit:fleet:vault:kek:v1` to derive a 32-byte AES-GCM KEK.

## Canonical bytes, payload, and commitments

All cryptographic JSON bytes use the following `canonicalJsonUtf8` encoding: ASCII-only JSON encoded by `TextEncoder` UTF-8 without a BOM; no whitespace; object names sorted ascending by ASCII byte; arrays retain their stated order; lowercase `0x` hex is used for every byte string and address. No JSON escape sequence is permitted. `primaryChainId` is a quoted base-10 integer without a leading zero, and normalized origin is its ASCII URL-origin serialization. Account entries are sorted by lowercase `ownerAddress`, then lowercase `salt`.

The payload is `canonicalJsonUtf8` of this exact schema and key order:

```json
{"accounts":[{"ownerAddress":"<Address>","privateKey":"<0x 32-byte hex>","salt":"<Hex>"}],"vaultId":"<0x 32-byte hex>","version":1}
```

Each private key is exactly 32 bytes and derives its declared owner address. Define `ownerPreimage` as UTF-8 `chit:fleet:vault:v1|owners|` followed by the sorted owner addresses joined with LF. Define `accountPreimage` as UTF-8 `chit:fleet:vault:v1|accounts|` followed by the sorted `ownerAddress|salt` pairs joined with LF. `ownerCommitment` and `accountCommitment` are respectively `keccak256(ownerPreimage)` and `keccak256(accountPreimage)` as lowercase 32-byte hex.

The DEK encrypts this payload with AES-256-GCM, `payloadIv`, a 128-bit tag, and exact UTF-8 AAD `chit:fleet:vault:v1|<origin>|<primaryChainId>|<primaryWallet>|<vaultId>|payload`. The KEK wraps the DEK with AES-256-GCM, `wrapIv`, a 128-bit tag, and the same prefix ending `|wrap`.

`RecoveryVaultEnvelope` is `canonicalJsonUtf8` of this exact top-level field order and schema:

```json
{"accountCommitment":"<0x 32-byte hex>","kdfSalt":"<0x 32-byte hex>","origin":"<normalized ASCII URL origin>","ownerCommitment":"<0x 32-byte hex>","payloadAlgorithm":"AES-256-GCM","payloadCiphertext":"<0x nonempty hex>","payloadIv":"<0x 12-byte hex>","payloadTag":"<0x 16-byte hex>","primaryChainId":"<base-10 decimal>","primaryWallet":"<lowercase 20-byte address>","vaultId":"<0x 32-byte hex>","version":1,"wrapAlgorithm":"AES-256-GCM","wrapIv":"<0x 12-byte hex>","wrapTag":"<0x 16-byte hex>","wrappedDek":"<0x 32-byte hex>"}
```

It stores neither signature, KEK, DEK, nor plaintext private key. `recoveryVaultCommitment` is lowercase `keccak256` of these complete `canonicalJsonUtf8` envelope bytes.

## Recovery and boundary

The downloaded envelope stays local and is never uploaded. Before recovery, validate exact version, algorithms, field lengths, normalized origin, chain, wallet, and distinct IVs. Re-sign the exact message, derive the KEK, unwrap the DEK, decrypt the payload, then validate `vaultId`, all owner derivations, distinct owners and salts, and commitments before returning keys only in browser memory. Plaintext buffers are zeroed or best-effort released after use.

Unknown version/algorithm, wrong wallet or signature, changed origin/chain, malformed or reused IV, tampered metadata/AAD/ciphertext/tag/wrapped DEK, or commitment mismatch fails closed as the single non-oracular `vault_decryption_failed` result with no partial plaintext. Recovery confirmation before funding performs a fresh second signature and decrypt round-trip from the downloaded envelope. A wallet unable to reproduce the canonical signature is unsupported and blocked before funding.

The service receives only `recoveryVaultCommitment`, the authenticated primary wallet, and public account list. It keeps its separate operator-encrypted mapping at rest; it never receives recovery ciphertext or owner private keys.

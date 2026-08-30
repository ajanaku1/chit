# Fleet Mission Data Model

## Campaign

- **Identity**: Opaque internal campaign record; no reusable public campaign identifier in UserOperations.
- **Fields**: Campaign name, chain, account count, state, expiry, approved router/function, maximum trade value, per-account and total gas budgets, fee disclosure, immutable validated FleetAccountInit list (distinct ownerAddress and salt), `recoveryVaultCommitment`, derived account addresses/activation status, a separate operator-encrypted mapping reference, and idempotency records.
- **Relationships**: Creation validates and stores 5–50 distinct initializations; handle-only activation/retry reads that immutable list and idempotently resumes without creating owners, salts, or accounts.
- **State transitions**: Draft → Awaiting recovery confirmation → Awaiting funding → Activating → Active; Active → Paused, Revoked, Depleted, Expired, or Closed; Paused → Active or terminal state; Revoked permits Close only; Close returns unused ETH.

## Fleet account

- **Identity**: Newly generated smart account with a distinct browser-generated owner credential.
- **Fields**: Public ownerAddress, salt, derived account address, activation status, per-account gas use, and public token-balance result.
- **Rules**: It is never an imported EOA and its local owner credential is not emitted to API, logs, or storage.

## Recovery vault

- **Identity**: Downloaded versioned encrypted recovery material for one campaign.
- **Fields**: Local `RecoveryVaultEnvelope` v1, its `recoveryVaultCommitment`, and recovery-confirmation status; exact schema and cryptography are in `contracts/fleet-vault.md`.
- **Rules**: The envelope is downloaded/local only and never uploaded; it requires primary-wallet authorization to decrypt, and a fresh second signature/decrypt confirmation precedes funding or activation. It is distinct from the service's separate operator-encrypted mapping reference.

## Session policy

- **Identity**: One bounded session key per campaign.
- **Fields**: Campaign binding, chain, generated accounts, router/function, maximum trade value, gas limits, expiry, and revoked flag.
- **Rules**: It rejects arbitrary transfer, ownership change, gas withdrawal, key authorization, and unapproved contract calls.

## Campaign budget

- **Identity**: ETH reserved for one campaign within pooled sponsorship funding.
- **Fields**: Funded, reserved, spent, unused, and terminal-return amount.
- **Rules**: Reservation is idempotent and exact; only permitted requests debit it; Close returns unused ETH to the campaign owner.

## Fee disclosure

- **Fields**: Published CHIT threshold, base service fee, configured CHIT discount, net service fee, and eligibility result.
- **Rules**: It is read-only mainnet eligibility data at creation; charged net fee equals base fee minus configured discount.

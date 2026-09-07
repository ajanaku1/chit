# Private Funding Pool Data Model

## Pool (contract state)

- Constants: allowed deposit sizes {0.01, 0.05, 0.1 ETH}; per-depositor cap 0.5 ETH; per-draw cap 0.2 ETH; pool cap 5 ETH; exit delay 24 h; gas headroom 0.0002 ETH per account.
- `paused: bool` (operator).
- `totalDeposited`, `totalSpentClaimed` for the operator claim bound.
- Invariant: pool ETH balance = Σ deposits − Σ principal moved out − Σ exits paid − Σ operator claims.

## Depositor (contract, keyed by address)

- `deposited`: Σ accepted deposits.
- `spent`: Σ posted spend (buy principal, gas, Chit-paid withdrawals).
- `exitRequestedAt`: 0 or timestamp; `exitAmount` fixed at request as `deposited − spent`.
- Rules: deposit refused if size not allowed, paused, `deposited + size > cap`, or pool cap exceeded; exit executes only after delay, pays `min(exitAmount, deposited − spent)`, then zeroes both.

## Draw (contract, keyed by campaign)

- `amount` (≤ per-draw cap), `spent`, `dueAt`, `ownerRef: bytes` (AES-GCM ciphertext of the depositor address, operator-decryptable), `state: Pending | Funded | Closed`.
- Transitions: `openDraw` (Pending, dueAt = now + random 60..900 s) → `fund` when `now ≥ dueAt` (seeds accounts, session opened by the operator) → `commit`/`rollback` per buy while Funded → `closeDraw` (Closed; remainder released to the depositor's balance by reducing their `spent` via `postCredit`).
- Rules: `fundPrincipal` refused if `spent + principal + gasCeiling > amount`; a failed buy rolls the principal back and charges nothing.

## Queued spend (contract, keyed by id)

- `encDepositor: bytes` (same ciphertext scheme as `ownerRef`), `amount`, `dueAt`, `posted: bool`.
- Created by the operator in the settlement that incurs the spend; posted by the sweep via `postQueued(id, depositor)` once `now ≥ dueAt`. The contract requires `keccak(encDepositor)` to match the stored record and never stores the depositor before posting.
- Exit rule: `executeExit` is refused while any queued spend older than the exit request remains unposted, so the 24 hour delay always sees every posting.

## Balance (service view, not stored)

- `available = deposited − spent − Σ queued unposted spend decrypting to the depositor − Σ amount of open (Pending or Funded) draws whose ownerRef decrypts to the depositor`.
- Headroom: `min(cap − deposited, poolCap − totalDeposited)` reduced to allowed sizes.

## Withdrawal request (signed, transient)

- Fields: amount, destination, primary wallet, challenge envelope.
- Effects: operator pays destination from its wallet; `postSpend(depositor, amount)`; recorded in the response with both tx hashes; refused if amount > available.

## Campaign (extends Stage 1)

- Adds `draw` (amount, spent, remaining, dueAt, state).
- States as the trader sees them: Draft, Awaiting backup confirmation, Ready to activate, Funding your fleet, Active, Paused, Depleted, Expired, Revoked, Closed. "Funding your fleet" maps to Draw.Pending; Active requires Draw.Funded and an open session.

## Encryption helper

- Key: keccak256(`chit-fleet-ledger-v1|operatorKey`); AES-256-GCM with a random 12-byte nonce per ciphertext; plaintext is the 20-byte depositor address; output nonce‖ciphertext‖tag.

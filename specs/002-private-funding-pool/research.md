# Private Funding Pool — Research

Every decision below resolves an unknown in the plan's Technical Context. Facts
about the live Stage 1 come from `deployments/fleet-46630.json`, `IMPLEMENTATION.md`,
and the code; nothing here is invented.

## Decision: custody-relevant state lives on-chain, not in a service store

- **Decision**: Deposits, posted spend, caps, pause, exit requests, campaign
  draws, and pending-funding due times are contract state in a new `FleetPool`.
  The only off-chain fact, which depositor owns which draw, is stored on-chain
  too, as a ciphertext only the operator can open (see next decision). The
  service holds no durable state of its own.
- **Rationale**: The workspace law forbids new dependencies and the service is
  already stateless across Vercel function instances (Stage 1, 2026-09-06). A
  hosted KV or Postgres would need either an npm package or a Marketplace
  provisioning decision. The chain is the one durable store the project already
  has, and every custody invariant (FR-004, FR-011, FR-012) must hold on-chain
  anyway for the exit to be trustworthy.
- **Alternatives considered**: Upstash Redis over REST (no npm dependency, but a
  provisioning decision and a second source of truth for money); Neon Postgres
  from the hackathon project (needs a driver dependency); in-memory ledger
  (already failed in Stage 1's first live buy).

## Decision: the depositor-to-campaign mapping is encrypted to the operator, on-chain

- **Decision**: When a draw opens, the operator stores `enc(depositor)` beside the
  campaign key. Encryption is AES-256-GCM under a key derived by domain-separated
  keccak from the operator key already in the environment
  (`chit-fleet-ledger-v1|key`), the same pattern as Stage 1's challenge secret.
  Balance = deposits − posted spend − Σ open draws whose ciphertext decrypts to
  this depositor, computed by scanning open draws.
- **Rationale**: Durable without a store; unreadable to the public; recoverable
  by any service instance holding the operator key. Open draws on testnet number
  in the tens, so a scan per request is acceptable.
- **Alternatives considered**: plaintext owner in the draw (publishes the link;
  rejected, it is the Stage 1 flaw); a separate ledger secret (would be an
  invented secret; rejected); off-chain mapping (needs a store; rejected above).
- **Known limit**: the key cannot rotate without re-encrypting every open draw.
  Acceptable on testnet; recorded for the audit.

## Decision: spend is posted against the depositor in a separate transaction from the campaign-keyed one

- **Decision**: A buy issues a campaign-keyed transaction (move principal to the
  account, execute, commit gas and principal to the draw) and, in the same
  operation, queues a depositor-keyed posting on-chain as `queueSpend(encDepositor,
  amount, dueAt)` with a random 1 to 15 minute due time. The sweep later calls
  `postQueued(id, depositor)` after decrypting the reference. A withdrawal likewise:
  payout from the operator's wallet, then `queueSpend`. Decided at plan review
  2026-09-07, revising the clarify answer from same-settlement posting.
- **Rationale**: One transaction naming both depositor and campaign would publish
  the link (FR-009). Two transactions never share both identifiers, so the hard
  claim holds: no transaction joins them.
- **Residual**: amounts still match between the campaign-keyed and the
  depositor-keyed transactions; only the time pairing is weakened. Fixed draw
  sizes and batching are later mitigations. FR-015 discloses the residual. The
  24 hour exit delay guarantees every queued posting lands before an exit pays.

## Decision: withdrawals are paid from the operator's wallet, not from the pool

- **Decision**: Chit pays a signed withdrawal from the operator wallet to the
  destination. The pool reimburses the operator through `claimOperator`, which
  moves the aggregate of posted spend not yet claimed, naming no depositor.
- **Rationale**: A pool payout that names the depositor would publish depositor
  to destination, which defeats paying a fresh address.
- **Alternatives considered**: pool pays directly (rejected, publishes the link);
  fixed withdrawal sizes (helpful, offered as UI guidance, not enforced).

## Decision: pending funding is on-chain and swept by a cron plus every request

- **Decision**: `openDraw` records a `dueAt` chosen by the service (now + random
  1 to 15 minutes). A `sweep` operation funds every draw whose `dueAt` has
  passed: seed each account's gas headroom and open the session. Sweep runs from
  a Vercel Cron entry in `vercel.json` (no dependency) and opportunistically at
  the start of every fleet API request.
- **Rationale**: FR-007 requires funding to complete across redeployments without
  the trader; the due time is durable on-chain and any instance can fund it.
- **Confirmed 2026-09-07**: chit-tools is on Vercel Pro, so a per-minute cron
  (`* * * * *`) drives the sweep; the request-triggered sweep remains as belt and
  braces. The sweep also posts queued spend whose due time has passed.

## Decision: principal moves just in time, from pool to account, in the buy transaction

- **Decision**: `fundPrincipal(campaign, account, amount)` sends exactly the buy's
  principal to the account, the operator executes the approved call, and the
  draw commits principal plus gas. On failure the principal is returned to the
  pool in the same operation. Activation seeds a fixed gas headroom of
  0.0002 ETH per account (Stage 1's per-account gas) for value transfers the
  account itself makes.
- **Rationale**: Clarify answer; unspent draw never leaves the pool, so close
  returns it in full and fewer transfers exist to correlate.

## Decision: reuse Stage 1 contracts and service; retire the escrow for Stage 2 campaigns

- **Decision**: `FleetAccountFactory`, `FleetAccount`, and `FleetSessionPolicy`
  are reused unchanged. `FleetCampaignEscrow` is not used by Stage 2 campaigns;
  the pool takes over reservation, commit, and rollback semantics with draw
  accounting. The Stage 1 router grows a pool-backed chain adapter; the
  challenge, idempotency, redaction, and restore-from-chain patterns carry over.
- **Rationale**: The escrow's per-campaign owner is the leak. Everything else in
  Stage 1 is sound and tested.

## Decision: fixed sizes and caps as contract constants for testnet

- Deposit sizes 0.01, 0.05, 0.1 ETH; caps 0.5 / 0.2 / 5 ETH; exit delay 24 hours;
  gas headroom 0.0002 ETH per account. Constants in the contract for this
  deployment; a later network redeploys with its own.

## Decision: verification tags and test strategy

- New `verify.sh` tags: `pool-foundation` (contract fork tests, ledger math,
  ciphertext round-trip), `pool-balance` (deposit, headroom, withdraw, exit),
  `pool-fund` (activate, delayed funding, just-in-time buy), `pool-control`
  (pause, close-to-balance, operator pause), `pool-acceptance` (observer
  unlinkability check over events, Stage 1 gates still green).
- Tests first, as in Stage 1. Fork tests run on the pinned 46630 fork.

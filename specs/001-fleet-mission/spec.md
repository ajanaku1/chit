# Feature Specification: Fleet Mission

**Feature Branch**: `001-fleet-mission`

**Created**: 2026-08-28

**Status**: Ready for planning

**Input**: Approved Fleet Mission design for a private gas-budget manager for an individual meme trader.

## User Scenarios & Testing

### User Story 1 - Create and activate a private fleet (Priority: P1)

An eligible individual trader connects a primary wallet, reviews the published CHIT threshold and fee terms, configures a 5–50-account campaign, saves the recovery vault, funds ETH, and activates the fleet.

**Why this priority**: A safe, non-custodial fleet with explicit fee and recovery commitments is the foundation for every sponsored trade.

**Independent Test**: A clean eligible account creates and activates a five-account campaign after recovery confirmation and funding, while an ineligible account cannot create one.

**Acceptance Scenarios**:

1. **Given** an eligible connected wallet, **When** it reviews and confirms the campaign, **Then** it sees the published CHIT threshold, base fee, configured discount, net fee, and a distinct five-account fleet.
2. **Given** a campaign without recovery confirmation, **When** the trader tries to fund or activate it, **Then** the action is blocked until the encrypted recovery vault is downloaded and confirmed.
3. **Given** an ineligible connected wallet, **When** it attempts campaign creation, **Then** creation is blocked without changing campaign or sponsorship state.

---

### User Story 2 - Run a bounded sponsored buy (Priority: P2)

An active trader uses the dashboard or small SDK to request the one permitted token-buy action from fleet accounts while the campaign enforces the approved router, maximum trade value, gas budgets, chain, and expiry.

**Why this priority**: It demonstrates the product promise: five public buys can share sponsorship without publishing the primary-to-fleet relationship.

**Independent Test**: An active five-account campaign completes one permitted sponsored buy per account; each token balance changes, native ETH on the accounts is not charged, and the campaign ETH budget changes by the correct amount.

**Acceptance Scenarios**:

1. **Given** an active campaign with enough ETH budget, **When** the SDK submits the approved buy from five accounts, **Then** all five permitted buys are sponsored and aggregate results appear in Control Room.
2. **Given** a request outside the campaign policy, **When** the SDK submits it, **Then** it is rejected before sponsorship.
3. **Given** the public activity, **When** an observer inspects it, **Then** accounts, trades, amounts, timing, gas, and shared paymaster are visible but no primary-wallet-to-fleet edge is published.

---

### User Story 3 - Control campaign risk and recover budget (Priority: P3)

A trader monitors aggregate campaign state and budget, pauses or revokes sponsorship, resumes only a paused campaign, and closes a terminal campaign to recover unused ETH.

**Why this priority**: The trader must retain immediate control of a finite gas budget and never lose the ability to stop sponsorship.

**Independent Test**: A trader pauses and resumes a campaign, revokes another campaign, observes a later request reject, and closes it to recover its unused ETH.

**Acceptance Scenarios**:

1. **Given** an active campaign, **When** the trader pauses it, **Then** sponsorship is blocked until the trader resumes it.
2. **Given** a revoked campaign, **When** the trader attempts resume or session-key rotation, **Then** both are rejected; Close is the only remaining action and a new campaign is required to continue.
3. **Given** a closed campaign with unused ETH, **When** the owner closes it, **Then** the unused campaign budget is returned to that owner.

### Edge Cases

- Reloading Draft or Activating resumes the same campaign without duplicate accounts, session keys, or funding reservations.
- A campaign becomes Depleted when its remaining ETH cannot fund a permitted request and becomes Expired at its configured expiry; neither state permits sponsorship.
- Funding or activation failure leaves the campaign resumable at the last safe state and preserves the recovery requirement.
- The recovery vault warning states that lost local authorization plus the downloaded vault prevents owner-credential recovery.
- Closing, pausing, revoking, expiration, and depletion reject new sponsored requests; only Paused can resume.

## Clarifications

### Session 2026-08-28

- No critical unresolved product decisions: the approved design and parent constraints settle the product scope, privacy boundary, fee disclosure, state model, and testnet-only demo.

### Session 2026-08-30 — target chain

- The user redirected the feature to Robinhood Chain. The target is **Robinhood Chain testnet, chain 46630**; mainnet 4663 was considered and rejected for this MVP because it would put real ETH into an unaudited paymaster and escrow and would contradict FR-018.
- ERC-4337 EntryPoint v0.7.0 and the Uniswap v4 Universal Router were confirmed deployed on 46630 by direct `eth_getCode` before this clarification was recorded; the verified table is in [research.md](research.md).
- FR-017's exclusion of Robinhood Nox is unchanged and is now verified rather than assumed: iExec Nox supports only Arbitrum Sepolia and Arbitrum mainnet, so it does not run on Robinhood Chain. The existing Ethereum Sepolia Nox proof does not move.

## Requirements

### Functional Requirements

- **FR-001**: The product MUST serve one individual meme trader per campaign and allow creation of 5–50 newly generated smart accounts; the demo MUST use five accounts.
- **FR-002**: The product MUST read the primary wallet's mainnet CHIT balance at campaign creation, block an ineligible wallet, and perform no CHIT write or sponsorship-budget conversion.
- **FR-003**: Before campaign creation, Access and campaign review MUST show the published CHIT threshold, base service fee, configured CHIT discount, and resulting net service fee.
- **FR-004**: The trader MUST set a campaign name, account count, expiry, per-account and total gas budgets, one approved router and buy function, and maximum trade value before activation.
- **FR-005**: Each fleet account MUST have a distinct owner credential generated locally; no imported or custodial key is accepted.
- **FR-006**: Owner credentials and the downloaded recovery vault MUST remain locally encrypted, require recovery-vault confirmation before funding or activation, never be uploaded, and never appear as plaintext in API traffic, logs, or persistent storage; only its commitment reaches the service.
- **FR-007**: A campaign MUST use one session key bound to its campaign, chain, generated accounts, approved router and function, maximum trade value, gas budgets, and expiry.
- **FR-008**: The session policy MUST reject arbitrary asset transfers, ownership changes, gas withdrawal, key authorization, and calls to unapproved contracts.
- **FR-009**: The campaign ETH sponsorship budget MUST remain separate from CHIT holdings and debit only the budget attributable to permitted sponsored requests.
- **FR-010**: The dashboard and SDK MUST support the one approved token-buy action on the supported testnet and provide aggregate Control Room reporting.
- **FR-011**: Public information MUST include fleet accounts, trades, amounts, timing, gas, and shared paymaster activity, while no public primary-wallet-to-fleet relationship is published; the operator knows that relationship in MVP.
- **FR-012**: A campaign MUST follow Draft, Awaiting recovery confirmation, Awaiting funding, Activating, Active, Paused, Revoked, Depleted, Expired, and Closed states.
- **FR-013**: Revoked MUST be terminal for sponsorship: it cannot resume or rotate a session key, Close is its only remaining action, and further activity requires a new campaign.
- **FR-014**: Reload and retry MUST resume Draft or partial activation idempotently without duplicate accounts, session keys, or funding reservations.
- **FR-015**: Pause, revocation, depletion, expiry, and closure MUST block sponsored execution; only Paused may resume.
- **FR-016**: Close MUST return unused campaign ETH to the campaign owner and prevent subsequent sponsored execution.
- **FR-017**: The product MUST exclude imported keys, custody, sells, limit/copy trading, P&L, charts, Telegram, mobile, arbitrary calls, hidden trades, operator-blind attribution, unsupported mainnet sponsorship, Robinhood Nox, staking, revenue, buybacks, a new token, manufactured volume, and market manipulation.
- **FR-018**: The product MUST keep the demo testnet-only on Robinhood Chain testnet (chain 46630) and must not present mainnet sponsorship, a competition track, judging criteria, deadline, quota, or disqualification condition as established fact. It MAY route the demo buy through a real router deployed on that testnet when chain evidence verifies it, but MUST NOT describe testnet activity as a production integration.

### Key Entities

- **Campaign**: A trader-controlled fleet, its state, policy, fee disclosure, ETH budget, and lifecycle controls.
- **Fleet account**: A newly generated smart account with a distinct local owner credential and one campaign relationship.
- **Recovery vault**: Downloaded encrypted recovery material associated with a campaign's locally protected owner credentials.
- **Session policy**: The bounded authorization for one campaign's approved sponsored buy activity.
- **Campaign budget**: ETH reserved for permitted sponsorship and returnable when the campaign closes.
- **Fee disclosure**: Published threshold, base fee, configured CHIT discount, and net service fee shown before a transaction.

## Success Criteria

### Measurable Outcomes

- **SC-001**: An eligible clean test account can create, recover, fund, and activate a five-account campaign in one guided journey.
- **SC-002**: An ineligible primary wallet is blocked before a campaign, account, or budget is created.
- **SC-003**: A five-account demo completes one permitted sponsored buy per account, changes all five token balances, and charges none of the accounts' native ETH.
- **SC-004**: The campaign budget debit equals the sponsored cost attributed to the five permitted buys and no additional campaign budget is consumed.
- **SC-005**: An eligible campaign's charged service fee equals its displayed base service fee minus its configured CHIT discount.
- **SC-006**: Every request that violates the session policy, campaign state, gas budget, trade cap, approved router/function, or expiry is rejected.
- **SC-007**: Reloading Draft or partial activation produces no duplicate fleet account, session key, or funding reservation.
- **SC-008**: Local recovery material decrypts only through primary-wallet authorization, and a review of API, logs, and persistent storage finds no plaintext owner credential.
- **SC-009**: Public demo inspection shows shared paymaster activity and no published primary-wallet-to-fleet relationship; it does not claim fleet-wide unlinkability.
- **SC-010**: Pause and revoke block further sponsored execution, a revoked campaign cannot resume or rotate a session key, and closing returns its unused ETH.

## Assumptions

- The trader controls a primary wallet with access to its signing capability and can retain the downloaded recovery vault.
- Published CHIT threshold and fee values are configuration inputs and are displayed rather than invented by this feature.
- Exact testnet provider, router, EntryPoint, and swap-venue evidence are implementation dependencies; an unavailable verified venue uses a clearly labelled test-only fixture without a production claim. As of 2026-08-30 the provider, EntryPoint, and router are verified on chain 46630, while the Fleet paymaster and the demo venue token are not yet deployed and remain labelled doubles.
- This is a user-selected product direction, not a current judged competition; no track, judges, deadline, quota, or disqualification facts are supplied.
- Any design mention of eligibility renewal is deferred outside MVP; MVP checks eligibility at campaign creation only.

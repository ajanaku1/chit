# Feature Specification: Gas Sponsorship for Dapps (draft, not approved)

**Feature Branch**: none yet · **Created**: 2026-09-15 · **Status**: proposal; spike run on a fork the same day (see design.md, "Spike result")
**Input**: `proposals/gas-sponsorship-2026-09-15/design.md`

## User Scenarios & Testing

### User Story 1 — A dapp funds a budget and its users transact without ETH (Priority: P1)

A dapp registers as a sponsor, sets which of its contracts and functions Chit
may sponsor, funds a budget, and from then on any qualifying user of the dapp
can send a transaction from a smart account that holds no ETH. The cost, plus
Chit's fee, is settled against the sponsor's budget inside the same operation.

**Why this priority**: it is the whole product; nothing else here has value
without it.

**Independent test**: a throwaway smart account with zero ETH executes a call
to an allowed target through the dapp's flow; the account still holds zero ETH
afterwards; the sponsor's budget fell by cost plus fee; the transaction is on
chain.

**Acceptance scenarios**:
1. Given a registered, funded sponsor and an allowed target and selector, when
   a user with zero ETH submits an operation within the ceilings, then it is
   sponsored, mined, and the budget falls by actual cost plus fee.
2. Given a target or selector not in the sponsor's policy, when sponsorship is
   requested, then it is refused before any signature, with the reason.
3. Given a user who has reached the per-user daily cap, when they request
   another sponsorship the same day, then it is refused; the next day it is
   not.
4. Given a sponsor whose budget cannot cover the operation's ceiling, when
   sponsorship is requested, then it is refused before any signature.

### User Story 2 — The sponsor sees where the budget goes and can stop it (Priority: P2)

The sponsor's dashboard shows spend by day, by target and by user hash,
remaining budget, and every sponsored transaction; the sponsor can pause
sponsorship in one action and close to recover the unspent budget.

**Independent test**: after ten sponsored operations the dashboard lists ten
hashes whose costs sum to the budget's decrease; pause refuses the eleventh;
close returns the remaining budget to the payout address.

### User Story 3 — Chit proves the path on itself first (Priority: P1)

The fleet app sponsors its own users' buys through the same route, on testnet,
with the venue token, before any outside sponsor is onboarded.

**Independent test**: one pooled buy is sponsored through `/api/sponsor`
rather than the operator's direct execute, and the hashes are recorded in
`deployments/fleet-46630.json` under `sponsorship`.

### Edge cases
- The sender is an EOA and the chain does not support EIP-7702: refused with
  a reason that names the requirement.
- Two requests for the same user land on two instances in the same second:
  the daily cap is enforced from the shared ledger, not instance memory.
- Gas price rises between signing and inclusion: the reservation is the
  ceiling; the operation fails to sponsor rather than overspend.
- The sponsor pauses while operations are signed but not yet mined: those
  operations are within their validity window and still settle; new ones are
  refused.

## Requirements

- **FR-001**: A sponsor MUST be able to register with a signed request, naming
  a payout address, and MUST be identified by a sponsor id that never appears
  in any user-facing surface.
- **FR-002**: A sponsor's policy MUST list allowed target contracts and
  function selectors, a maximum cost per operation, a maximum per user per
  day, and a maximum per sponsor per day; the service MUST refuse sponsorship
  outside any of them before signing anything.
- **FR-003**: A sponsor MUST fund its budget by a transaction from its own
  wallet into an escrow keyed by the sponsor id; the escrow MUST reserve the
  ceiling before an operation and commit the actual cost plus fee after it,
  atomically within the EntryPoint flow, as `FleetCampaignEscrow` and
  `FleetPaymaster` do for fleets today.
- **FR-004**: The `/api/sponsor` route MUST accept the operation's fixed
  fields and the sponsor id, run every FR-002 check, and return
  `paymasterAndData` carrying the operator's signature and a validity window
  of at most 10 minutes; it MUST NOT require the user to sign in to Chit.
- **FR-005**: Per-user and per-sponsor daily caps MUST be enforced from a
  ledger shared by every service instance, keyed by sponsor, a hash of the
  user address, and the UTC day.
- **FR-006**: Chit's fee MUST be a published percentage of the actual gas
  cost, committed in `postOp` with the cost; there MUST be no other charge.
- **FR-007**: A sponsor MUST be able to pause and resume sponsorship and to
  close, and close MUST return the unspent budget to the payout address and
  nothing else.
- **FR-008**: The sponsor dashboard MUST show spend by day, by target and by
  user hash, remaining budget, and the transaction hash of every sponsored
  operation; it MUST never show a user's address in clear.
- **FR-009**: Chit MUST hold no funds of any user; only sponsor budgets, and
  only in the escrow.
- **FR-010**: The product MUST stay on testnet 46630 and MUST NOT sponsor
  calls to any target outside the sponsor's list, whatever the request says.
- **FR-011**: A CHIT discount on the fee, if offered, MUST apply to the
  sponsor only and MUST require nothing from any user; no user address MAY
  be associated with a CHIT balance by this feature.

## Success Criteria

- **SC-001**: A smart account with zero ETH completes an allowed call through
  the sponsored path on 46630 and still holds zero ETH afterwards.
- **SC-002**: For every sponsored operation, the sponsor's budget falls by
  exactly the actual gas cost plus the published fee, and never by the
  reservation ceiling.
- **SC-003**: 100% of requests outside the policy (target, selector,
  per-operation ceiling, daily caps, budget) are refused before a signature.
- **SC-004**: Daily caps hold across two service instances receiving requests
  for the same user in the same minute.
- **SC-005**: Pause refuses new sponsorship within one request; close returns
  the unspent budget in one transaction.
- **SC-006**: The fleet app's own buys run through the sponsored path on
  testnet before any external sponsor is registered.

## Assumptions
- ERC-4337 EntryPoint v0.7.0 on 46630, as recorded in the deployment file.
- Chit submits `handleOps` itself; no public bundler is assumed.
- Sender type on 46630: a smart account from the canonical SimpleAccount v0.7
  factory, which is live on the chain, deployed by its first sponsored
  operation (spike, 2026-09-15, on a fork). EIP-7702 EOAs are not assumed
  until tested.
- The sponsor escrow and paymaster are fresh deployments: the fleet escrow
  deployed on 2026-08-31 predates the settler role the paymaster needs.
- The fee (FR-006) is a percentage of the cost the EntryPoint reports to
  `postOp`, which the spike measured at 95% to 98.5% of the operator's real
  outlay; the published percentage must clear that gap before it is revenue.

## Out of scope
Any change to the funding pool; mainnet; user token gating; sponsoring
arbitrary calls; a public bundler; invoicing outside the escrow.

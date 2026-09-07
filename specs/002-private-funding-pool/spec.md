# Feature Specification: Private Funding Pool

**Feature Branch**: `002-private-funding-pool`

**Created**: 2026-09-07

**Status**: Draft

**Input**: User description: "Chit Fleet Stage 2: private funding pool. The trader deposits ETH into a shared, unkeyed pool; the operator funds both the gas and the trade principal for the trader's fleet accounts from that pool and settles against a per-campaign budget in the operator's ledger, so the primary-wallet-to-fleet relationship is never published on chain. Refunds go to an owner-signed address. Semi-custodial: per-campaign and pool caps, operator pause, an owner withdrawal path independent of the service, and an audit before mainnet. Builds on the live Stage 1. Claims discipline: private, not anonymous; never untraceable."

Source of truth for experience decisions: the approved `design-stage2.md` (2026-09-06).

## User Scenarios & Testing

### User Story 1 - Hold a Chit balance (Priority: P1)

A trader connects the primary wallet, opens Balance, picks a fixed deposit size within the shown headroom, and confirms one deposit transaction into the shared pool. The deposit names no campaign. The balance updates when the deposit confirms. The trader can later withdraw part or all of the balance to an address they sign for, and can always see the self-serve exit that works without Chit.

**Why this priority**: the balance is the concept the whole stage rests on; without it nothing else can be funded privately.

**Independent Test**: deposit a fixed size, see the balance and remaining headroom, withdraw to a fresh address, and confirm on the public chain that the deposit carries no campaign identifier.

**Acceptance Scenarios**:

1. **Given** a connected wallet with no balance, **When** the trader picks 0.05 ETH and confirms, **Then** the chain shows one transfer from the wallet to the pool with no campaign identifier and the Balance page shows 0.05 ETH held.
2. **Given** a balance at the per-trader cap, **When** the trader opens Deposit, **Then** every size is disabled with the reason shown and no transaction is offered.
3. **Given** a balance of 0.05 ETH, **When** the trader signs a withdrawal of 0.03 ETH to a fresh address, **Then** Chit pays that address within the promised time, shows the transaction, and the balance reads 0.02 ETH.
4. **Given** a trader whose deposit exceeds the operator's posted spend for them, **When** Chit is unreachable, **Then** the trader can trigger the contract exit and receive the unspent deposit after the fixed delay.

---

### User Story 2 - Fund a fleet from the balance and trade (Priority: P2)

A trader creates a fleet as in Stage 1 (size, backup, confirm), then activates it with a draw from the balance within the campaign cap. The app shows "Funding your fleet" with the delay range; after a random delay the pool funds the fleet accounts, the session opens, and the campaign is Active. A sponsored buy spends principal from the fleet account and gas from the operator, both settled against the draw. No transaction joins the trader's wallet to any fleet account.

**Why this priority**: this is the claim the stage exists to make true.

**Independent Test**: with a funded balance, activate a five-account fleet with a 0.02 ETH draw, wait through the delay, run one buy, and confirm on chain that the fleet was funded by the pool and that no transaction links the trader's wallet to the fleet.

**Acceptance Scenarios**:

1. **Given** a balance of 0.05 ETH and a confirmed fleet, **When** the trader activates with a 0.02 ETH draw, **Then** the campaign shows "Funding your fleet" with the delay range and becomes Active between 1 and 15 minutes later with every fleet account funded by the pool.
2. **Given** an Active campaign, **When** the SDK runs one permitted buy from a fleet account, **Then** the account receives the token, the principal and the gas are debited from the draw, and the trader's wallet made no transaction.
3. **Given** a balance of 0.01 ETH, **When** the trader tries a 0.02 ETH draw, **Then** activation is refused before any transaction with a pointer to Balance.
4. **Given** a campaign whose draw is used up, **When** the trader tops the draw up from balance, **Then** the campaign returns to Active without a new deposit.

---

### User Story 3 - Control the campaign and get money back privately (Priority: P3)

The trader pauses, resumes, revokes, or closes a campaign from the Control Room. Close credits the unspent draw back to the balance, publishing nothing. Money only leaves Chit through a withdrawal the trader signs or the self-serve exit.

**Why this priority**: recovery paths are what make custody acceptable, but they are exercised after the first two stories work.

**Independent Test**: close an Active campaign and confirm the balance rose by the unspent draw with no public refund; pause and confirm a buy is refused.

**Acceptance Scenarios**:

1. **Given** an Active campaign with 0.012 ETH unspent draw, **When** the trader closes it, **Then** the balance rises by 0.012 ETH, the campaign is Closed, and no transfer to the trader's wallet appears on chain.
2. **Given** a Paused campaign, **When** a buy is requested, **Then** it is refused and nothing is spent.
3. **Given** the operator has paused the pool, **When** the trader opens Balance or activates, **Then** the app says the pool is paused and offers the self-serve exit.

---

### Edge Cases

- A deposit confirms while the pool cap is reached by others: the contract refuses it and the wallet keeps its ETH; the app explains why.
- Spend is queued in the settlement and posted within 15 minutes, so an exit request always sees every posting by the time its 24 hour delay ends; any spend left unposted after that is the operator's loss, never the trader's.
- Principal moved to a fleet account for a buy that then fails: the buy is rolled back and the principal is returned to the pool in the same settlement, so the draw is not charged.
- The random funding delay elapses while the service is redeployed: funding still completes because the pending draw is durable, not held in one process.
- A trader deposits, then never activates: the balance stays withdrawable indefinitely; no fee accrues.
- Two activations race on one balance: at most one may exceed the remaining balance; the second is refused.
- A withdrawal to the trader's own main wallet: allowed, with a visible warning that it recreates the public link.

## Clarifications

### Session 2026-09-06 — approved design (design-stage2.md)

- Deposit path: the main wallet deposits directly into the shared pool; no fresh-wallet hop in this stage.
- Balance model: one trader account per primary wallet; campaigns draw from it; leftovers stay.
- Withdrawal: Chit pays promptly on a signed request; a delayed self-serve contract exit (24 hours) works with Chit offline.
- Deposit sizes: fixed denominations only (testnet 0.01, 0.05, 0.1 ETH).
- Caps, contract-enforced: per-trader balance 0.5 ETH, per-campaign draw 0.2 ETH, whole pool 5 ETH.
- Timing: deposit and activation are separate; fleet funded at activation after a random 1 to 15 minute delay, shown honestly.
- Journey: wallet-first (Balance area plus fleets that draw from it).

### Session 2026-09-07 — clarify

- Q: When a campaign activates, how much of its draw should the pool move into the fleet accounts, and when? → A: Just in time: activation opens the session and seeds each account with a small gas headroom; each buy moves that buy's principal from the pool to the account immediately before executing. Unspent draw never leaves the pool.
- Q: What counts as the operator's posted spend that the self-serve exit subtracts from a trader's deposit? → A: Buy principal, gas, and any withdrawal Chit already paid: everything that has actually left the pool for this trader.
- Q: How promptly must the operator post a trader's spend to the pool contract? → A: Queued in the same settlement and posted against the depositor after a random 1 to 15 minute delay (plan review 2026-09-07 revised the earlier same-settlement answer to weaken time pairing; the 24 hour exit delay covers the gap).

## Requirements

### Functional Requirements

- **FR-001**: The product MUST accept ETH deposits into one shared pool from any primary wallet, in fixed sizes only, and the deposit MUST carry no campaign or fleet identifier.
- **FR-002**: The product MUST keep one balance per primary wallet, credited by that wallet's confirmed deposits and debited by campaign draws, withdrawals, and posted spend.
- **FR-003**: Before any deposit is offered, the product MUST show remaining headroom against the per-trader balance cap and the pool cap and MUST refuse a size that would breach either, so no deposit is sent to be bounced.
- **FR-004**: The pool MUST enforce a per-trader balance cap of 0.5 ETH, a per-campaign draw cap of 0.2 ETH, and a whole-pool cap of 5 ETH on testnet, refusing any deposit or draw beyond them regardless of what the app shows.
- **FR-005**: Activating a campaign MUST take a draw from the trader's balance within the campaign cap and the available balance; a short balance MUST be refused before any transaction, with a pointer to Balance.
- **FR-006**: After activation, and after a random delay of 1 to 15 minutes, the pool MUST seed every fleet account of the campaign with a fixed gas headroom of 0.0002 ETH and the session MUST open; the app MUST show the "Funding your fleet" state with that range until the campaign is Active. Trade principal MUST NOT move at activation.
- **FR-007**: A pending draw MUST survive service restarts and redeployments; funding MUST complete without the trader acting again.
- **FR-008**: A sponsored buy MUST move exactly that buy's principal from the pool to the fleet account immediately before execution, spend gas from the operator, and settle principal plus gas against the campaign's draw in the same operation; a buy that would exceed the remaining draw MUST be refused before any principal moves, and unspent draw MUST never leave the pool.
- **FR-009**: No transaction on the public chain MAY join a trader's primary wallet to any fleet account of that trader's campaign; the only public facts are deposits into the pool, fleet funding from the pool, and fleet activity.
- **FR-010**: The trader MUST be able to withdraw any part of the balance to an address they sign for; Chit MUST pay within 10 minutes on testnet and show the transaction; the form MUST warn when the destination is the depositing wallet.
- **FR-011**: The trader MUST be able to recover their deposit minus posted spend directly from the pool, without Chit, after a fixed delay of 24 hours from the request. Posted spend MUST be everything that has left the pool for that trader: buy principal, gas, and withdrawals Chit has paid.
- **FR-012**: The operator MUST queue each trader's spend in the same settlement as the buy or withdrawal that incurs it and post it against the depositor, without naming any campaign or fleet account, after a random delay of 1 to 15 minutes; a queued posting MUST survive service restarts and MUST be posted before any exit for that depositor can pay out. The operator MUST be able to pause the pool; a paused pool accepts no deposits, draws, or buys, and the app MUST say so and keep the exit visible.
- **FR-013**: Close MUST credit a campaign's unspent draw back to the trader's balance and MUST NOT transfer ETH to any wallet; a depleted campaign MUST be able to top up its draw from balance.
- **FR-014**: Campaign states MUST be Draft, Awaiting backup confirmation, Ready to activate, Funding your fleet, Active, Paused, Depleted, Expired, Revoked, and Closed, with Stage 1's rules for pause, resume, revoke, expiry, and terminal states unchanged.
- **FR-015**: The published claim MUST be limited to: the main wallet never funds the fleet; the chain shows a deposit into Chit and fleets funded by Chit with no transaction linking them; the operator can link them; amounts and timing may be guessed at while the pool is small. The product MUST NOT use "anonymous", "untraceable", or "no trail" without that qualification.
- **FR-016**: The product MUST stay on Robinhood Chain testnet (46630) with the test token only, MUST exclude mainnet, CHIT gating, batched funding windows, multi-asset deposits, ZK or view-key features, and any anonymity-set claim, and MUST present a professional audit as a gate before real funds.
- **FR-017**: Stage 1 behaviour that Stage 2 does not change (local key generation, encrypted recovery vault, session policy limits, redaction of secrets) MUST remain in force and its existing checks MUST stay green.

### Key Entities

- **Pool**: the shared contract holding all deposits; knows total held, per-depositor deposits, per-depositor posted spend, caps, and paused state; never knows campaigns.
- **Trader balance**: the operator's ledger of one primary wallet's deposits minus draws, withdrawals, and posted spend; the number the Balance page shows.
- **Draw**: a campaign's reserved share of a balance; has amount, spent, remaining; principal leaves it only per buy, just in time; the remainder returns to the balance on close.
- **Pending funding**: an activation waiting out its random delay; durable; completes without the trader.
- **Withdrawal request**: a signed instruction naming amount and destination; paid by Chit, recorded with its transaction.
- **Exit**: the contract-side recovery path; opens after the delay; pays deposit minus posted spend.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A trader completes deposit, fleet creation, activation, and one sponsored buy in one session with at most two wallet transactions (the deposit and the backup confirmation signature) and no other transaction from the primary wallet.
- **SC-002**: An independent observer reading every public event on 46630 for the demo cannot name the fleet accounts of the depositing wallet's campaign.
- **SC-003**: Every deposit or draw beyond a cap is refused on chain, and the app refuses it before a transaction is sent in 100% of attempts.
- **SC-004**: Every activation is funded between 1 and 15 minutes after the request, including across a service redeployment during the wait.
- **SC-005**: For each sponsored buy, the campaign's draw falls by exactly the principal plus the gas spent, the pool's posted spend for the trader rises by the same amount within 15 minutes, and the trader's balance and the pool's total agree with the sum of all draws, withdrawals, and posted spend.
- **SC-006**: A signed withdrawal is paid within 10 minutes and the paid amount matches the request.
- **SC-007**: With the service offline, a trader recovers deposit minus posted spend through the exit exactly at or after the 24 hour delay, and never more than that amount.
- **SC-008**: Closing a campaign raises the balance by the unspent draw and produces no transfer to any trader wallet.
- **SC-009**: Every published claim in the app, landing, and marketing matches FR-015 word for word in substance, and a review finds no "anonymous", "untraceable", or unqualified "no trail".
- **SC-010**: All Stage 1 verification checks remain green after Stage 2 lands.

## Assumptions

- The trader's primary wallet is the identity for the balance, authenticated by the same signed challenge Stage 1 uses.
- Fixed deposit sizes for testnet are 0.01, 0.05, and 0.1 ETH; sizes for any later network are a separate decision.
- The operator's ledger is authoritative for balances between deposits and posted spend; the pool contract is authoritative for caps, deposits, posted spend, and the exit.
- The random delay is chosen by the service, not the trader, and is not disclosed in advance beyond its range.
- Testnet ETH has no value; caps exist to prove the posture, not to protect capital.
- A withdrawal is a public transaction from the pool to the destination; choosing a fresh destination is the trader's decision.
- The existing Stage 1 contracts (fleet accounts, factory, session policy) are reused; the Stage 1 escrow is not used by Stage 2 campaigns.

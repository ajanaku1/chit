# Feature Specification: The capped mainnet beta on Robinhood Chain

**Feature Branch**: `003-mainnet-beta`

**Created**: 2026-09-20

**Status**: Draft

**Input**: Approved `design-mainnet-beta.md` (root, tracked alongside `design.md` and `design-stage2.md`), the mainnet-readiness review of 2026-09-19 rev2 and its verification addendum, and the runbook on `feat/mainnet-beta`.

## Clarifications

### Session 2026-09-20

- Q: How many failed or reverted buys should a single depositor be allowed before Chit stops accepting them? → A: Three failures per campaign, then a one-hour cooldown on that campaign only.
- Q: How far can an executed buy land from the quote the depositor accepted before it should be refused instead? → A: 1% by default, with a per-token override recorded in the registry entry.
- Q: How much liquidity must a token's pool hold before it can be listed in the beta? → A: At least 50x the draw cap, checked at listing and re-checked before launch.
- Q: How quickly does someone need to be told when the service fails at something that touches money? → A: Immediately for unrecoverable money, within 4 hours for an unrecorded charge, daily digest otherwise.
- Q: How long does the beta stay open before you decide whether to widen it, and what closes it early? → A: Open-ended until the firm audit lands; pause immediately on any depositor losing money, any charge expiring unrecorded, or any exit failing.
- Q: How fast must the pool be paused once a trigger fires? → A: Automatically where the trigger is machine-detectable; within 15 minutes of confirmation otherwise.
- Q: What has to be true before a paused pool can reopen? → A: The cause fixed, a test covering it, the pool made whole if it was short, and the account published to depositors.
- Q: When should the beta stop accepting withdrawals because the operator is owed too much? → A: Alert at half the operator's float, refuse through the existing path at the float itself.
- Q: What is the operator's float? → A: 0.2 ETH on the operator wallet for the 1 ETH pool cap, so the alert is at 0.1 ETH; read by the service and the monitor from one variable, `FLEET_OPERATOR_FLOAT_ETH`, never a constant in either (decided 2026-09-21).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Put real money in and be able to take it out (Priority: P1)

A CHIT holder connects their wallet at Chit, is told plainly what they are trusting and what the limits are, deposits real ETH within the caps, and can recover it. Recovery works two ways: through Chit, and directly from the pool without Chit's help after a fixed delay.

**Why this priority**: This is the whole risk of the beta. If a depositor cannot reliably get their money back, nothing else in the feature matters. It is also the smallest slice that is independently valuable: a pool that holds and returns real ETH under a cap is a working product even before anyone trades.

**Independent Test**: Deposit each offered size against the caps, request a withdrawal, and separately complete the no-Chit exit after the delay. Verify the amount returned matches the deposit minus what was actually spent.

**Acceptance Scenarios**:

1. **Given** a wallet holding at least the CHIT threshold, **When** it connects, **Then** the app opens with the beta note visible on the page.
2. **Given** a wallet below the threshold, **When** it connects, **Then** it is told how much it holds, how much is needed, where to get CHIT, and where the free testnet playground is, and it is not shown an error.
3. **Given** the balance read fails, **When** the gate is evaluated, **Then** the depositor is offered a retry and is never told they are rejected.
4. **Given** a depositor at the per-depositor cap, **When** they open the deposit form, **Then** no size is offered that would breach the cap, and the reason is shown before they act.
5. **Given** a depositor with unspent balance, **When** they request the direct exit and the fixed delay elapses, **Then** they recover their deposit minus posted spend without any action by Chit.
6. **Given** the pool is paused, **When** a depositor visits any page, **Then** the pause is stated and the exit remains reachable.

---

### User Story 2 - Trade a listed token without the buy tracing to the main wallet (Priority: P2)

The depositor opens a campaign, draws within the draw cap, the fleet is funded after a random delay, and they buy one of the listed tokens. No public transaction joins their main wallet to the fleet that made the buy.

**Why this priority**: This is the product's reason to exist, but it depends on P1 holding first. A beta that can hold and return money but cannot yet trade is embarrassing; one that trades but cannot return money is dangerous.

**Independent Test**: Run a campaign end to end against each listed token on a fork of mainnet, confirming the quote and the executed swap agree within the stated slippage bound, and that no single public transaction links the depositing wallet to a fleet account.

**Acceptance Scenarios**:

1. **Given** the token list, **When** the depositor opens the buy surface, **Then** only listed and enabled tokens are offered, and an unlisted token is absent rather than rejected.
2. **Given** a listed token whose pool carries a hook, **When** a quote is requested, **Then** the quote reflects that pool's real shape and fees.
3. **Given** a quote the depositor accepts, **When** the buy executes, **Then** the amount received is within the bound in force for that token, and the depositor was shown that bound before accepting.
4. **Given** a token listed but not enabled, **When** the buy surface is opened, **Then** it is not offered and no path exists to trade it.
5. **Given** a buy whose result is not observed because of an infrastructure failure, **When** the system reconciles, **Then** the depositor is charged if and only if the buy actually moved money.
6. **Given** a campaign whose last three buys each spent gas without completing, **When** a fourth is attempted, **Then** it is refused with the reason and the time it reopens, and the depositor's other campaigns are unaffected.

---

### User Story 3 - Be told the truth when Chit cannot pay right now (Priority: P2)

A depositor asks to withdraw at a moment when Chit cannot cover the payment. They are told so plainly, nothing is charged against them, and they are pointed at the path that does not need Chit.

**Why this priority**: Same priority as trading because it is the moment most likely to destroy trust. It is cheap to build and expensive to get wrong.

**Independent Test**: Force the paying account short, request a withdrawal, and confirm the refusal message, that nothing is owed afterwards, and that the direct exit is offered and works.

**Acceptance Scenarios**:

1. **Given** Chit cannot cover a requested withdrawal, **When** the depositor requests it, **Then** they are told plainly, offered a retry, and shown the exit.
2. **Given** such a refusal, **When** the depositor's balance is read afterwards, **Then** no charge has been recorded against them.
3. **Given** a withdrawal that is accepted, **When** it is paid, **Then** the depositor is charged once and only once for it.

---

### User Story 4 - Keep the free playground (Priority: P3)

Someone who is not a CHIT holder, or who wants to try before risking real money, uses the testnet pool as before at its own address.

**Why this priority**: It costs little and it protects people who are mid-campaign on testnet today, plus everyone who was publicly invited to try it. Not required for the beta to be valuable.

**Independent Test**: Visit the testnet address, run a campaign with test ETH, and confirm the real-money site never offers test funds and the test site never offers real ones.

**Acceptance Scenarios**:

1. **Given** the beta is live, **When** someone visits the testnet address, **Then** the ungated testnet experience works unchanged.
2. **Given** either site, **When** a page loads, **Then** it names the chain it is on and cannot be confused with the other.

### Edge Cases

- The CHIT threshold cannot be read because the data source is unavailable: the depositor is offered a retry, never a rejection.
- The pool reaches its cap mid-session: the deposit form stops offering sizes and says why, before a transaction is sent.
- A token's price moves between quote and execution by more than its bound: the buy is refused before it is sent, and because nothing was spent it does not count toward the campaign's three failures.
- A listed token's liquidity falls below fifty times the draw cap while the beta is live: the token stops being offered rather than offering a trade that will fail, and depositors holding it are unaffected.
- A transaction lands but its outcome is never observed: no depositor is charged for something that did not happen, and none is charged twice for something that did.
- A charge cannot be recorded against a depositor before its deadline: it must not be possible for the last depositor leaving to be unable to leave.
- The pool is paused while a depositor is mid-campaign: the pause is stated, the exit stays reachable, and no further money moves.
- A campaign hits its third gas-spending failure: further buys on it are refused for an hour, the depositor is told when it reopens, and their other campaigns keep working.
- A token is delisted while a depositor's fleet still holds it: no new buys are offered, and the depositor can still move what they hold.
- A trigger fires that cannot be detected automatically: an alert goes out immediately and the pause follows within fifteen minutes of someone confirming it.
- A depositor's withdrawal destination is the wallet they deposited from: they are warned that this undoes the separation they came for.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The beta MUST operate on Robinhood Chain mainnet with a whole-pool cap of 1 ETH, a per-depositor cap of 0.1 ETH, and a per-campaign draw cap of 0.05 ETH. These three figures are stated here and nowhere else in this specification. The pool MUST enforce them itself; the interface MUST NOT offer what they forbid; and the service MUST NOT attempt what they forbid. Enforcement by the pool is the one that decides.
- **FR-002**: Deposits MUST be offered in fixed sizes only, and a size that would breach either cap MUST NOT be offered. A deposit that was permitted when offered but would breach a cap by the time it arrives MUST be refused by the pool rather than partially accepted, and the depositor MUST be told the cap was reached rather than shown a failure.
- **FR-003**: Access to the beta interface MUST require holding at least a configured amount of CHIT, and that amount MUST be changeable without redeploying the product.
- **FR-004**: A wallet below the threshold MUST be shown what it holds, what is required, where to obtain CHIT, and where the free testnet alternative is; it MUST NOT be shown an error state.
- **FR-005**: A failure to read a wallet's holdings MUST result in a retry state, never a rejection.
- **FR-006**: The product MUST state on every page, in a form that cannot be closed, hidden or scrolled past, three facts independently, in words no weaker than "the pool is capped at 1 ETH", "the contracts have not been audited by a firm", and "Chit's operator key can move what is in the pool, up to that cap": that the beta is capped at 1 ETH, that the contracts have not been audited by a firm, and that Chit's operator can move what is in the pool up to that cap. Omitting any one of the three is a failure, not an edit.
- **FR-007**: The deposit surface MUST repeat that statement in full, adjacent to the amount being chosen.
- **FR-008**: The beta MUST NOT open until every published claim that a professional audit precedes mainnet has been corrected. The surfaces carrying that claim are the Stage 2 specification's FR-016, `README.md`, `ONBOARDING.md`, the community brief, and the landing page; any other surface found to carry it MUST be corrected too. The correction MUST be published before the beta opens, not in the same change that opens it.
- **FR-009**: A guardian able to pause the pool, and distinct from the operator, MUST be configured before the beta opens; deployment MUST refuse without one.
- **FR-010**: While paused, the product MUST say so on every page and MUST keep the no-Chit exit reachable.
- **FR-011**: Only tokens on an explicit registry MAY be traded; each entry MUST pin the exact pool it trades in, and an entry MAY be present but disabled.
- **FR-012**: Each registry entry MUST pass four checks before the beta opens, each recorded with its result and the date: ordinary transfer behaviour (a transfer moves exactly the amount sent, with no fee taken and no sender or recipient refused), absence of holder restrictions, a known pool configuration, and liquidity of at least fifty times the draw cap measured as the ETH side of the pool at the current price. The liquidity check MUST be repeated immediately before the beta opens, and a token that no longer meets it MUST NOT be offered.
- **FR-013**: Quotes MUST reflect the real shape and fees of the pool a token actually trades in, and a buy MUST be refused rather than executed when it would land more than 1% away from the quote the depositor accepted. A registry entry MAY record a different bound for its own token. The bound in force MUST be shown to the depositor as part of the quote they are accepting, expressed as the least they will receive, not only as a percentage.
- **FR-014**: A depositor MUST be charged for a buy if and only if that buy moved money, meaning the campaign's recorded spend increased on chain, and MUST be charged exactly once. Where the outcome of a transaction is not observed, the charge MUST be decided by reading the chain, never by interpreting the absence of an answer. A transaction that reverted on chain and one that never reached the chain MUST both leave the depositor uncharged, and MUST be distinguishable from each other in the record.
- **FR-015**: When the operator's balance cannot cover a requested withdrawal, Chit MUST refuse plainly before recording anything, MUST record no charge, MUST offer the no-Chit exit, and MUST allow the depositor to try again immediately.
- **FR-016**: Every withdrawal MUST end either paid or refused; none may remain owed. A withdrawal whose payment is sent but not observed MUST be resolved by reading the chain before any retry, and MUST NOT be paid twice.
- **FR-017**: A depositor MUST be able to recover their deposit minus what was actually spent, directly from the pool and without Chit's participation, twenty-four hours after requesting it.
- **FR-018**: It MUST NOT be possible for a depositor's exit to fail because a charge went unrecorded; the pool MUST remain able to pay everyone it owes. A charge MUST be recorded on chain within twelve hours of being incurred, after which it can no longer be recorded at all.
- **FR-019**: The free testnet experience MUST remain available at its own address, ungated, and each site MUST name the chain it is on.
- **FR-020**: The published privacy claim MUST remain limited to this: the main wallet never funds the fleet; the chain shows a deposit into Chit and fleets funded by Chit with no transaction linking them; the operator can link them; amounts and timing may be guessed at while the pool is small. The words "anonymous", "untraceable" and "no trail" MUST NOT appear without that qualification. Moving to mainnet MUST NOT strengthen any part of it. What FR-006 says the operator can do and what this requirement says the operator can see MUST be stated together wherever either appears.
- **FR-021**: Sponsored gas for third-party applications MUST remain off on mainnet for the beta.
- **FR-022**: Selling through Chit MUST remain out of the beta; sells stay with the depositor in the app.
- **FR-023**: Operational failures that affect money MUST raise an alert rather than passing silently, on three timescales. Immediately, where money has left and cannot be brought back by any action available to the operator. Within four hours, where a charge remains unrecorded and its deadline has not yet passed. In a daily summary, for everything else that touches money. A failure an implementer cannot classify MUST be treated as belonging to the faster class.
- **FR-024**: Every failure to record a charge MUST be counted and reported with its reason; a failure that leaves no trace is itself a defect.
- **FR-025**: The beta MUST remain at its stated caps until a professional audit is complete, meaning a report from an established auditing firm covering the deployed bytecode, whose findings have been addressed and whose report has been published. Widening the caps before that MUST NOT happen on the strength of the beta having run quietly.
- **FR-026**: The pool MUST be paused if any of three things happens: a depositor's recoverable balance falls below what they deposited less what was actually spent on their instruction (an unfavourable trade the depositor chose is not such a loss); a charge passes its deadline unrecorded; or an exit transaction fails. The product MUST say the pool is paused and keep the exit reachable. What MUST be published to depositors is which trigger fired, what is known about the cause, what it means for their money, and what has to be true before the pool reopens; it MUST appear wherever the beta was announced and on the product's own pages.
- **FR-027**: An independent observer with no access to Chit's systems MUST be able to verify, from the pool's public view functions and events alone, that the pool holds at least what it owes its depositors, and MUST be able to state the exact identity between what went in, what came out, and what is held.
- **FR-028**: A buy spends the operator's gas without completing when a transaction is sent and the campaign's recorded spend does not increase; a buy refused before any transaction is sent, including one refused for exceeding its slippage bound, is not such a failure and MUST NOT count. After three such failures within one rolling hour in one campaign, that campaign MUST stop accepting buys for one hour; the depositor's other campaigns MUST be unaffected, and the depositor MUST be told why and when they can try again.
- **FR-029**: The holders gate MUST be understood and described as an interface control only. The pool MUST NOT be given any knowledge of CHIT, and the product MUST state once, where a depositor will read it, that anyone interacting with the contract directly can deposit within its caps regardless of the gate.
- **FR-030**: The pool MUST reimburse the operator for withdrawals it has fronted, through the same claim by which it reimburses fronted gas. A full claim MUST NOT leave the pool unable to pay any depositor.
- **FR-031**: Rounding differences between what was spent and what is charged MUST fall to the operator, never to the pool's obligation to its depositors, and the product's own documentation MUST say so where it currently says the opposite.
- **FR-032**: When unreimbursed fronted withdrawals reach half the operator's float, an alert MUST be raised to claim and top up; at the float itself, withdrawals MUST refuse through the path in FR-015 rather than a second mechanism.
- **FR-033**: A charge MUST NOT be posted against a depositor for more than the deposit still backing it; the excess MUST fall to the operator.
- **FR-034**: A pause MUST follow its trigger automatically where the trigger is machine-detectable, and within fifteen minutes of confirmation where it is not.
- **FR-035**: A paused pool MUST NOT reopen until the cause is fixed, a test covers it, the pool has been made whole if it was short, and an account of what happened has been published to depositors.
- **FR-036**: The pool MUST be able to be made whole while paused, by a payment that credits no depositor.
- **FR-037**: A depositor MUST be able to exit while the pool is paused.
- **FR-038**: Delisting a token MUST stop new buys of it without affecting tokens already held; a depositor MUST retain the ability to move what their fleet accounts already hold.
- **FR-039**: The beta MUST NOT open until the product has soaked for at least forty-eight hours on testnet from the same code, with alerting on and no charge left unrecorded for more than four hours.
- **FR-040**: The decision to open the beta MUST rest on the acceptance outcomes in this specification being met, and MUST be recorded with the evidence for each. The rehearsal on a fork of mainnet passes when the deployed caps read back as specified, deployment without a guardian is refused, each listed token's quote and execution agree within its bound, the guardian can pause without the operator, and an exit completes while paused.
- **FR-041**: Depositor-facing copy MUST state that the caps remain until a professional audit is complete, and MUST NOT describe the caps in any way that implies an audit has happened.
- **FR-042**: Public announcements of the beta MUST state the same access conditions the product enforces.
- **FR-043**: Alerts MUST reach the operator through a channel the operator already monitors, and the receiving party MUST be named before the beta opens.

### Key Entities

- **Pool**: The single shared holding of real ETH, bounded by the whole-pool cap, from which draws are made and to which deposits return.
- **Depositor**: A wallet that has put ETH into the pool, holding a balance, an amount spent, and the right to exit.
- **Campaign**: A depositor's trading run, holding a draw within the draw cap and a set of fleet accounts.
- **Charge**: What a depositor owes for a buy or a withdrawal, recorded privately first and settled against them publicly later, in a form that does not name the campaign.
- **Token registry entry**: A token the beta may trade, pinned to the exact pool it trades in, with an enabled flag and the evidence of its checks.
- **Guardian**: A party, distinct from the operator, able only to pause the pool.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No depositor is charged for a buy that did not happen, and none is charged twice for one that did, across the whole beta.
- **SC-002**: Every depositor who asks to leave gets their money, whether or not Chit participates, within the stated delay.
- **SC-003**: Every withdrawal request ends paid or refused within the same session; none is left owed.
- **SC-004**: No charge against a depositor expires unrecorded during the beta.
- **SC-005**: The most a depositor can lose to a contract fault is bounded by the pool cap, and that bound is stated on every page they see before depositing.
- **SC-006**: Each listed token's executed buy lands within the bound in force for that token, verified against the real pool before the beta opens, and no buy executes outside it.
- **SC-007**: Every token offered at launch holds at least fifty times the draw cap in liquidity, confirmed on the day the beta opens.
- **SC-008**: A person who is not a CHIT holder can still use the product for free, and never mistakes which chain they are on.
- **SC-009**: An observer with only public data can confirm the pool holds at least what it owes.
- **SC-010**: Unrecoverable losses alert immediately, an unrecorded charge alerts within four hours of being incurred, and every other money-touching failure appears in a daily summary; no failure of any kind passes without a count and a reason.
- **SC-011**: No published sentence claims a professional audit precedes mainnet once the beta is open.
- **SC-012**: Each of the three pause triggers is rehearsed before the beta opens, and the guardian's pause takes effect without the operator's participation.
- **SC-013**: No campaign costs the operator more than three failed buys' worth of gas in any one-hour period, and no depositor is locked out by a refusal that spent nothing.
- **SC-014**: Every pause during the beta takes effect automatically or within fifteen minutes of confirmation, and every resume is preceded by a published account of what happened.
- **SC-015**: The operator is never owed more than its own float in fronted withdrawals without an alert having been raised first.
- **SC-016**: What the announcement says about who may deposit matches what the product enforces, on the day it opens.

## Assumptions

- The audience is existing CHIT holders who already trade on Robinhood Chain; the beta is not a first introduction to the chain.
- The caps, deposit sizes, guardian requirement and holders-only access are settled by the runbook agreed on 2026-09-16 and are not reopened here.
- Tokenized equities are assumed to carry legal questions beyond those of ordinary tokens, and are therefore present in the registry but disabled until that is resolved.
- The privacy properties are those of the existing Stage 2 claim; the pool being small means amounts remain guessable, and the beta does not claim otherwise.
- The trustless exit, already in force on testnet, is assumed to be the ultimate recovery path and must never depend on Chit being available.
- The correctness work identified by the 2026-09-19 review is a precondition of this feature rather than part of its user-visible scope.
- Two separate hosted environments, one per chain, are acceptable operationally.
- The beta has no fixed end date. It runs at its stated caps until a professional audit is complete, so "how long has it run without incident" is never by itself a reason to raise a cap.

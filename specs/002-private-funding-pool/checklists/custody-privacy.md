# Custody and Privacy Requirements Checklist: Private Funding Pool

**Purpose**: Unit-test the Stage 2 requirements for completeness, clarity, consistency, and measurability in the two areas that carry the risk: custody accounting and the privacy claim
**Created**: 2026-09-07
**Feature**: [spec.md](../spec.md)

**Note**: Items test the requirements text, not an implementation. Evaluated 2026-09-07 against spec.md after the clarify and plan-review sessions.

## Requirement Completeness

- [x] CHK001 Are all money movements named with a requirement: deposit, draw, principal per buy, gas, withdrawal payout, exit, close credit, top-up? [FR-001, FR-005, FR-008, FR-010, FR-011, FR-013]
- [x] CHK002 Is the source of every payout specified (pool vs operator wallet) so accounting can be checked? [FR-010 payout by Chit; plan: operator wallet; FR-011 pool]
- [x] CHK003 Is the operator's reimbursement for gas and payouts covered by a requirement or explicitly delegated? [Delegated to plan: `claimOperator`; spec SC-005 pool total invariant]
- [x] CHK004 Are cap values and the exit delay stated as numbers, not adjectives? [FR-004, FR-011]
- [x] CHK005 Is the gas headroom seeded at activation quantified? [FR-006 says "small fixed"; research fixes 0.0002 ETH] — spec now states the amount (fixed 2026-09-07)

## Requirement Clarity

- [x] CHK006 Is "posted spend" defined so that the exit amount is unambiguous? [FR-011 lists principal, gas, Chit-paid withdrawals]
- [x] CHK007 Is the timing of spend posting bounded with a number? [FR-012: 1 to 15 minutes]
- [x] CHK008 Is "no transaction links" stated precisely enough to test over events? [FR-009: no single transaction names both]
- [x] CHK009 Is the withdrawal destination warning distinguished from a refusal? [FR-010 warns, does not refuse]

## Requirement Consistency

- [x] CHK010 Do FR-008 (principal never leaves the pool unspent) and FR-013 (close credits full unspent draw) agree? [Yes after the just-in-time clarification]
- [x] CHK011 Do FR-011 (exit after 24 h) and FR-012 (posting within 15 min) guarantee the exit sees every posting? [Yes; edge case updated]
- [x] CHK012 Does SC-001's transaction count match the journey (deposit plus backup signature)? [Yes; activation is a signed request, not a wallet transaction]

## Acceptance Criteria Quality

- [x] CHK013 Is the unlinkability outcome testable by an observer with only public data? [SC-002 names the observer and the data]
- [x] CHK014 Are payout and funding time bounds measurable? [SC-004, SC-006]
- [x] CHK015 Is the accounting invariant stated as an equation-like check? [SC-005]

## Scenario and Edge Case Coverage

- [x] CHK016 Is behaviour specified when the pool is paused mid-journey? [US3 scenario 3, FR-012]
- [x] CHK017 Is a failed buy after principal moved covered? [Edge case: rollback in the same settlement]
- [x] CHK018 Is a race between two activations on one balance covered? [Edge case]
- [x] CHK019 Is an exit requested while spend is still queued covered? [Edge case and data model rule]
- [x] CHK020 Is the case of a deposit that never activates covered? [Edge case: withdrawable, no fee]

## Non-Functional and Dependencies

- [x] CHK021 Are the privacy claim words that are forbidden enumerated? [FR-015]
- [x] CHK022 Is the audit stated as a gate rather than a task? [FR-016]
- [x] CHK023 Is the dependency on Stage 1 contracts and the retirement of the escrow stated? [Assumptions]
- [x] CHK024 Is the residual correlation (amount, timing, operator) disclosed in the claim? [FR-015]

## Ambiguities and Conflicts

- [x] CHK025 Any remaining [NEEDS CLARIFICATION] markers? [None]
- [x] CHK026 Does any requirement still say spend is posted (not merely queued) in the same settlement after the plan review? [None; the three remaining "same settlement" mentions all describe queueing]

## Notes

- CHK005 found the one gap: FR-006 said "small fixed gas headroom" without a number. Fixed in spec.md to 0.0002 ETH per account.

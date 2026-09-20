# Money Safety Checklist: The capped mainnet beta

**Purpose**: Test whether the requirements around holding, charging, paying and returning real ETH are complete, unambiguous and consistent enough that no depositor or operator loses money to a gap in the specification itself
**Created**: 2026-09-20
**Feature**: [spec.md](../spec.md)

These items test the requirements, not the code. Each asks whether something is
specified well enough to be built and verified, not whether it works.

## Charging correctness

- [x] CHK001 Is "charged if and only if the buy moved money" defined precisely enough to distinguish a buy that reverted on chain from one that never reached the chain? [Clarity, Spec §FR-014 → closed by §FR-014]
- [x] CHK002 Are the requirements explicit about what happens to a charge when the transaction that would settle it is never observed, as opposed to observed failing? [Completeness, Spec §FR-014 → closed by §FR-014]
- [x] CHK003 Is there a stated requirement covering a charge recorded against a depositor whose deposit no longer covers it? [Gap, Spec §FR-014 → closed by §FR-033]
- [x] CHK004 Do the requirements state who bears a rounding difference between what was spent and what is charged? [Gap — the contract change moves this from the pool to the operator; the spec is silent → closed by §FR-031]
- [x] CHK005 Is the deadline by which a charge must be recorded stated as a requirement, or does it exist only as a property of the contract? [Completeness, Spec §FR-018 → closed by §FR-018]
- [x] CHK006 Are the requirements consistent about a charge's visibility: FR-014 speaks of charging exactly once, while the privacy requirements constrain when and how a charge may appear publicly? [Consistency, Spec §FR-014, §FR-020 → closed by §FR-020]

## Paying and returning

- [x] CHK007 Is "cannot pay right now" defined by an observable condition, or left to the implementer to decide when to refuse? [Measurability, Spec §FR-015 → closed by §FR-015]
- [x] CHK008 Do the requirements state whether a refused withdrawal may be retried immediately or must wait? [Gap, Spec §FR-015 → closed by §FR-015]
- [x] CHK009 Is there a requirement covering a withdrawal that is paid but whose confirmation is never seen? [Completeness, Spec §FR-016 → closed by §FR-016]
- [x] CHK010 Is the fixed delay before a no-Chit exit stated as a duration in the requirements, rather than referenced as "the fixed delay"? [Clarity, Spec §FR-017 → closed by §FR-017]
- [x] CHK011 Do the requirements say what a depositor recovers when the pool holds less than it owes? [Gap, Spec §FR-018 → closed by §FR-036]
- [x] CHK012 Is it specified whether an exit can be made while the pool is paused? [Consistency, Spec §FR-010, §FR-017 — FR-010 says the exit stays reachable, FR-017 does not qualify → closed by §FR-037]

## Operator solvency

- [x] CHK013 Do the requirements state that the operator is reimbursed for withdrawals it fronts, or is that left implicit in the contract change? [Gap — the whole of M2 appears nowhere in the functional requirements → closed by §FR-030]
- [x] CHK014 Is there a requirement bounding how much the operator can be owed before the beta must stop accepting new withdrawals? [Gap → closed by §FR-032]
- [x] CHK015 Are the requirements clear that a full operator claim can never leave the pool unable to pay an exit? [Completeness, Spec §FR-018 → closed by §FR-030]
- [x] CHK016 Is the three-failure bound expressed in terms an implementer can measure identically to a reviewer: what exactly counts as "spending gas without completing"? [Measurability, Spec §FR-028 → closed by §FR-028]

## Caps and limits

- [x] CHK017 Are the caps stated once as requirements and not restated elsewhere with different numbers? [Consistency, Spec §FR-001 → closed by §FR-001]
- [x] CHK018 Is it specified what happens to a deposit that would breach the pool cap because another deposit landed first? [Gap, Spec §FR-002 → closed by §FR-002]
- [x] CHK019 Do the requirements state whether caps are enforced against the interface, the service, the contract, or all three? [Clarity, Spec §FR-001 → closed by §FR-001]
- [x] CHK020 Is the relationship between the slippage bound and the failure bound specified, so a token whose bound is routinely exceeded does not silently consume a campaign's three failures? [Consistency, Spec §FR-013, §FR-028 → closed by §FR-028]

## Notes

- Check items off as completed: `[x]`
- An item that fails means the spec needs a sentence, not that the code is wrong
- CHK004 and CHK013 are known gaps carried deliberately from `research.md`; both
  concern the operator's side of the contract change and neither appears in the
  functional requirements today

## Outcome

All 20 items closed on 2026-09-20 by amending the specification, not by
reinterpreting them. Nine needed a new requirement; eleven needed an existing one
made exact.

The three findings that mattered:

- **The operator's reimbursement was invisible.** The decision to change the
  contract so the pool repays fronted withdrawals appeared in the plan and the
  contract design, and in no requirement. Nothing would have failed if it had
  been silently dropped. Now FR-030.
- **Rounding had no owner.** With `claimable()` redefined as a surplus, the grain
  falls to the operator, while `pool-buy.ts` still says it is the pool's. Now
  FR-031, including the instruction to correct that comment.
- **The failure bound was ambiguous.** "Failed buy" could have been read to
  include a buy refused before it was sent, which would lock a depositor out of
  their own campaign for trading something volatile. Now defined in FR-028.

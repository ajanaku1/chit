# Release Gate Checklist: The capped mainnet beta

**Purpose**: Test whether the go-live conditions are stated precisely enough to be objectively passed or failed, rather than judged in the moment
**Created**: 2026-09-20
**Feature**: [spec.md](../spec.md)

## Preconditions

- [x] CHK021 Is every precondition for opening the beta stated in the requirements, or do some exist only in the plan and the runbook? [Completeness, Spec §FR-008, §FR-009, §FR-012 → closed by §FR-039, FR-040]
- [x] CHK022 Is the soak period stated as a requirement with a duration and a pass condition, or only as an acceptance outcome? [Gap — the 48 hours appears in the design and the plan, not in the requirements → closed by §FR-039]
- [x] CHK023 Are the fork rehearsal's pass conditions specified, or left as "rehearsed"? [Measurability, Spec §SC-012 → closed by §FR-040]
- [x] CHK024 Is "a professional audit is complete" defined well enough that its absence or presence is unambiguous? [Clarity, Spec §FR-025 → closed by §FR-025]
- [x] CHK025 Do the requirements state who decides the beta may open, and on what evidence? [Gap → closed by §FR-040]

## Stopping

- [x] CHK026 Are the three pause triggers each defined by an observable event rather than a judgement? [Measurability, Spec §FR-026 → closed by §FR-026]
- [x] CHK027 Is "any depositor loses money" specified precisely enough to distinguish a loss from an unfavourable trade the depositor chose? [Clarity, Spec §FR-026 → closed by §FR-026]
- [x] CHK028 Do the requirements state how quickly a pause must follow its trigger? [Gap, Spec §FR-026 → closed by §FR-034]
- [x] CHK029 Is it specified what must be published to depositors when the pool pauses, and where? [Completeness, Spec §FR-026 → closed by §FR-026]
- [x] CHK030 Are the conditions for resuming after a pause specified at all? [Gap — the requirements cover pausing and never mention resuming → closed by §FR-035]

## Alerting and observability

- [x] CHK031 Are the three alerting timescales each tied to a defined class of failure, so an implementer can classify a new failure without guessing? [Clarity, Spec §FR-023 → closed by §FR-023]
- [x] CHK032 Is "money that cannot be recovered later" defined? [Measurability, Spec §FR-023 → closed by §FR-023]
- [x] CHK033 Do the requirements state where an alert must arrive and who must receive it? [Gap, Spec §FR-023 → closed by §FR-043]
- [x] CHK034 Is the monitor's assertion stated as a requirement an outsider could implement from public data alone, without reference to internal state? [Completeness, Spec §FR-027 → closed by §FR-027]

## Listings

- [x] CHK035 Are the four listing checks each specified with a pass condition, or are some named without one? [Measurability, Spec §FR-012 → closed by §FR-012]
- [x] CHK036 Is "ordinary transfer behaviour" defined, given that the concern is fee-on-transfer and holder allowlists specifically? [Clarity, Spec §FR-012 → closed by §FR-012]
- [x] CHK037 Do the requirements state what happens to a depositor holding a token that is delisted mid-beta? [Gap, Spec §FR-012 → closed by §FR-038]
- [x] CHK038 Is the liquidity measurement's method specified, so fifty times the draw cap means the same to two people? [Measurability, Spec §FR-012 → closed by §FR-012]

## Notes

- CHK022, CHK025, CHK028, CHK030 and CHK037 are gaps in the requirements, not in
  the plan. Each needs a sentence in the spec before `speckit.analyze` can find
  the requirement it is meant to trace to

## Outcome

All 18 items closed on 2026-09-20. Five gaps needed new requirements: the soak
(FR-039), who decides to open and on what evidence (FR-040), how fast a pause
follows its trigger (FR-034), what must be true to resume (FR-035), and what
happens to a depositor holding a delisted token (FR-038).

The item worth remembering: the specification described how to stop the pool and
never described how to start it again. Three triggers, no resume condition. A
beta that can only be paused is a beta that ends by accident.

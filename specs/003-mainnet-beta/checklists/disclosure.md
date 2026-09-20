# Disclosure Checklist: The capped mainnet beta

**Purpose**: Test whether what depositors are told is specified completely and honestly, given that the project's stated discipline is that its claims hold
**Created**: 2026-09-20
**Feature**: [spec.md](../spec.md)

## What is said

- [x] CHK039 Is the custody sentence specified as exact wording, or left for the implementer to phrase? [Clarity, Spec §FR-006 → closed by §FR-006]
- [x] CHK040 Are the three facts in the beta note each required independently, so dropping one is a failure rather than an edit? [Completeness, Spec §FR-006 → closed by §FR-006]
- [x] CHK041 Is "not dismissible" specified in terms of behaviour rather than intent? [Measurability, Spec §FR-006 → closed by §FR-006]
- [x] CHK042 Do the requirements state that the gate is an interface control only and cannot prevent a direct deposit? [Gap — CONFIRMED MISSING: stated in `design-mainnet-beta.md` §2 and `research.md` §R9, absent from the requirements → closed by §FR-029]
- [x] CHK043 Is the slippage bound required to be shown before acceptance, in a form the depositor can act on? [Clarity, Spec §FR-013 → closed by §FR-013]

## What must not be said

- [x] CHK044 Do the requirements name every published surface that currently claims an audit precedes mainnet? [Completeness, Spec §FR-008 → closed by §FR-008]
- [x] CHK045 Is it specified that the correction must land before the beta opens, not alongside it? [Clarity, Spec §FR-008 → closed by §FR-008]
- [x] CHK046 Are the forbidden privacy words carried forward from Stage 2, or only referenced by pointing at the old requirement? [Completeness, Spec §FR-020 → closed by §FR-020]
- [x] CHK047 Do the requirements prevent the beta's caps from being described in a way that implies an audit happened? [Gap → closed by §FR-041]

## Consistency with what is true

- [x] CHK048 Is the gate's description consistent between the requirement that gates the interface and the disclosure that says anyone can deposit directly? [Consistency, Spec §FR-003 and the gap at CHK042 → closed by §FR-029]
- [x] CHK049 Do the disclosure requirements and the privacy requirement agree about what the operator can see and do? [Consistency, Spec §FR-006, §FR-020 → closed by §FR-020]
- [x] CHK050 Is there a requirement that the announcement and the product say the same thing about who may deposit? [Gap — the runbook says holders only, the drafted announcement does not → closed by §FR-042]
- [x] CHK051 Do the requirements state that the caps stay until an audit, in the depositor-facing copy and not only as an internal rule? [Gap, Spec §FR-025 → closed by §FR-041]

## Notes

- CHK042 is confirmed failing: the requirements never say the gate controls the
  interface only and cannot stop a direct deposit, although the approved design
  and the research both say so. This needs a requirement before `speckit.analyze`
- CHK047, CHK050 and CHK051 are gaps between what was decided and what the
  requirements say. CHK050 in particular is a live inconsistency with the
  announcement drafted on 2026-09-20

## Outcome

All 13 items closed on 2026-09-20.

**CHK042 was the real find.** The approved design and the research both say the
holders gate controls the interface and cannot stop anyone depositing directly
into the contract. No requirement said so, which is exactly how a product ends up
describing a gate as stronger than it is. Now FR-029.

**CHK050 remains a live task, not a spec gap.** FR-042 now requires that
announcements state the same access conditions the product enforces. The drafts
written on 2026-09-20 for Telegram and X do not mention holders-only access, so
they must be corrected before they are posted.

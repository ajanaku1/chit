# Fleet Mission Review Checklist

**Purpose**: Review the requirements for privacy truthfulness, non-custodial keys, campaign control, fee disclosure, budget policy, and demo acceptance.

**Created**: 2026-08-28

**Feature**: [Fleet Mission specification](../spec.md)

## Privacy Truthfulness

- [x] CHK001 Are public and trusted boundaries separately specified for accounts, trades, amounts, timing, gas, shared paymaster, operator mapping, and the primary-to-fleet edge? [Completeness, Spec §FR-011]
- [x] CHK002 Is the prohibition on claiming fleet-wide unlinkability explicit and consistent with the public activity description? [Consistency, Spec §SC-009]
- [x] CHK003 Are the no-public-primary and no-reusable-public-campaign conditions clear without asserting hidden trades? [Clarity, Spec §FR-011]

## Non-custodial Key Requirements

- [x] CHK004 Are local generation, distinct credentials, exact Vault v1 encryption, recovery download, and fresh recovery confirmation specified as separate requirements? [Completeness, Spec §FR-005–FR-006; Contract §fleet-vault]
- [x] CHK005 Are plaintext-key and recovery-ciphertext exclusions defined consistently for API traffic, logs, persistent storage, and the service boundary? [Consistency, Spec §FR-006; Contract §fleet-vault]
- [x] CHK006 Is the consequence of losing local authorization and recovery material stated clearly enough for acceptance review? [Clarity, Spec §Edge Cases]

## Campaign State and Revocation

- [x] CHK007 Are all campaign states and their valid sponsorship outcomes specified? [Completeness, Spec §FR-012–FR-016]
- [x] CHK008 Is Revoked unambiguously terminal for sponsorship, with Close as its sole remaining action and a new campaign required for continuation? [Clarity, Spec §FR-013]
- [x] CHK009 Are reload, partial activation, retry, pause, depletion, expiry, and closure requirements mutually consistent? [Consistency, Spec §Edge Cases]

## Fee and Budget Policy

- [x] CHK010 Are threshold, base fee, configured discount, and net fee all specified for both Access and campaign review? [Completeness, Spec §FR-003]
- [x] CHK011 Is the requirement that the charged fee equals base fee minus configured discount objectively measurable? [Measurability, Spec §SC-005]
- [x] CHK012 Are CHIT eligibility and ETH sponsorship budget requirements clearly separated, including creation-only eligibility? [Clarity, Spec §FR-002 and FR-009]
- [x] CHK013 Are exact budget reservation, permitted debit, and terminal unused-ETH return requirements consistent? [Consistency, Spec §FR-009 and FR-016]

## Policy and Demo Acceptance

- [x] CHK014 Are all allowed session dimensions and prohibited actions specified without an arbitrary-call loophole? [Completeness, Spec §FR-007–FR-008]
- [x] CHK015 Are the five-account buy, native-ETH protection, exact budget debit, and policy rejection outcomes objectively measurable? [Measurability, Spec §SC-003–SC-006]
- [x] CHK016 Are evidence-gated testnet dependencies and the labelled fixture contingency specified without a production DEX claim? [Dependency, Spec §Assumptions]
- [x] CHK017 Are exclusions sufficiently explicit to prevent scope expansion into custody, sales, trading automation, mobile, unsupported mainnet sponsorship, or market manipulation? [Coverage, Spec §FR-017]
- [x] CHK018 Are user-selected product evidence and the absence of competition facts explicitly distinguished? [Completeness, Spec §FR-018]

## Notes

Evidence: `spec.md` FR-001–FR-018 and SC-001–SC-010; implementation boundaries in `contracts/fleet-api.md`, `fleet-sdk.md`, `fleet-vault.md`, and `fleet-evidence.md`; task-first coverage in `tasks.md` T001–T041.

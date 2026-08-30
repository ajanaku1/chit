# Tasks: Fleet Mission

Every test is written and observed failing before its paired implementation. Existing tests are never edited to mask baseline debt.

## Phase 1: Evidence and harness
- [x] T001 Write failing live/fixture evidence-schema test in `test/fleet/chain-dependencies.test.ts` (FR-018; COMP-006)
- [x] T002 [P] Write failing root-types test in `test/fleet/types.test.ts` (FR-001, FR-004, FR-012; COMP-006)
- [x] T003 [P] Write failing browser-boundary test in `app/test/fleet-boundary.test.ts` (FR-017; COMP-006)
- [x] T004 Add Fleet compiler configuration in `./tsconfig.fleet.json` (FR-017; COMP-006)
- [x] T005 Add Fleet build/test scripts in `./package.json` (FR-017; COMP-006)
- [x] T006 Implement evidence validator in `src/fleet/dependency-evidence.ts` (FR-018; COMP-004)
- [x] T007 Implement shared Fleet types in `src/fleet/types.ts` (FR-001, FR-004, FR-012; COMP-004)
- [x] T008 Implement browser Fleet boundary in `app/src/fleet/index.ts` (FR-017; COMP-001)

## Phase 2: Foundational controls
- [x] T009 [P] Write failing state/revocation test in `test/fleet/campaign-state.test.ts` (FR-012–FR-016, SC-006, SC-010; COMP-006)
- [x] T010 [P] Write failing session-policy test in `test/fleet/session-policy.test.ts` (FR-007–FR-008, SC-006; COMP-006)
- [x] T011 [P] Write failing budget rollback test in `test/fleet/campaign-budget.test.ts` (FR-009, FR-016, SC-004; COMP-006)
- [x] T012 [P] Write failing service nonce, idempotency, redaction, action-confusion (`outer action != auth.action`), and canonical body-hash mismatch test in `test/fleet/campaign-service.test.ts` (FR-006, FR-011, FR-014, SC-007–SC-008; COMP-006)
- [x] T013 Implement Fleet factory in `contracts/fleet/FleetAccountFactory.sol` (FR-001, FR-005; COMP-002)
- [x] T014 Implement session policy in `contracts/fleet/FleetSessionPolicy.sol` (FR-007–FR-008, FR-013; COMP-002)
- [x] T015 Implement escrow/paymaster reservation in `contracts/fleet/FleetCampaignEscrow.sol` (FR-009, FR-016, SC-004; COMP-003)
- [x] T016 Implement campaign service in `src/fleet/campaign-service.ts` (FR-006, FR-011, FR-014; COMP-004)

## Phase 3: US1 creation
- [x] T017 [P] [US1] Write failing fee-charge and ineligible-wallet test in `test/fleet/fee-charge.test.ts` (FR-002–FR-003, SC-002, SC-005; COMP-006)
- [x] T018 [P] [US1] Write failing campaign action-route test for 5–50 distinct owner addresses/salts and `recoveryVaultCommitment`, rejecting outer/auth action or payload-hash mismatch, in `test/fleet/campaign-route.test.ts` (FR-001–FR-006, FR-012, SC-005; COMP-006)
- [x] T019 [P] [US1] Write failing Vault v1 browser test using fixed non-production vector `app/test/fixtures/fleet-vault-v1.json` for exact signing-message bytes, normalized signature input, HKDF inputs/output, AES-GCM IV/AAD/ciphertext/tag, canonical serialization, and final commitment; also cover round-trip, second-signature confirmation, wrong wallet, tampered AAD/tag/wrapped DEK, unknown version/algorithm, IV reuse or malformed lengths, commitment/owner mismatch, and generic failure in `app/test/fleet-vault.test.ts` (FR-005–FR-006, SC-008; COMP-006)
- [x] T020 [P] [US1] Write failing browser setup test in `app/test/fleet-setup.test.ts` (FR-003–FR-006, SC-001; COMP-006)
- [x] T021 [US1] Implement eligibility/fee accounting in `src/fleet/eligibility.ts` (FR-002–FR-003, FR-009, SC-002, SC-005; COMP-004)
- [x] T022 [US1] Implement campaign action handler in `api/fleet/campaign.ts` (FR-002–FR-006, FR-012, SC-005; COMP-004)
- [x] T023 [US1] Implement exact Recovery Vault v1 protocol from `specs/001-fleet-mission/contracts/fleet-vault.md` in `app/src/fleet/vault.ts` (FR-005–FR-006, SC-008; COMP-001)
- [x] T024 [US1] Implement campaign setup UI in `app/src/fleet/campaign-setup.ts` (FR-001, FR-003–FR-006, SC-001; COMP-001)

## Phase 4: US2 bounded buy
- [x] T025 [P] [US2] Write failing buy-route test in `test/fleet/buy-route.test.ts` (FR-007–FR-010, SC-006; COMP-006)
- [x] T026 [P] [US2] Write failing SDK policy and Revoked-terminal test in `test/fleet/sdk-policy.test.ts` (FR-007–FR-010, FR-013, FR-015, SC-003, SC-006, SC-010; COMP-006)
- [x] T027 [P] [US2] Write failing five-wallet test in `test/fleet/five-wallet-e2e.test.ts` (FR-001, FR-009–FR-011, SC-003–SC-004, SC-009; COMP-006)
- [x] T028 [P] [US2] Write failing browser buy-reporting test in `app/test/fleet-buy.test.ts` (FR-010–FR-011, SC-003–SC-004; COMP-006)
- [x] T029 [US2] Implement buy handler in `api/fleet/buy.ts` (FR-007–FR-010, SC-006; COMP-004)
- [x] T030 [US2] Implement UserOperation adapter in `src/fleet/user-operation.ts` (FR-007–FR-010, SC-003; COMP-004)
- [x] T031 [US2] Implement SDK in `src/fleet/sdk.ts` including Revoked terminal rejection (FR-010, FR-013, FR-015, SC-003, SC-006, SC-010; COMP-005)
- [x] T032 [US2] Implement buy reporting in `app/src/fleet/control-room.ts` (FR-010–FR-011, SC-003–SC-004; COMP-001)

## Phase 5: US3 lifecycle
- [x] T033 [P] [US3] Write failing control-route/service test in `test/fleet/control-route.test.ts` (FR-012–FR-016, SC-010; COMP-006)
- [x] T034 [P] [US3] Write failing browser control test in `app/test/fleet-control-room.test.ts` (FR-012–FR-016, SC-010; COMP-006)
- [x] T035 [US3] Implement control handler in `api/fleet/control.ts` (FR-012–FR-016, SC-010; COMP-004)
- [x] T036 [US3] Implement terminal controls/UI in `app/src/fleet/control-room.ts` (FR-012–FR-016, SC-010; COMP-001)
- [x] T037 [US3] Enforce revoked terminal state in `src/fleet/sdk.ts` (FR-013, FR-015, SC-006, SC-010; COMP-005)

## Phase 6: Acceptance
- [x] T038 [P] Add privacy-boundary regression test in `test/fleet/privacy-boundary.test.ts` (FR-011, SC-009; COMP-006)
- [x] T039 [P] Add clean-account quickstart test in `test/fleet/quickstart.test.ts` (FR-001–FR-018, SC-001–SC-010; COMP-006)
- [x] T040 [P] Add browser acceptance test in `app/test/fleet-acceptance.test.ts` (FR-001–FR-017, SC-001, SC-010; COMP-006)
- [x] T041 Reconcile quickstart evidence in `specs/001-fleet-mission/quickstart.md` (FR-017–FR-018, SC-009; COMP-006)

Fleet phases use compiled `dist-fleet/test/fleet/*.test.js` and `npm --prefix app run verify`; the unchanged `test/fork/*.test.ts` viem failure is baseline debt.

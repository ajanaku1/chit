# Tasks: Private Funding Pool

**Input**: Design documents from `/specs/002-private-funding-pool/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

Every test is written and observed failing before its paired implementation (project law). Existing tests are never edited to pass; the two Stage 1 test edits in this feature (copy wording) are user-approved in plan.md COMP-105. No dependency is added. Commits stay under 200 changed lines.

## Format: `[ID] [P?] [Story] Description (FR/SC; COMP)`

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Add `pool-*` verify tags scaffold (all red) to `./verify.sh` listing the test files below (SC-010; COMP-106)
- [x] T002 [P] Add pool env documentation and config parsing stub (`FLEET_POOL_ADDRESS`, ledger key derivation) in `src/fleet/service-runtime.ts` (FR-016; COMP-102)
- [x] T003 [P] Add per-minute cron entry for `/api/fleet/sweep` in `./vercel.json` (FR-007, FR-012; COMP-103)

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T004 Write failing fork test for FleetPool deposits, allowed sizes, caps, pause in `test/fork/fleet-pool.test.ts` (FR-001, FR-004, FR-012; COMP-106)
- [x] T005 [P] Write failing fork test for exit request/execute after delay, blocked by unposted queued spend in `test/fork/fleet-pool-exit.test.ts` (FR-011, FR-012, SC-007; COMP-106)
- [x] T006 [P] Write failing fork test for draws: open with dueAt and ownerRef, fund after due, fundPrincipal/commit/rollback, closeDraw, claimOperator bound in `test/fork/fleet-pool-draw.test.ts` (FR-005–FR-008, FR-013; COMP-106)
- [x] T007 [P] Write failing ABI-scan test that no FleetPool function or event names both a depositor and a campaign in `test/fleet/pool-abi.test.ts` (FR-009; COMP-106)
- [x] T008 [P] Write failing ledger-math and ciphertext round-trip test in `test/fleet/pool-ledger.test.ts` (data-model Balance, Queued spend; COMP-102)
- [x] T009 Implement `contracts/fleet/FleetPool.sol` per `contracts/pool-contract.md` (FR-001, FR-004–FR-013; COMP-101)
- [x] T010 Implement `src/fleet/pool-ledger.ts`: AES-GCM helper keyed from the operator key, balance/headroom computation from chain reads (COMP-102)
- [x] T011 Implement `src/fleet/chain-pool.ts`: viem adapter for every FleetPool function and event scan (COMP-102)
- [x] T012 Compile-and-fork check: `./verify.sh pool-foundation` green (SC-010; COMP-106)

**Checkpoint**: Pool contract and ledger proven on the 46630 fork.

## Phase 3: User Story 1 — Hold a Chit balance (Priority: P1) 🎯 MVP

**Goal**: Deposit fixed sizes into the unkeyed pool, see balance and headroom, withdraw via Chit, see the exit path.
**Independent Test**: deposit, read balance and headroom, withdraw to a fresh address, exit status; deposit event carries no campaign identifier.

- [x] T013 [P] [US1] Write failing route test for `balance` and `withdraw` (headroom, refuse over available, destination warning, queued spend) in `test/fleet/balance-route.test.ts` (FR-002, FR-003, FR-010; COMP-103)
- [x] T014 [P] [US1] Write failing browser test for the Balance page states (deposit picker, disabled reasons, pending, withdraw paid, exit states) in `app/test/fleet-balance.test.ts` (FR-003, FR-010, FR-011; COMP-104)
- [x] T015 [P] [US1] Write failing fork test: fresh router instance answers `balance` and pays a withdrawal from the operator wallet then queues spend in `test/fork/fleet-pool-balance.test.ts` (FR-010, FR-012, SC-006; COMP-106)
- [x] T016 [US1] Implement `balance`, `withdraw` actions and `api/fleet/balance.js` in `src/fleet/campaign-routes.ts` and `api/fleet/balance.js` (FR-002, FR-003, FR-010; COMP-103)
- [x] T017 [US1] Implement operator payout plus `queueSpend` in `src/fleet/pool-buy.ts` (withdrawal path) (FR-010, FR-012; COMP-102)
- [x] T018 [US1] Implement Balance page `app/balance.html`, `app/src/balance-page.ts`, `app/src/fleet/balance.ts`; add to `app/build.mjs` (FR-003, FR-010, FR-011; COMP-104)
- [x] T019 [US1] `./verify.sh pool-balance` green (SC-003, SC-006; COMP-106)

## Phase 4: User Story 2 — Fund a fleet from the balance and trade (Priority: P2)

**Goal**: Activate with a draw, funded after a random delay by any instance, then a just-in-time sponsored buy.
**Independent Test**: activate with 0.02 ETH draw, sweep from a fresh instance after due, one buy lands FLEET with principal and gas settled against the draw; no trader-wallet transaction.

- [ ] T020 [P] [US2] Write failing route test for `activate` with draw (cap, short balance, paused pool) and `topUp` in `test/fleet/activate-draw-route.test.ts` (FR-004, FR-005, FR-013; COMP-103)
- [ ] T021 [P] [US2] Write failing fork test: activation opens a Pending draw; a fresh router's sweep after dueAt seeds gas headroom and opens the session; a buy moves principal just in time and commits principal plus gas; a failing buy rolls principal back; queued spend posts after its due time in `test/fork/fleet-pool-fund.test.ts` (FR-006–FR-008, FR-012, SC-004, SC-005; COMP-106)
- [ ] T022 [P] [US2] Write failing browser test for the activate step with draw and the "Funding your fleet" state in `app/test/fleet-activate-draw.test.ts` (FR-005, FR-006; COMP-104)
- [ ] T023 [US2] Implement draw opening with random due time and restore-from-chain for draws in `src/fleet/campaign-routes.ts` and `src/fleet/chain-pool.ts` (FR-005–FR-007; COMP-102, COMP-103)
- [ ] T024 [US2] Implement sweep (fund due draws, post due queued spend) in `src/fleet/pool-buy.ts` and `api/fleet/sweep.js`; call it at the start of state-changing actions (FR-007, FR-012; COMP-102, COMP-103)
- [ ] T025 [US2] Implement just-in-time buy settlement (fundPrincipal, execute, commit or rollback, queueSpend) in `src/fleet/pool-buy.ts` and wire `#buyOnChain` for pool campaigns (FR-008; COMP-102)
- [ ] T026 [US2] Implement wizard activate step with draw and "Funding your fleet" in `app/fleet.html` and `app/src/fleet-page.ts` (FR-005, FR-006; COMP-104)
- [ ] T027 [US2] `./verify.sh pool-fund` green (SC-004, SC-005; COMP-106)

## Phase 5: User Story 3 — Control and get money back privately (Priority: P3)

**Goal**: Close credits balance, top-up restores Active, operator pause is honest in the app.
**Independent Test**: close an Active campaign and see the balance rise with no public refund; paused campaign refuses buys; operator-paused pool refuses deposits and draws.

- [ ] T028 [P] [US3] Write failing route test for `close` crediting balance and `topUp` from Depleted in `test/fleet/pool-control-route.test.ts` (FR-013; COMP-103)
- [ ] T029 [P] [US3] Write failing fork test: closeDraw plus postCredit raise available with no transfer to the trader; operator pause blocks deposit, draw, and buy in `test/fork/fleet-pool-control.test.ts` (FR-012, FR-013, SC-008; COMP-106)
- [ ] T030 [P] [US3] Write failing browser test for Control Room balance strip, per-campaign draw figures, close message, paused banner in `app/test/fleet-control-room.test.ts` (FR-013, FR-014; COMP-104)
- [ ] T031 [US3] Implement close-to-balance and top-up in `src/fleet/campaign-routes.ts` and `src/fleet/chain-pool.ts` (FR-013; COMP-102, COMP-103)
- [ ] T032 [US3] Implement Control Room changes in `app/fleet-dashboard.html` and `app/src/fleet-dashboard.ts` (FR-013, FR-014; COMP-104)
- [ ] T033 [US3] `./verify.sh pool-control` green (SC-008; COMP-106)

## Phase 6: Polish and cross-cutting

- [ ] T034 [P] Write failing copy test that app, landing, and marketing carry the FR-015 claim and none of "anonymous", "untraceable", unqualified "no trail" in `app/test/fleet-claims.test.ts` and `landing/test/landing.test.mjs` (FR-015, SC-009; COMP-105)
- [ ] T035 Update claim copy in `app/fleet.html`, `app/fleet-privacy.html`, `app/src/fleet/index.ts`, `landing/public/index.html`, `marketing/CHIT-UPDATE-AND-TOKEN.md`, `marketing/CHIT-COMMUNITY-BRIEF.md` (FR-015; COMP-105)
- [ ] T036 [P] Write failing observer unlinkability test scanning pool, factory, and policy events on the fork for a full journey in `test/fork/fleet-pool-observer.test.ts` (FR-009, SC-002; COMP-106)
- [ ] T037 Add `scripts/fleet-pool-deploy-live.ts` and `fleet-pool-deploy:live` npm script recording `pool` in `deployments/fleet-46630.json` (FR-016; COMP-102)
- [ ] T038 Update `specs/002-private-funding-pool/quickstart.md` evidence section and `IMPLEMENTATION.md` (COMP-106)
- [ ] T039 `./verify.sh pool-acceptance` green and every Stage 1 fleet tag green (FR-017, SC-009, SC-010; COMP-106)
- [ ] T040 Live: deploy the pool, run the quickstart live validation on chit.tools, record tx hashes under `pooledBuy` (outward; user go) (SC-001–SC-008)

## Dependencies

- Phase 2 blocks every story. US1 (Phase 3) is the MVP. US2 depends on US1's balance actions. US3 depends on US2's draws. Phase 6 depends on all stories; T040 is outward and needs the user's go.

## Parallel Execution Examples

- Phase 2: T004–T008 in parallel (five test files), then T009–T011.
- US1: T013–T015 in parallel, then T016–T018.
- US2: T020–T022 in parallel, then T023–T026.
- US3: T028–T030 in parallel, then T031–T032.

## Implementation Strategy

Deliver US1 first as the MVP: a trader can hold and withdraw a balance in the unkeyed pool with the exit path visible. US2 makes the privacy claim true. US3 completes recovery. Phase 6 closes the claims and the live evidence.

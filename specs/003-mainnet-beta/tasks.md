# Tasks: The capped mainnet beta on Robinhood Chain

**Input**: Design documents from `/specs/003-mainnet-beta/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. The specification's acceptance outcomes require the review's
thirteen reproductions to flip, and the repository's rules define done as a check
having passed.

**Revised 2026-09-20** after `speckit.analyze` found the rebase scheduled last
when it must come nearly first. See the resequencing note at the end.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4 map to the user stories in spec.md
- **Owner**: B marks the co-developer's tasks, F the founder's

---

## Phase 1: Setup

**Purpose**: Reproductions in place so every fix has a target, and nothing
untested can reach production while the work is in flight.

- [x] T001 [F] Copy the review's reproductions into `test/fleet/` (`mainnet-blockers.test.ts`, `mainnet-blockers-m4c.test.ts`, `FleetPoolMainnetBlockers.t.sol`) and confirm 10 of 10 and 3 of 3 pass on the current head
- [x] T002 [B] Add `.github/workflows/verify.yml` running the no-network set: fleet suite, app verify, landing verify, Solidity tests, progress check
- [x] T003 [B] Add a second job running the fork suites against a private RPC secret, nightly, not as a required check
- [x] T004 [F] Enable branch protection on `main` requiring the `verify` check, after T002 has run once
  - Done 2026-09-22 as a ruleset on `Chit-org/chit-fleet` (the repo moved to the organisation, Team plan, that day):
    pull requests only, `verify` required, no force-push or deletion, no bypass. A direct push to main is refused
    (GH013); everything lands by PR and `gh pr merge` once verify is green.
- [x] T005 [B] Stop `session-demo.yml` and `progress.yml` committing to `main`; generate `landing/public/progress.json` in the Vercel build instead
- [x] T006 [B] Prove the gate: push a deliberately broken test to a branch, confirm the check blocks the merge, revert
  - Proved 2026-09-22 by the founder: PR #13 carried one red test; verify failed and the merge was BLOCKED by the base
    branch policy; the PR was closed and its branch deleted, never merged.

**Checkpoint**: No untested change can reach production.

---

## Phase 2: Foundational

**Purpose**: Everything the money path needs before real ETH exists. Blocks
Phases 3–6 entirely.

### 2A. The caps branch, first — FR-001, FR-009

The branch carries the caps into the pool's constructor and teaches the deploy
script both chains. It rewrites `FleetPool.sol` and `fleet-redeploy-live.ts`, the
same files the contract work below changes, so it lands before any of it.

- [x] T007 [F] Rebase `feat/mainnet-beta` onto `main`, resolving against batch queueing, the Neon store, hashed queue ids and the admin split
- [x] T008 [F] Reconcile `scripts/fleet-redeploy-live.ts` after the rebase: `(admin, operator)` to both constructors, `FLEET_ADMIN_ADDRESS` read, refusal without a guardian on mainnet
- [x] T009 [F] Confirm `src/fleet/pool-caps.ts` publishes both sets and that the pool's constructor enforces them
- [x] T010 [F] Redeploy testnet from the rebased branch and close T040 in `specs/002-private-funding-pool/tasks.md`
  - Deployed 2026-09-21 from main (`f654c17` bytecode): pool `0x5c619e51e9a4559dfb0bed22e9ec3ae1ae22beef`, policy
    `0x4a0c4555…e492`, factory `0x74789523…d896`; record in `deployments/fleet-46630.json`. spec-002's T040 closed
    2026-09-22: Vercel Production names the new set, chit.tools reports the pool, and the journey ran against it.
- [x] T011 [F] Verify against the redeployed testnet pool that the caps read back from the bytecode, not from any constant in the service or the app
  - Read back 2026-09-21: 0.5 / 0.2 / 5 from `0x5c61…beef`. The service reads them from the pool (`chain-pool.ts`
    `caps()`, `campaign-routes.ts`); the Balance page reads them from the balance view. Finding: the fleet wizard still
    carries `DRAW_CAP` in `app/src/fleet/balance.ts:94` for its meter and its refusal, which is 0.2 on testnet and
    wrong for the 0.05 beta; that is T059's to remove.
- [x] T012 [P] [F] Verify deployment refuses without a guardian, as a test rather than a rehearsal note

**Checkpoint**: One bytecode lineage. Every contract change below is written once.

### 2B. The durable write lifecycle (M1, M4) — FR-014, FR-016

- [x] T013 [F] Add `nextNonce(address)` to `src/fleet/chain-pool.ts`, defaulting to the pending transaction count
- [x] T014 [F] Add `signAndBroadcast({nonce, functionName, args, value, gas, record})` to `src/fleet/chain-pool.ts` per `contracts/chain-adapter.md`: sign, call `record` with the hash, then broadcast; return mined, reverted or unknown, never throw to mean "nothing happened"
- [x] T015 [F] Add `resolve(hash, nonce, from)` to `src/fleet/chain-pool.ts`: a receipt decides mined or reverted; no receipt once the account nonce has passed decides never-mined
- [x] T016 [F] Extend `StorePort` in `src/fleet/store.ts` with the `sent` state, `txHash`, `nonce`, `markSent` and `resolveSent`
- [x] T017 [F] Implement the new store methods in `src/fleet/store-neon.ts` with its migration, and in the memory adapter
- [x] T018 [F] Route `queueOwed` in `src/fleet/pool-buy.ts` through the lifecycle, reconciling against `pool.queued()` by the exact sealed references sent before releasing any row
- [x] T019 [F] Route the sponsored buy in `src/fleet/pool-buy.ts` through the lifecycle, reconciling against the draw's `spent` before reporting rejected
- [x] T020 [F] Route fleet funding in `src/fleet/pool-buy.ts` through the lifecycle, reconciling against the draw's state before skipping the headroom charge
- [x] T021 [F] Check the operator's balance before recording a withdrawal charge in `src/fleet/pool-buy.ts`; refuse with a retryable response and record nothing
- [x] T022 [F] Route the withdrawal payout through the lifecycle, storing the hash on the owed row before broadcast
- [x] T023 [P] [F] Replace `finding_M1` with siblings stating the fixed behaviour
- [x] T024 [P] [F] Replace `finding_M4a`, `finding_M4b`, `finding_M4c` with siblings stating the fixed behaviour
- [x] T025 [F] Add the three outcome tests beside `test/fleet/pool-sweep.test.ts:233`: mined, reverted, never-mined

### 2C. The operator lock (M5)

- [ ] T026 [B] Take the operator lock around each signed step in `#sweep`, `#sweepOpportunistically` and `#control` in `src/fleet/campaign-routes.ts`, not around the whole sweep
- [ ] T027 [B] Add lease renewal and a holder check immediately before broadcast in `src/fleet/store.ts` and its adapters
- [x] T028 [B] Give the sponsor route its own key variable in `src/fleet/sponsor-runtime.ts`; sponsorship stays off on mainnet
  - `FLEET_SPONSOR_PRIVATE_KEY`; the operator's key under that name is refused, and on 4663 the route answers
    `sponsorship_off` whatever is set. Open, and a deploy rather than code: the sponsor set on 46630 names the pool
    operator as its operator, so the testnet route keeps signing with the operator's key, and warns, until that set
    is deployed again for a sponsor account.
- [ ] T029 [B] Replace `finding_M5` with a two-instance test driving real nonce behaviour

### 2D. The contract (M2, part of M3) — FR-030, FR-031, FR-033, FR-036

Written on the rebased bytecode from 2A, so the caps and these changes ship as
one deployment.

- [x] T030 [F] Add `totalPosted` to `contracts/fleet/FleetPool.sol`, accumulated in `postQueued`, counting only the part of a charge still backed by unspent deposit
- [x] T031 [F] Redefine `claimable()` as `max(0, totalPosted - totalOutflow - totalClaimed)` in `contracts/fleet/FleetPool.sol`
- [x] T032 [F] Measure on a fork the largest `postQueuedBatch` that fits within half the block gas limit, and record the number
- [x] T033 [F] Add `postQueuedBatch` to `contracts/fleet/FleetPool.sol` with that cap: per-entry result of posted, expired or already posted, never reverting the batch
- [x] T034 [F] Add payable `donate()` to `contracts/fleet/FleetPool.sol`, crediting no depositor and working while paused
- [x] T035 [F] Add `everDeposited`, `exitsPaid` and `donated` counters with events to `contracts/fleet/FleetPool.sol`
- [x] T036 [F] Replace `invariant_claimableIsGasOnly` in `test/fleet/FleetPoolInvariants.t.sol` with an invariant that claimable never exceeds the pool's surplus over what it owes
- [x] T037 [F] Add the monitor identity as an invariant: `balance == everDeposited + donated - totalOutflow - exitsPaid - totalClaimed`
- [x] T038 [P] [F] Replace `test_finding_M2_aWithdrawalIsNeverReimbursed` with its fixed sibling
- [x] T039 [P] [F] Replace both `test_finding_M3_*` Solidity tests with siblings covering `postQueuedBatch` and `donate()` while paused
- [x] T040 [F] Correct the comment at `src/fleet/pool-buy.ts:46`: the grain falls to the operator, not the pool

### 2E. The sweep (M3)

- [x] T041 [P] [B] Add `blockTime` to the chain definition in `src/fleet/service-runtime.ts`
- [x] T042 [P] [B] Add `maxDuration` for `api/fleet/*` in `vercel.json`
- [x] T043 [B] Read `ledgerInputs` through Multicall3 in `src/fleet/chain-pool.ts`, caching entries that can no longer change
- [x] T044 [B] Log and count every failed posting with its reason in `src/fleet/pool-buy.ts`, and add the field to the sweep's report
- [x] T045 [B] Move one Vercel cron off the twelve-hour spacing in `vercel.json`
  - Done another way, because it cannot be done as written: two runs a day always leave a gap of at
    least twelve hours, wherever they are put (moving one to 02:00 makes the long gap 13 h). What is
    built is a second clock: `/api/fleet/sweep-posting` every two hours, which posts what is due and
    funds what is ready and never queues. The queueing schedule is untouched, because how often it
    ticks is the size of the batch a charge hides in. `test/fleet/sweep-timing.test.ts` reads
    `POST_WINDOW` from the contract and holds the largest posting gap under a third of it.
- [x] T046 [P] [B] Replace `finding_M3a`, `finding_M3b`, `finding_M3c` with siblings stating the fixed behaviour
  - `finding_M3c` is replaced by `fixed_M3c` with T041, `finding_M3a` by `fixed_M3a` with T044, `finding_M3b` by `fixed_M3b` with T043.

### 2F. Safety rails — FR-023, FR-032, FR-034, FR-035, FR-043

- [x] T047 [F] Refuse to start without `DATABASE_URL`, `CRON_SECRET` or `FLEET_TOKEN_ALLOWLIST` when the chain is mainnet, in `src/fleet/service-runtime.ts`
- [ ] T048 [B] Add the alert sink routing to the existing Telegram bot, with FR-023's three timescales and the named operator chat
- [ ] T049 [B] Alert on a sweep failure, a refused withdrawal, an unposted charge older than four hours, and the operator's balance reaching half the float
  - Half of it is in the outside monitor (T053): a charge unposted for over four hours, and the operator's
    balance at half of `FLEET_OPERATOR_FLOAT_ETH`. A sweep failure and a refused withdrawal happen where an
    outside reader cannot look, so they are reported from the sweep's workflow and the withdrawal path; open.
- [x] T050 [F] Pause the pool automatically on the two machine-detectable triggers: a charge passing its deadline unrecorded, and an exit transaction failing
- [x] T051 [F] Add the resume gate: the pool cannot be unpaused until the cause is recorded as fixed, a test covering it exists, and the pool is whole
  - Unpausing is the admin's cold key on chain, so the gate is `npm run fleet-resume-check` before it: the incident record
    (`incidents/`), its test in the repository, the identity, and no shortfall from the counters (`src/fleet/pool-solvency.ts`).
- [x] T052 [P] [F] Test that an automatic pause fires within one sweep of its trigger and that resume is refused while any condition is unmet
- [x] T053 [B] Build the outside monitor asserting FR-027's exact identity from public views
  - `src/fleet/monitor*.ts`, hourly from `.github/workflows/monitor.yml`, `docs/fleet-monitor.md`. It asserts the
    exact identity of T037 by itself once the pool answers `everDeposited`, `exitsPaid` and `donated` (T035);
    on a pool without them only the bound `balance >= totalDeposited - totalOutflow - totalClaimed` follows
    from the views, and that is what it holds today. It needs the `MONITOR_CHAT_ID` secret to send anything.

**Checkpoint**: Every money-path reproduction has flipped (`finding_M6` flips in
Phase 4). The money path is safe enough for real ETH.

---

## Phase 3: US1 — Put real money in and take it out (P1)

- [x] T054 [P] [US1] [F] Generate `app/chain-target.json` at build time from the chain environment in `app/build.mjs`
- [x] T055 [US1] [F] Add the holders gate in `app/src/fleet/holders-gate.ts`: above the threshold passes silently, below shows holdings and requirement with links to buy CHIT and to the testnet host, a failed read shows retry
- [x] T056 [US1] [F] Add the non-dismissible beta note carrying FR-006's three facts to every page in `app/src/fleet/page-shared.ts`
- [x] T057 [US1] [F] Show the custody sentence in full beside the amount on the deposit form in `app/src/fleet/balance.ts`
- [x] T058 [US1] [F] State once, where a depositor reads it, that the gate controls the interface only and the contract accepts direct deposits within its caps
- [x] T059 [US1] [F] Read the caps from the deployed pool in `app/src/fleet/balance.ts` and refuse a size that would breach either
  - Includes the fleet wizard's `DRAW_CAP` constant (T011's finding): the draw meter and `drawIssue` read the pool's cap from the balance view instead.
- [x] T060 [P] [US1] [F] Test the gate's three states, including that a failed balance read shows retry and never rejection
- [x] T061 [P] [US1] [F] Test that the beta note appears on every page and cannot be dismissed

**Checkpoint**: Deposit and exit work under the caps with the truth on the page.
This alone is a viable beta.

---

## Phase 4: US2 — Trade a listed token (P2)

- [x] T062 [US2] [F] Choose the launch candidates: CHIT plus at most three memes on 4663, named and recorded before any checking begins
  - Named 2026-09-22 (Lucian, in the registry file): CHIT, then HOODCAT, HEY and ORUS. CHIT is checked and enabled; HOODCAT is not an entry (its real pool is quoted in HOOD, its ETH pools are traps); HEY and ORUS wait on their addresses and the fork's measure. Closed for CHIT; the other two stay the founder's call.
- [x] T063 [US2] [F] Add `src/fleet/token-registry.ts` loading and validating the reviewed list per `contracts/token-registry.md`, failing hard when a `poolId` does not match its key
- [x] T064 [US2] [F] Create `deployments/token-registry-4663.json` with CHIT's real pool key, its measured bound and its checks
- [x] T065 [US2] [F] Wire the fleet buy path in `src/fleet/campaign-routes.ts` to the registry's pool key, replacing the hardcoded venue key
- [x] T066 [US2] [F] Quote through the existing `pool-registry.ts` discovery and `market.ts` arithmetic rather than the single full-range formula at `src/fleet/market.ts:118`
- [x] T067 [US2] [F] Refuse a buy that would land outside the token's bound, before any transaction is sent
- [x] T068 [US2] [F] Show the bound as the least the depositor will receive, as part of the quote they accept
- [x] T069 [US2] [F] Add the per-campaign failure counter to `src/fleet/store.ts` and its adapters, counting only gas-spending failures
- [x] T070 [US2] [F] Refuse buys on a campaign with three failures in the last hour, telling the depositor why and when it reopens
- [x] T071 [US2] [F] Bind the token picker to enabled registry entries only in `app/src/fleet/`
- [x] T072 [US2] [F] Make disabling an entry stop new buys without affecting tokens already held, and keep the owner's path to move them
- [x] T073 [P] [US2] [F] Replace `finding_M6` with a sibling showing the encoded buy names the real pool
- [x] T074 [US2] [F] Fork test on 4663 per listed token: quote and execution agree within the bound
- [x] T075 [US2] [F] Check and record each candidate from T062: transfer behaviour, holder restrictions, pool key, liquidity at fifty times the draw cap
- [x] T076 [P] [US2] [F] Test that a disabled entry is never offered, no path trades it, and holdings of it remain movable

**Checkpoint**: Real trading against real pools.

---

## Phase 5: US3 — Told the truth when Chit cannot pay (P2)

- [x] T077 [US3] [F] Add the refused state to the withdrawal surface in `app/src/fleet/`: what happened, try again, and the exit beside it
- [x] T078 [US3] [F] Use the same state for a paused pool, keeping the exit reachable
- [x] T079 [P] [US3] [F] Test that a refusal records no charge and the exit remains available

---

## Phase 6: US4 — Keep the free playground (P3)

- [ ] T080 [US4] [F] Create the second Vercel deployment for 46630 with its own environment and the `testnet.chit.tools` domain
- [ ] T081 [US4] [F] Confirm each host names its chain and neither offers the other's funds
- [ ] T082 [US4] [B] Point the bot's playground button at the testnet host

---

## Phase 7: Launch

- [x] T083 [F] The published-promise commit: correct Stage 2's FR-016, `README.md`, `ONBOARDING.md`, the community brief and the landing page, in one commit that says why
- [x] T084 [F] In the same pass, carry Stage 2's privacy wording forward verbatim and confirm no surface has strengthened it
- [x] T085 [F] Correct the drafted Telegram and X announcements to state holders-only access, per FR-042
- [x] T086 [F] State in depositor-facing copy that the caps remain until a professional audit is complete
- [x] T087 [F] Confirm no sell path is reachable in the mainnet build, as a test
- [ ] T088 [F] Soak on testnet for forty-eight hours with alerting on; no charge unrecorded beyond four hours
- [x] T089 [F] Rehearse on a fork of 4663: caps read back, refusal without a guardian, guardian pause without the operator, exit while paused
- [x] T090 [F] Rehearse each of the three pause triggers on the fork, including the two that fire automatically
- [ ] T091 [F] Re-measure every listed token's liquidity on the day of launch
- [ ] T092 [F] Verify contract source on the explorer for every deployed contract
- [x] T093 [F] Record the open decision against each acceptance outcome with its evidence, per FR-040
- [ ] T094 [F] Deploy with a guardian and open the beta

---

## Dependencies

- Phase 1 has no dependencies and starts immediately
- **2A blocks 2D**: the contract tasks are written on the rebased bytecode, never before it
- 2B's T013–T015 block T018–T022; T014 blocks T026
- Phase 2 blocks Phases 3–6 entirely
- T062 blocks T075; T063 blocks T065
- Phase 7 depends on everything

## Owner split

- **Founder (F)**: the rebase and caps, the write lifecycle, the contract, the
  venue and registry, the four surfaces, the automatic pause and resume gate, the
  promise commit, the launch
- **Co-developer (B)**: the lock, the sweep, CI, alerting and the monitor

The two meet in `src/fleet/chain-pool.ts`. T014 lands before T026 starts.

## MVP scope

Phases 1, 2 and 3: the money path correct, a holder can deposit under a cap, and
anyone can leave. Phase 4 makes it a trading product. Phases 5 and 6 are small and
should not be deferred.

## Resequencing note, 2026-09-20

`speckit.analyze` found the rebase of `feat/mainnet-beta` scheduled at the end of
the work while it rewrites `FleetPool.sol` and `fleet-redeploy-live.ts`, the same
files the contract tasks change. Written in that order, every contract change
would have been made twice or lost, and nothing would have put the caps into the
pool that the app is told to read them from. The rebase is now 2A, before all of
it, which is also where the readiness review's own sequence put it.

## Task count

94 tasks: 6 setup, 47 foundational, 8 for US1, 15 for US2, 3 for US3, 3 for US4,
12 launch.

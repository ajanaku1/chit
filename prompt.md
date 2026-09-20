# Chit Fleet build choreography

Source of truth: [Goal.md](Goal.md). Stage 1 (Fleet Mission) is reconciled from approved `design.md` and `specs/001-fleet-mission/`; Stage 2 (Private Funding Pool) from approved `design-stage2.md` and `specs/002-private-funding-pool/` (reconciled 2026-09-07); the capped mainnet beta from approved `design-mainnet-beta.md` and `specs/003-mainnet-beta/` (reconciled 2026-09-20). Each `specs/<feature>/plan.md` remains that stage's technical plan.

## The capped mainnet beta (current build)

Open Stage 2 to real ETH on 4663, capped at 1 ETH, holders only, labelled a beta
and labelled as unaudited. The order matters more than the size: the caps branch
rebases first because it rewrites the files the contract change touches, and no
real ETH moves until every money-path reproduction from the 2026-09-19 readiness
review has flipped.

### Preflight

| Skill | Project-specific use | Status | Fallback |
|---|---|---|---|
| blockchain-developer | The pool's counters, `claimable()` as surplus, `postQueuedBatch`, `donate()` | installed | Follow the existing Solidity conventions in `contracts/fleet`. |
| solidity-security | The surplus invariant, the batch's skip-and-report, `donate()` while paused | installed | Manual review against `specs/003-mainnet-beta/contracts/pool.md`. |
| test-driven-development | Every reproduction is replaced by a sibling that fails first | installed | Keep red-green order visible in commits. |
| backend-architect | The durable write lifecycle, the operator lock, reconciliation by chain state | installed | Follow `specs/003-mainnet-beta/contracts/chain-adapter.md` exactly. |
| code-reviewer | Diff review after each phase | installed | Review the diff against FR/SC and the failure paths. |
| simplify | Simplify reviewed passing code | installed | Consolidate duplication without behaviour change. |

### Phases

| Phase | Spec Kit tasks | done_when |
|---|---|---|
| Setup and the CI gate | T001–T006 | `./verify.sh beta-gate` |
| The caps branch, first | T007–T012 | `./verify.sh beta-caps` |
| The money path | T013–T029 | `./verify.sh beta-money` |
| The contract | T030–T040 | `./verify.sh beta-contract` |
| The sweep and the rails | T041–T053 | `./verify.sh beta-rails` |
| US1 deposit and exit | T054–T061 | `./verify.sh beta-surfaces` |
| US2 trade a listed token | T062–T076 | `./verify.sh beta-venue` |
| US3 and US4 | T077–T082 | `./verify.sh beta-surfaces` |
| Launch gate | T083–T094 | `./verify.sh beta-launch` (T088, T089, T090 and T094 are outward, recorded after) |

Traceability: `design-mainnet-beta.md` -> FR-001–043 / SC-001–016 (specs/003) ->
`specs/003-mainnet-beta/plan.md` -> T001–T094 -> `verify.sh beta-*`.

Hard constraints: no new dependency; the rebase precedes every contract change;
an exception is never read as proof a transaction did not happen; no transaction,
event, log or response may name both a depositor and a campaign; the caps are
enforced by the pool, not the app; nothing published may claim an audit precedes
mainnet once the beta is open; sells and sponsored gas stay out of the beta; every
`fleet-*` and `pool-*` gate stays green. Outward actions follow `plan.md`.
Goal.md wins on conflict.

## Stage 2 — Private Funding Pool (live on testnet, kept green)

Build the core journey in order: hold a Chit balance (deposit, headroom, withdraw, exit) → fund a fleet from the balance and trade (draw, delayed funding, just-in-time buy) → control and recover privately (close-to-balance, top-up, operator pause) → claims and live evidence.

### Stage 2 preflight

| Skill | Project-specific use | Status | Fallback |
|---|---|---|---|
| blockchain-developer | FleetPool contract: caps, draws, exit, queued spend, operator claim | installed | Follow the existing Solidity/viem conventions in `contracts/fleet` and `src/fleet`. |
| solidity-security | Review pool custody invariants, exit path, reentrancy, cap bypass, ABI separation | installed | Manual review against data-model invariants and the ABI-separation test. |
| test-driven-development | Every task pairs a failing test with its implementation | installed | Keep red-green order visible in commits. |
| backend-architect | Ledger-from-chain, sweep idempotency, stateless settlement, redaction of ciphertexts | installed | Follow the Stage 1 stateless router patterns. |
| frontend-design | Balance page and activate-step states in the existing app shell | installed | Build from the existing fleet page components and tokens. |
| ui-revamp | Polish the Balance page and Control Room changes once working | installed | Hierarchy, density, and state-polish checklist. |
| code-reviewer | Diff review after each phase | installed | Review the diff against FR/SC and failure paths. |
| simplify | Simplify reviewed passing code | installed | Consolidate duplication without behaviour change. |

### Stage 2 phases

| Phase | Spec Kit tasks | done_when |
|---|---|---|
| Setup and foundation | T001–T012 | `./verify.sh pool-foundation` |
| US1 balance | T013–T019 | `./verify.sh pool-balance` |
| US2 fund and trade | T020–T027 | `./verify.sh pool-fund` |
| US3 control and recovery | T028–T033 | `./verify.sh pool-control` |
| Claims, observer, live | T034–T040 | `./verify.sh pool-acceptance` (T040 outward, recorded after) |

Traceability: approved design-stage2.md → FR-001–017 / SC-001–010 (specs/002) → COMP-101–106 → T001–T040 → `verify.sh pool-*`. File layout per `specs/002-private-funding-pool/plan.md`. Hard constraints: no new dependency; no transaction, event, log, or response may name both a depositor and a campaign; ciphertexts and the ledger key never appear in logs; caps and the exit are contract-enforced; no claim beyond FR-015; every `fleet-*` gate stays green. Upstream reports (Vercel, Robinhood RPC, Uniswap) are drafted with minimal repro, environment, expected, actual; posting follows `plan.md`. Goal.md wins on conflict.

## Stage 1 — Fleet Mission (live, kept green)

## Product stages

Fleet Mission is **Stage 1** (private gas) and is live; its choreography below is kept for regression. Stage 2 is live on testnet and is choreographed above, with its capped mainnet beta as the current build. Stage 3 (trustless shielded pool) has no build choreography here and earns its own `spec-dialogue` → Spec Kit → `build-prompt reconcile` flow when built. The honest constraint from Goal.md holds throughout: the claim is only ever what FR-015 permits, on either chain, and the pool being small on mainnet makes amounts guessable rather than hidden.

Build the core journey in order: eligible connect and fee review → local vault confirmation → ETH-funded activation → bounded five-account testnet buy → Control Room pause/revoke/Close.

## Preflight

| Skill | Project-specific use | Status | Fallback |
|---|---|---|---|
| blockchain-developer | Fleet account, paymaster, escrow integration | installed | Use existing Solidity and viem conventions with contract review. |
| solidity-security | session, escrow, terminal revoke review | installed | Manually review authorization, withdrawal, and state invariants. |
| web3-testing | policy and five-wallet coverage | installed | Use existing Hardhat/Node tests with explicit invariant cases. |
| test-driven-development | write failing Fleet tests first | installed | Keep red-green-refactor evidence in test ordering. |
| backend-architect | service mapping, idempotency, redaction | installed | Follow existing API/service adapter boundaries. |
| design | apply selected Fleet Mission UI direction | installed | Record token/state sheet from existing brand truth. |
| frontend-design | responsive dashboard construction | installed | Use accessible static-app components. |
| ui-revamp | polish the working selected dashboard | installed | Apply hierarchy/density/state-polish review. |
| emil-design-eng | responsive interaction judgment | installed | Review hierarchy, density, and responsive behavior. |
| animate | named activation/control state feedback only | installed | Add reduced-motion-safe state feedback. |
| review-animations | review changed Fleet motion | installed | Inspect changed motion for clarity and reduced-motion safety. |
| code-reviewer | post-build Fleet diff review | installed | Review requirements and failure paths manually. |
| simplify | simplify reviewed passing code | installed | Consolidate duplication without behavior change. |
| readme | later runnable-doc audit only | installed | Audit setup/copy/no assistant traces before README work. |

Brand gate is satisfied by the existing selected brand truth and Fleet Mission is the user-selected direction. No prototype, UI-library selection, new dependency, or new mark is authorized.

## Traceability

Approved design → FR-001–018 / SC-001–010 → COMP-001–006 → T001–T041 → `verify.sh` Fleet tags. There is no competition evidence: this is a user-selected direction with no supplied track, judge, deadline, quota, or disqualification facts.

## Phases

| Phase | Spec Kit tasks | done_when |
|---|---|---|
| Evidence/setup | T001–T008 | `./verify.sh fleet-evidence` |
| Foundational controls | T009–T016 | `./verify.sh fleet-foundation` |
| US1 fleet creation | T017–T024 | `./verify.sh fleet-create` |
| US2 bounded buy | T025–T032 | `./verify.sh fleet-buy` |
| US3 lifecycle/recovery | T033–T037 | `./verify.sh fleet-control` |
| Cross-cutting acceptance | T038–T041 | `./verify.sh fleet-acceptance` |

Write each mandated test first and observe it fail before implementation. Reuse selected brand assets. Draft upstream reports with minimal repro, environment, expected, and actual; posting remains governed by root `plan.md`. No plaintext keys, invented live dependencies, privacy overclaim, mainnet sponsorship, or scope expansion. Goal.md wins on conflict.

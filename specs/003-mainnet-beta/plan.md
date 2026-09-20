# Implementation Plan: The capped mainnet beta on Robinhood Chain

**Branch**: `003-mainnet-beta` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-mainnet-beta/spec.md`

## Summary

Open a capped, holders-only beta of the Stage 2 pool on Robinhood Chain mainnet,
running the journey testnet already proves with smaller caps and a short list of
checked tokens. The user-visible work is four surfaces: a holders gate, a
non-dismissible beta note carrying the custody sentence, an honest
withdrawal-refused state, and a token picker bound to a reviewed registry.

The bulk of the engineering is not user-visible: six correctness findings from
the 2026-09-19 readiness review must be closed first, because each one costs a
trader or the operator real money the moment the ETH is real. The approach is one
durable lifecycle for every money-moving write, a lock around each signed step,
one new pool bytecode carrying the reimbursement fix and the monitor counters,
and reuse of the bot's existing pool discovery and local quoting for the token
work.

## Technical Context

**Language/Version**: TypeScript 5.8 on Node 24; Solidity 0.8.35

**Primary Dependencies**: viem 2.46, Hardhat 3.4, OpenZeppelin 5.6,
`@neondatabase/serverless` for the shared store. No new dependency is introduced
by this feature.

**Storage**: Neon Postgres for shared service state (owed spend, locks,
idempotency, the new failure counters); the pool contract for money; a reviewed
repository file for the token registry.

**Testing**: `node --test` for the service, `hardhat test solidity` for contracts,
fork tests against 4663 for the venue work, `./verify.sh` as the
gate.

**Target Platform**: Vercel functions plus a static app, two deployments, one per
chain.

**Project Type**: Web service with a static front end and on-chain contracts.

**Performance Goals**: A sweep must post every due charge well inside the 12-hour
expiry window: reads through Multicall3 in one round trip, postings batched into
one transaction.

**Constraints**: The public RPC drops requests under burst. Functions have a
duration limit that `api/fleet/*` does not currently set. One chain per
deployment. No new dependency without asking. No commit over 200 changed lines
without asking.

**Scale/Scope**: 1 ETH pool cap, 0.1 per depositor, so roughly ten to twenty
depositors at launch. Four listed tokens at most. The scale that matters is not
users, it is the number of queued charges a sweep must clear.

## Constitution Check

`.specify/memory/constitution.md` was the unfilled template when this plan was
written. It has since been filled to record what the project already enforces
through `CLAUDE.md`, rather than inventing new principles. The gates below are
those rules, and this plan complies with them:

| Rule | How this plan meets it |
|---|---|
| No commit over 200 changed lines without asking | The work is sliced accordingly; the write lifecycle is two commits, not one |
| No new dependency | R5 and R6 both chose reuse specifically to avoid one |
| Never edit or delete a test to make it pass | The reproductions are flipped by adding siblings, and the one deleted invariant is replaced because the behaviour it asserted is the defect |
| Done means the predicate passed | Every acceptance outcome in the spec maps to a command in `quickstart.md` |
| Decisions route to a read-only pass first | This plan is that pass; implementation follows it |

## Project Structure

### Documentation (this feature)

```text
specs/003-mainnet-beta/
├── plan.md              # This file
├── spec.md              # 28 requirements, 13 measurable outcomes
├── research.md          # Phase 0: nine decisions, three verified on chain
├── data-model.md        # Phase 1: counters, owed-row states, registry entry
├── quickstart.md        # Phase 1: how to validate without spending
├── contracts/
│   ├── chain-adapter.md # The signed step every money write goes through
│   ├── pool.md          # The new pool bytecode's surface
│   └── token-registry.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2, written by speckit.tasks
```

### Source code

```text
contracts/fleet/
└── FleetPool.sol            # counters, claimable(), postQueuedBatch, donate

src/fleet/
├── chain-pool.ts            # nextNonce, signAndBroadcast, resolve; Multicall3 reads
├── pool-buy.ts              # reconcile before release; failure counter; grain comment
├── campaign-routes.ts       # lock each signed step; the refused-withdrawal response
├── store.ts, store-neon.ts  # sent state, txHash, nonce, campaign failure counter
├── pool-registry.ts         # reused as-is for discovery
├── market.ts                # reused as-is for local quoting
├── token-registry.ts        # new: load and validate the reviewed list
└── service-runtime.ts       # required env on mainnet; blockTime; alert sink

app/src/fleet/
├── page-shared.ts           # chain target, beta note
├── holders-gate.ts          # new: threshold, below-threshold and retry states
└── balance.ts               # caps from the pool, custody sentence at deposit

scripts/fleet-redeploy-live.ts   # (admin, operator); FLEET_ADMIN_ADDRESS; guardian
.github/workflows/               # verify.sh as a required check; no bot pushes to main
```

**Structure Decision**: The existing layout is kept. Two files are new
(`token-registry.ts`, `holders-gate.ts`); everything else is a change to a file
that already owns that concern. The venue work adds no new module because
`pool-registry.ts` and `market.ts` already do it for the bot.

## Sequence

Ordered by what unblocks what, not by size. Revised 2026-09-20 after analysis
found the rebase scheduled last when it rewrites the files the contract work
changes.

1. **The caps branch first.** Rebase `feat/mainnet-beta`, repair the deploy
   script, redeploy testnet, close T040, and confirm the caps read back from the
   bytecode. It is 145 commits behind and rewrites both `FleetPool.sol` and
   `scripts/fleet-redeploy-live.ts`; anything written before it is written twice.
2. **The write lifecycle** (M1, M4). Adapter first, then callers. Two commits.
3. **The lock per signed step** (M5). Depends on 2, because the signed step must
   exist before a lock can wrap it.
4. **The contract** (M2, part of M3), written on the rebased bytecode so the caps
   and these changes ship as one deployment.
5. **The sweep's operational fixes** (M3). Independent; can run in parallel.
6. **The safety rails**: automatic pause on the detectable triggers, the resume
   gate, alerting, the monitor.
7. **The four surfaces** and the registry (M6).
8. **The published-promise commit**, before anything goes live.
9. **Soak**, then the **fork rehearsal**, then open.

Steps 3, 5 and most of 6 are the co-developer's; the rest are the founder's. The
two meet in `chain-pool.ts`, and step 2 lands before step 3 starts.

## Complexity Tracking

No constitution gates exist to violate. Two decisions are worth recording as
deliberate complexity:

| Decision | Why needed | Simpler alternative rejected because |
|---|---|---|
| Two reconciliation mechanisms (adapter by hash, caller by observable state) | The adapter cannot protect a caller that reads its own exception as proof nothing happened | One mechanism leaves whichever layer it omits unprotected; the reproductions replace the adapter entirely and would pass a hash-only fix |
| Per-token slippage bound rather than one global figure | A hook's fee is outside the local quote, so one figure either refuses every buy on a hooked pool or is too loose for a thin one | A single bound cannot be both, and there is no Quoter on 4663 to make the quote exact |

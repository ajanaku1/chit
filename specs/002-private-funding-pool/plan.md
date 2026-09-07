# Implementation Plan: Private Funding Pool

**Branch**: `002-private-funding-pool` | **Date**: 2026-09-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-private-funding-pool/spec.md`

## Summary

Replace Stage 1's per-campaign, owner-named escrow with a shared pool that takes
fixed-size deposits carrying no campaign identifier, funds fleet accounts' gas
headroom after a random delay and their trade principal just in time per buy,
and queues spend against depositors and posts it after a random delay in transactions
that never also name a campaign. Custody-relevant state lives on-chain; the depositor-to-campaign
mapping is stored on-chain encrypted to the operator. Traders hold one balance,
draw from it per campaign, withdraw through Chit, and can exit through the
contract after 24 hours without Chit. Testnet only.

## Technical Context

**Language/Version**: TypeScript on Node 24 (Vercel) and Node 26 locally; Solidity 0.8.35 in the existing Hardhat 3 project.
**Primary Dependencies**: Existing viem, Hardhat, esbuild static app, Vercel functions and cron, Node crypto; no dependency additions.
**Storage**: On-chain `FleetPool` for all custody state; operator-encrypted depositor reference stored on-chain per draw; no service database.
**Testing**: Existing Node test runner and Hardhat fork tests on the pinned 46630 fork; tests written before each implementation task.
**Target Platform**: chit.tools (Vercel: static site at `/`, app at `/app`, functions at `/api`), Robinhood Chain testnet 46630.
**Project Type**: Static browser app, service functions, smart contracts, SDK.
**Performance Goals**: Funding completes 1 to 15 minutes after activation; withdrawal paid within 10 minutes; balance page loads with one chain scan of open draws.
**Constraints**: No new dependencies; no plaintext depositor-to-campaign link on-chain or in logs; no transaction names both a depositor and a campaign; caps and exit enforced by the contract; Stage 1 gates stay green.
**Scale/Scope**: Testnet pool cap 5 ETH; tens of open draws; one operator.

## Constitution Check

The constitution remains an unratified template. Workspace laws control: no new
dependencies, no touching secrets unattended, tests never edited to pass,
commits under 200 lines, done means `verify.sh` green. No violation.

## Major Components

- **COMP-101 FleetPool contract**: deposits in fixed sizes with caps and pause; per-depositor deposits and posted spend; exit request and execution after 24 hours; draws keyed by campaign with encrypted owner reference and due time; principal funding, gas seeding, commit and rollback per draw; operator claim of posted spend.
- **COMP-102 Pool ledger service**: balance computation from chain (deposits − posted spend − open draws decrypting to the depositor); draw opening at activation with random due time; sweep of due draws; just-in-time buy settlement issuing the campaign-keyed and depositor-keyed transactions; withdrawal payout from the operator wallet plus spend posting; encryption helper.
- **COMP-103 Fleet API extensions**: `balance`, `deposit-intent` (headroom and allowed sizes), `withdraw`, `exit-status`, `activate` with draw, `topUp`, `close` crediting balance; `sweep` endpoint for cron and opportunistic sweeps; restore-from-chain extended to draws.
- **COMP-104 Browser Balance page and wizard changes**: Balance page (deposit picker with headroom, withdraw form with destination warning, exit card); wizard activate step with draw and "Funding your fleet" state; Control Room balance strip and per-campaign draw figures; close-to-balance messaging.
- **COMP-105 Claims and copy**: FR-015 wording in app, landing, marketing; removal of Stage 1's "No trail back to you" until Stage 2 is live.
- **COMP-106 Pool verification suite**: `verify.sh` tags `pool-foundation`, `pool-balance`, `pool-fund`, `pool-control`, `pool-acceptance`; an event-scan test that a fresh observer cannot join depositor to fleet accounts.

## Project Structure

### Documentation (this feature)

```text
specs/002-private-funding-pool/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── pool-contract.md
│   ├── pool-api.md
│   └── pool-ui.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
contracts/fleet/FleetPool.sol
src/fleet/pool-ledger.ts          # balance, draws, ciphertext helper
src/fleet/chain-pool.ts           # viem adapter for FleetPool
src/fleet/pool-buy.ts             # just-in-time settlement
src/fleet/campaign-routes.ts      # pool-backed actions added
src/fleet/service-runtime.ts      # pool config from env, ledger key
api/fleet/balance.js, api/fleet/sweep.js
app/balance.html, app/src/balance-page.ts, app/src/fleet/balance.ts
app/fleet.html, app/fleet-dashboard.html, app/fleet-privacy.html (changed)
app/src/fleet-page.ts, app/src/fleet-dashboard.ts, app/src/fleet/index.ts, app/build.mjs (changed)
landing/public/index.html, marketing/CHIT-UPDATE-AND-TOKEN.md, marketing/CHIT-COMMUNITY-BRIEF.md (claim copy)
scripts/fleet-pool-deploy-live.ts, deployments/fleet-46630.json (pool, pooledBuy records), IMPLEMENTATION.md
test/fleet/pool-abi.test.ts, test/fleet/pool-ledger.test.ts, test/fleet/balance-route.test.ts,
test/fleet/activate-draw-route.test.ts, test/fleet/pool-control-route.test.ts
test/fork/fleet-pool.test.ts, test/fork/fleet-pool-exit.test.ts, test/fork/fleet-pool-draw.test.ts,
test/fork/fleet-pool-balance.test.ts, test/fork/fleet-pool-fund.test.ts, test/fork/fleet-pool-control.test.ts,
test/fork/fleet-pool-observer.test.ts
app/test/fleet-balance.test.ts, app/test/fleet-activate-draw.test.ts, app/test/fleet-claims.test.ts,
app/test/fleet-control-room.test.ts (changed), landing/test/landing.test.mjs (changed)
vercel.json (cron entry), verify.sh (pool tags)
```

**Structure Decision**: Stage 2 extends the existing `fleet` namespaces rather
than adding new ones; Stage 1 files change only where the pool replaces the
escrow. The Stage 1 escrow and its tests stay for Stage 1 campaigns.

## Delivery Phases

1. Pool foundation: failing fork tests for deposits, caps, pause, exit, draws, commit/rollback, claim; `FleetPool.sol`; ledger math and ciphertext round-trip tests and implementation.
2. Balance: failing API and browser tests for balance, headroom, withdraw, exit status; service and page.
3. Fund and trade: failing tests for activation with draw, due-time sweep across a fresh instance, just-in-time buy settlement and rollback; implementation; cron entry.
4. Control and claims: close-to-balance, top-up, operator pause; FR-015 copy in app, landing, marketing with tests.
5. Acceptance: observer unlinkability scan over 46630 events; live deploy of the pool; first pooled buy through chit.tools; Stage 1 gates green.

## Complexity Tracking

No constitution violation requires justification.

## Plan review decisions (2026-09-07)

- Vercel Pro confirmed: per-minute cron drives the sweep (funding due draws and posting due queued spend); every state-changing request also sweeps.
- Depositor-keyed spend posting is queued on-chain with a random 1 to 15 minute due time and posted by the sweep, not in the same transaction window as the campaign-keyed settlement.

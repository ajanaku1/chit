# The decision to open the beta (FR-040, T093)

**Decision: NOT TAKEN.** Nothing here says the beta may open. It opens when
every row below reads *met* or *met on the day* with its evidence filled in,
and the founder writes the date and the word in the last line of this file.
Until that line is written, the answer to "is the beta cleared to open" is
no, whatever else is green.

**Drafted**: 2026-09-22, from what is on file. Rows marked *pending* name
what is still missing and whose it is. The evidence column points at the
test, the record or the pull request that shows it; nothing here rests on a
description of intent.

## Acceptance outcomes

| Outcome | What must be true | Evidence on file (2026-09-22) | Status |
|---|---|---|---|
| SC-001 | No depositor charged for a buy that did not happen, none charged twice | Sign→record→broadcast→wait lifecycle with `mined`/`reverted`/`unknown` outcomes and `resolve` for the unknown (`chain-pool-writes.test.ts`); sent state per hash and nonce, `resolveSent` confirmed/owed/void (`pool-sweep.test.ts`); idempotency keys scoped per action (`campaign-routes.ts`) | met in code; observed across the beta |
| SC-002 | Every depositor who asks to leave is paid within the delay, with or without Chit | `requestExit`/`executeExit` on the contract, 24 h, no operator path (`fleet-pool-exit.test.ts`); an exit completes while paused and with the operator's nonce unchanged (`mainnet-rehearsal.test.ts`, PR #26) | met |
| SC-003 | Every withdrawal ends paid or refused in the same session, none left owed | Record before pay, refusal before anything is recorded (`WithdrawalRefused`, `pool-sweep.test.ts` "withdraw"); the refused state on the Balance page with the exit beneath it (`withdrawal-refused.test.ts`, PR #22) | met in code; observed across the beta |
| SC-004 | No charge expires unrecorded | Automatic pause on `charge-expired` from the scheduled sweep, bounded by the last resume (`pool-sweep.test.ts` T050; on the real contract in `mainnet-rehearsal.test.ts`); 48 h soak with alerting on (T088) | **pending**: T088 waits on alerting (T048/T049, Boye) |
| SC-005 | The most a depositor can lose to a contract fault is the pool cap, said on every page before depositing | Caps immutable at construction (`FleetPool.sol`, `FleetPool.t.sol` BadCaps); FR-006's three facts and the caps-until-audit sentence on every page and beside the deposit amount (`beta-note.test.ts`, PR #17, PR #25) | met |
| SC-006 | Each listed token's buy lands within its bound, checked on the real pool | All three enabled entries on the 4663 fork at block 69,746,534 (`token-registry.test.ts`, reproduced founder-side 2026-09-22): CHIT 2.00 % under a 300 bps bound, HEY and ORUS 3.00 % under a 400 bps bound — the bound is each pool's hook fee plus 100 bps of real slippage; `price_moved` refusal per slice before any send (PR #21) | met for the enabled set; re-run on the day |
| SC-007 | Every launch token holds ≥ 50× the draw cap, confirmed on the day | `npm run registry:liquidity` (PR #28) is the day's one command and exits 1 under the floor. Fork measure 2026-09-22, all three at least 3× clear of the floor: CHIT 8.71 ETH (174×), HEY 8.12 (162×), ORUS 8.79 (176×) | met on the day: T091 |
| SC-008 | A non-holder can use the product free and never mistakes the chain | Holders gate shows holdings, threshold, where to buy, where the testnet is, no error state (`holders-gate.test.ts`, PR #18); both hosts built from one source and held apart, each naming its own chain, the session factory per chain, the bundle's default its own (`app/test/two-hosts.test.ts`, PR #30, T081) | **pending**: the second deployment itself (T080, founder's Vercel) |
| SC-009 | An observer with public data can confirm the pool holds what it owes | `everDeposited`, `exitsPaid`, `totalPosted`, `donated` public; `pool-solvency.ts` owed = everDeposited − exitsPaid − totalPosted; `npm run fleet-resume-check` (`resume-gate.test.ts`) | met |
| SC-010 | Losses alert immediately, unrecorded charges within 4 h, the rest daily; nothing passes silently | — | **pending**: T048/T049 (Boye); `./verify.sh beta-rails` red on the alert condition |
| SC-011 | No published sentence claims an audit precedes mainnet | `./verify.sh beta-launch` PASS; the published-promise commit, PR #25 | met; the corrected copy ships on the next production deploy, before the opening change (FR-008) |
| SC-012 | The three pause triggers rehearsed; the guardian's pause without the operator | `mainnet-rehearsal.test.ts` on the 4663 fork at block 69,633,641: charge-expired and exit-failed from the sweep, the loss trigger by the guardian inside 15 min, operator nonce unchanged (PR #26) | met |
| SC-013 | No campaign costs more than three failed buys' gas in an hour; no lock-out from a refusal that spent nothing | Failure counter: three gas-spending failures in an hour close a campaign for an hour, refusals that spent nothing do not count (`campaign-cooldown.test.ts`, PR #21) | met in code; observed across the beta |
| SC-014 | Every pause automatic or within 15 min; every resume preceded by a published account | Automatic pause (above); resume gate refuses without an incident record and a whole pool (`resume-gate.test.ts`, `incidents/README.md`) | met in code; observed across the beta |
| SC-015 | The operator never owed more than its float without an alert | Float 0.2 ETH, alert at 0.1 (`FLEET_OPERATOR_FLOAT_ETH`, spec clarification); a payout the float cannot cover is refused, never fronted (`operator_float_short`, `pool-buy.ts`) | **pending** on the alert half: T048/T049 |
| SC-016 | The announcement says who may deposit exactly as the product enforces | Holders-only in the Telegram post and X thread (`marketing/CHIT-BETA-ANNOUNCEMENT.md`, PR #25); the gate reads `CHIT_FEE_THRESHOLD` | met on the day: threshold filled in and read back from the live host before posting |

## The fork rehearsal FR-040 names

| Condition | Evidence | Status |
|---|---|---|
| Deployed caps read back as specified (0.1 / 0.05 / 1) | `mainnet-rehearsal.test.ts` T089, contract and service reads | met |
| Deployment refused without a guardian | `guardianFromEnv` refuses absent and operator-equal guardians (`deploy-guards.ts`, rehearsal T089) | met |
| Each listed token's quote and execution agree within its bound | CHIT, `token-registry.test.ts` | met for CHIT; the day's run for the enabled set |
| The guardian can pause without the operator | rehearsal T089/T090 | met |
| An exit completes while paused | rehearsal T089 | met |

## Before the word is written

- [ ] T088: 48 h soak on testnet from the same code, alerting on, no charge unrecorded beyond 4 h
- [ ] T091: liquidity re-measured for every enabled entry on the day
- [ ] T092: every deployed contract verified on the explorer (`npm run explorer:verify:mainnet`; by hand behind the explorer's challenge)
- [ ] T080: the second Vercel deployment live at `testnet.chit.tools` (T081's
      confirmation is met: `app/test/two-hosts.test.ts`, PR #30)
- [ ] FR-043: the alert receiver named
- [ ] The published promise deployed to production before the opening change (FR-008)

---

**The decision, written by the founder when the list above is empty:**

> Date: __________  Decision: __________  Signed: __________

Unsigned, this file is a status board, not a clearance.

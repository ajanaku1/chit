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
| SC-004 | No charge expires unrecorded | Automatic pause on `charge-expired` from the scheduled sweep, bounded by the last resume (`pool-sweep.test.ts` T050; on the real contract in `mainnet-rehearsal.test.ts`). Alerting is in (PR #35, `./verify.sh beta-alerts` PASS). The soak's own predicate is `npm run fleet-soak`, which samples the pool and refuses to pass a run that is short, broken by silence, paused, short of what it owes, or carrying a charge past four hours | **pending**: the 48 h run itself, which starts at the next production deploy |
| SC-005 | The most a depositor can lose to a contract fault is the pool cap, said on every page before depositing | Caps immutable at construction (`FleetPool.sol`, `FleetPool.t.sol` BadCaps); FR-006's three facts and the caps-until-audit sentence on every page and beside the deposit amount (`beta-note.test.ts`, PR #17, PR #25) | met |
| SC-006 | Each listed token's buy lands within its bound, checked on the real pool | All three enabled entries on the 4663 fork at block 69,746,534 (`token-registry.test.ts`, reproduced founder-side 2026-09-22): CHIT 2.00 % under a 300 bps bound, HEY and ORUS 3.00 % under a 400 bps bound — the bound is each pool's hook fee plus 100 bps of real slippage; `price_moved` refusal per slice before any send (PR #21) | met for the enabled set; re-run on the day |
| SC-007 | Every launch token holds ≥ 50× the draw cap, confirmed on the day | `npm run registry:liquidity` (PR #28) is the day's one command and exits 1 under the floor. Fork measure 2026-09-22, all three at least 3× clear of the floor: CHIT 8.71 ETH (174×), HEY 8.12 (162×), ORUS 8.79 (176×) | met on the day: T091 |
| SC-008 | A non-holder can use the product free and never mistakes the chain | Holders gate shows holdings, threshold, where to buy, where the testnet is, no error state (`holders-gate.test.ts`, PR #18); both hosts built from one source and held apart, each naming its own chain, the session factory per chain, the bundle's default its own (`app/test/two-hosts.test.ts`, PR #30, T081) | **pending**: the second deployment itself (T080, founder's Vercel) |
| SC-009 | An observer with public data can confirm the pool holds what it owes | `everDeposited`, `exitsPaid`, `totalPosted`, `donated` public; `pool-solvency.ts` owed = everDeposited − exitsPaid − totalPosted; `npm run fleet-resume-check` (`resume-gate.test.ts`) | met |
| SC-010 | Losses alert immediately, unrecorded charges within 4 h, the rest daily; nothing passes silently | — | **pending**: T048/T049 (Boye); `./verify.sh beta-rails` red on the alert condition |
| SC-011 | No published sentence claims an audit precedes mainnet | `./verify.sh beta-launch` PASS; the published-promise commit, PR #25 | met; the corrected copy ships on the next production deploy, before the opening change (FR-008) |
| SC-012 | The three pause triggers rehearsed; the guardian's pause without the operator | `mainnet-rehearsal.test.ts` on the 4663 fork at block 69,633,641: charge-expired and exit-failed from the sweep, the loss trigger by the guardian inside 15 min, operator nonce unchanged (PR #26). Rehearsed again 2026-09-27 by the live guardian on the testnet pool, both routes, each pause resumed by the admin between: through the brake page `0xac5a7649…` 08:31:13 UTC, and by hand from the wallet with raw `0x8456cb59` and no page `0xe1f9c470…` 08:50:29 UTC. `PausedSet(true)`, then `paused()` true, verified from a third machine each time | met |
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

- [x] T088: soaked, with an exception recorded below rather than a pass.

### The soak's exception (T088, SC-004), decided 2026-09-25

The run that stands began 2026-09-24 22:15 UTC. It carries gaps — a laptop
lid closed twice while its owner slept — so `npm run fleet-soak` ends on "not
passed: silence", and it will say that however long the run goes, because a
gap is permanent in a record. The founder decided to accept it rather than
restart a fourth time, and to run an unbroken soak at the full mainnet
launch instead. The reasoning, recorded so it can be argued with later:

- the beta is capped at 1 ETH, so what an undetected slow failure can cost is
  bounded by the cap rather than by how long it went unseen;
- FR-026's pause fires inside the service and does not wait for a person to
  read a line, so the watching is a second line of defence, not the first;
- the monitor ran 17 times across the window and covers part of the silence;
- the runs that came before it are archived and are not nothing: they found a
  scheduled sweep that had silently stopped, a buyback keeper dead for two
  days, a site serving its own 25-hour-old cache, and a monitor that runs
  every 4.7 hours while scheduled hourly. Every one of those was invisible
  from outside and all but one is fixed.

What it does not cover: a slow failure that none of those runs happened to
provoke. That is the cost of the decision and it is the founder's to carry.
- [ ] T091: liquidity re-measured for every enabled entry on the day
- [ ] T092: every deployed contract verified on the explorer (`npm run explorer:verify:mainnet`; by hand behind the explorer's challenge)
- [x] T080: `testnet.chit.tools` is live and serves the app and the service.

### What is left before the word is written, 2026-09-25

Ordered by who can unblock it, because three of these are one person's alone.

**The founder's, and nobody else can do them**

- [ ] a **new mainnet operator key**, fresh rather than the testnet one, funded
      with about 0.25 ETH — 0.02 for the deploys, 0.2 as the float, a little
      margin. Separate on purpose: the testnet key has been on laptops, in
      `.env` and across hosts, and mainnet should not inherit that history.
      It must be neither the admin nor the guardian, or the deploy refuses.
- [ ] the **CHIT threshold** for the holders gate, in base units. It is in the
      gate and in the announcement, and both carry a placeholder until it is
      decided. A positioning decision, not a technical one.
- [ ] the **DNS record** for `app.chit.tools`, at the registrar.
- [ ] the **deploy itself** (§ 3), which signs with the operator key.

**Held elsewhere**

- [x] the **guardian key** (FR-009). Boye declined, for the right reason: a
      guardian who is late is worse than one who is absent, and he is one
      person in one timezone with no on-call arrangement, so naming him would
      have bought a name in a document rather than a second pair of hands.
      **Lucian holds it**, and gave an arrangement rather than a name:

      - reachable 10:00–02:00 UTC+3, daily, at `@algo_cats`; asleep outside those
      - he pauses first and discusses after, if asked
      - he pauses on his own judgement if he sees something bad and cannot reach
        the founder

      It is not the only brake and nothing is uncovered while he sleeps: the two
      machine-detectable triggers pause the pool inside the service without
      waiting for a person, and the operator and the admin can pause too. The
      guardian is the separation of the pause from the operator, not the cover.

      **It holds about 0.005 ETH, and that is deliberate.** An earlier draft of
      this file said it holds nothing, which was wrong: `pause()` is a
      transaction. Measured on 4663, a pause costs about 0.0000021 ETH, so the
      dust covers roughly two thousand calls. A guardian that cannot pay for
      its own call is the late guardian by another route.
- [ ] a **new empty database** for mainnet, never used by testnet (§ 4c).
- [ ] the **bot's scheduled jobs**, starved on the app host since the hosts
      split: `orders` and `watch` have had no `TELEGRAM_BOT_TOKEN`,
      `BOT_KEY_SECRET` or `BOT_USERNAME` there.

**On the day, one command each**

- [ ] T091 liquidity re-measured for every enabled entry
- [ ] T092 every deployed contract verified on the explorer
- [ ] T094 deploy with the guardian, and open

**One trap to close before `app.chit.tools` exists.** It will build the same
`vercel.json` and inherit all six crons, including the buyback keeper. If the
playground still holds `BUYBACK_KEEPER_KEY` then, two hosts race one key on a
path that spends real ETH. The key moves; it is not copied.
- [ ] FR-043: the alert receiver named
- [ ] The published promise deployed to production before the opening change (FR-008)

---

**The decision, written by the founder when the list above is empty:**

> Date: __________  Decision: __________  Signed: __________

Unsigned, this file is a status board, not a clearance.

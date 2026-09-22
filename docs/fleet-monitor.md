# The outside monitor

A small program that looks at the pool from where anyone can look, once an
hour, and says what is wrong. It reads public chain state and asks the hosted
service one public question. It holds no key, so it cannot open a sealed
depositor, and nothing it reports names one.

It exists because the expensive failures here make no noise. A charge that is
not posted inside `POST_WINDOW` can never be posted, and nothing on the
service's side has to notice. A service configured with the wrong pool answers
503 to everything and looks, from inside, like a quiet day.

This page is the whole thing: what it checks, how to run it, what each finding
means and what to do first.

## Run it

```
node src/fleet/monitor-cli.ts                      # the testnet pool, from deployments/fleet-46630.json
node src/fleet/monitor-cli.ts --record <record>    # another deployment record
```

Node 22.18 or newer, and nothing else: no install, no build. The three files
(`monitor.ts`, `monitor-reads.ts`, `monitor-cli.ts` in `src/fleet/`) import no
package, and node runs the TypeScript as it is. A run is six requests and
under two seconds on the pool of 16 September. Exit code 1 when a finding is
critical or when the monitor could not read; 0 otherwise.

`.github/workflows/monitor.yml` runs it at 23 past every hour. It is on GitHub
and not on Vercel on purpose: every other clock in the repo ends at a Vercel
function, so an outage there stops the posting and would stop a monitor beside
it too. Any other machine with node can be a second clock.

| Variable | What it does |
|---|---|
| `MONITOR_RPC_URL` | The RPC to read. Otherwise `ROBINHOOD_TESTNET_RPC_URL` or `ROBINHOOD_MAINNET_RPC_URL`, by the record's chain id, then the public endpoint. |
| `MONITOR_SITE_URL` | For example `https://chit.tools`. Asks the hosted service which pool it is configured with. Left out, the site is not checked. |
| `FLEET_OPERATOR_FLOAT_ETH` | The operator's float, the one variable the service reads too (0.2 for the beta's 1 ETH pool). The warning sits at half of it. Left out, the warning falls back to 0.05, which only means "can still pay gas". |
| `MONITOR_OPERATOR_CRITICAL_ETH` | The balance under which the finding is critical, 0.01 by default: the operator can barely pay gas. |
| `TELEGRAM_BOT_TOKEN`, `MONITOR_CHAT_ID` | Where findings go: the operator chat. Critical ones every run, warnings alone every sixth hour. Never `TELEGRAM_CHAT_ID`: that is the group, and the monitor refuses to know it. Without both, the run prints, and a critical finding still fails it. |
| `MONITOR_DIGEST_HOUR_UTC` | The hour of the daily digest, 7 by default. |

## How it reads

Everything is read at one block, twenty behind the tip, through Multicall3, so
the pool's balance and the counters it is compared with are the same instant
and the number of requests does not grow with the queue. Twenty behind,
because the public RPC answers from several nodes and one in four calls pinned
to the newest block was refused by a node that had not seen it yet.

What it expects comes from the deployment record, not from this page: the
pool's address, the operator, the admin, and the guardian if the record names
one.

## What it finds, and who acts

Summaries are aggregate: counts, totals, ages. Queue ids and campaign keys,
public as they are, are printed in the run's log and are not sent.

Everything goes to one chat, and every line says who is expected to act
(settled on 21 September 2026). **Operations** is the sweep, the RPC and the
functions. **The money path** is the operator's balance, a charge left
unposted, a buy left open. **Both**, at once, is whatever may end in a pause,
and the pause itself. Of the three pause triggers, two can be seen from
outside: a pool that holds less than it should is `accounting`, and a charge
past its deadline unrecorded is `charge-expired`. The third, an exit
transaction that failed, leaves nothing in the pool's views, so it has to be
reported where it happens. The table is `ACTS` in `monitor.ts`; who the roles
are is not in the public mirror.

| Finding | Severity | Acts | Means | First response |
|---|---|---|---|---|
| `accounting` | critical | both | The pool holds less than its own counters allow: ETH left without being counted. On a pool with `everDeposited`, `exitsPaid` and `donated` the identity is exact, and a surplus is a warning. | Pause. Compare the pool's transactions since the last clean run with the counters. |
| `charge-expired` | critical | both | A charge passed `POST_WINDOW` unposted. Nobody can be charged for it any more. | Work out what it cost and who carries it, make it whole, then record it (below). |
| `charge-at-risk` | critical | both | An unposted charge has under a sixth of its window left (two hours of twelve). The four-hour warning was not enough. | Run the posting sweep by hand now; read its report for the reason. |
| `charge-ageing` | warn | money path | A charge has been unposted for over four hours: two posting runs were missed or failed. | Look at the last sweeps' reports and the function logs. |
| `operator-balance` | warn, critical | money path | The operator is under a threshold. The warning belongs at half the float. | Top it up; if it fell fast, find out why. |
| `reservation-open` | warn | money path | A draw holds a reservation: a buy was funded and neither committed nor rolled back. A reservation normally lives for seconds. | Find the buy; commit or roll back. |
| `roles` | critical | both | The operator, the admin or the guardian on chain is not the one in the deployment record. | If it was deliberate, the record is stale: fix it. If not, treat the key as lost. |
| `site-pool` | critical | both | The hosted service is configured with another pool than the recorded one, or with none. | Fix `FLEET_POOL_ADDRESS` in the production environment. |
| `paused` | warn | both | The pool is paused. Exits still work. | Make sure whoever paused it meant to. |
| `site-down` | critical | operations | The hosted service did not answer, twice. | Vercel status, then the function logs. |
| `draw-overdue` | warn | operations | A fleet is still unfunded an hour after its due time. | The sweep is not running, or funding fails: read its report. |
| `chain-stale` | warn | operations | The newest block is more than fifteen minutes old. Every figure in the run is that old. | Check the chain and the RPC before trusting anything else in the run. |
| `monitor-blind` | critical | operations | The monitor could not read, twice, or the RPC is another chain than the record. | Run it by hand; if the public RPC is the problem, give it `MONITOR_RPC_URL`. |

**The daily digest** goes out in the run of 07:00 UTC, findings or not: what
the pool holds, how many charges and how many unposted, the operator's
balance, and either the findings or "nothing to report". Nobody has to act on
it. It is there because a monitor that only speaks when something is wrong
cannot be told from one that died: a day without a digest is itself a signal.

## What the service reports itself

Two failures leave nothing for an outside reader to find, so the service says
them (T048, T049, FR-023). A sweep that threw wrote nothing at all, and a
withdrawal that was refused never reached the chain. `src/fleet/alerts.ts` is
the sink: the same chat, the same "who acts", and three timescales. `NOW` and
`4H` go out when they happen — the class is an upper bound on when an operator
learns of it, and the line says which one it is — and `DAY` lines are held in
the store and sent as one digest by the first scheduled sweep past the digest
hour. A failure that cannot be classified takes the faster class.

| Alert | When | Acts | Means | First response |
|---|---|---|---|---|
| `withdrawal-refused` | now | money path | A depositor asked for their money and did not get it. The reason travels with it (`operator_float_short`, `payout_reverted`, `OperatorLockLost()`). Never the payee, never the amount. | Read the reason. A short float is topped up; anything else is a refusal to explain before the next one. |
| `sweep-failed` | 4h | operations | The scheduled sweep threw. Nothing was queued or posted this run; what it did not queue still has its deadline. | The function's logs. If the next sweep also fails, post by hand. |
| `charges-unreadable` | 4h | money path | A due charge cannot be opened with this ledger key, so it will expire unposted whatever the next sweep does. | `FLEET_LEDGER_KEY` is wrong or was rotated. Nothing else will fix it. |
| `postings-failed` | daily | money path | Postings that failed and will be tried again while their window is open. | Read the reasons in the digest; if the same charge keeps failing, it becomes `charge-at-risk` here. |
| `sweep-unreachable` | 4h | operations | The four-hourly workflow could not start a sweep at all: the function did not answer. Raised by `.github/workflows/sweep.yml`, because nothing inside the service runs when the service is the problem. | Vercel status, then the function logs. |

The service needs `TELEGRAM_BOT_TOKEN` and `MONITOR_CHAT_ID` in its own
environment, the same two values the monitor's workflow has. Without them the
alerts are logged and not sent, which is what a preview and a local run want.

## After an expired charge

An expired charge stays on chain for good, so it would be reported for good.
When it has been dealt with, write it down in `deployments/monitor-<chainId>.json`:

```json
{ "acknowledged": [{ "id": "0x…", "note": "made whole by 0x… on 2026-10-02" }] }
```

The id is the one in the run's log. The monitor leaves acknowledged charges
out of `charge-expired`. The file is a record of decisions; it changes nothing
on chain.

## What it does not do

It does not watch the events between two runs, so a balance that dips and
recovers inside an hour is not seen. It does not know who a charge belongs to,
and cannot. It does not act: it reads and reports, and the run's exit code is
its only side effect besides a message to its own chat.

And it sees only what the chain and one public question show. A sweep that
failed, a function that timed out, a red CI run and a refused withdrawal all
happen where an outside reader cannot look. The monitor sees what a failed
sweep leaves behind (a charge ageing, a fleet unfunded), hours later; the
failure itself has to be reported by the workflow or the service it happened in.

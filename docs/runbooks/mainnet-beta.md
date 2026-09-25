# Runbook: the capped beta on Robinhood Chain mainnet (4663)

What was agreed on 2026-09-16: a beta on mainnet, holders first, capped on
purpose, labelled as a beta and as not audited by a firm, after the audit
fixes are live. This is the whole sequence. Everything on chain runs with the
operator key; everything else is a variable in Vercel.

The same audited bytecode runs on both chains. What differs is three
constructor arguments and a JSON file:

| | testnet 46630 | mainnet beta 4663 |
|---|---|---|
| pool cap | 5 ETH | **1 ETH** |
| per depositor | 0.5 ETH | **0.1 ETH** |
| per draw | 0.2 ETH | **0.05 ETH** |
| deposit sizes | 0.01 / 0.05 / 0.1 | same |
| admin | required (`FLEET_ADMIN_ADDRESS`, never the deployer) | same |
| guardian | optional | **required** (the script refuses without one) |
| access | open | **holders only** (CHIT threshold, env) |
| app note | none | "Beta on Robinhood Chain: capped at 1 ETH…" on every page |

The most anyone can lose to a bug the firm audit has not looked at yet is
the pool cap. That is the reason the beta is safe to open, and it is said on
the page and in the announcement.

## 0. Before: testnet first

- [ ] `audit/contract-fixes` merged; `feat/mainnet-beta` merged on top (caps at
      deployment, chain from the environment, the app reads its chain from
      `chain-target.json`).
- [ ] The testnet redeploy done and T040 run (docs/runbooks/redeploy-after-audit.md).
      Mainnet gets what testnet proved, nothing that only exists on paper.

## 1. Keys and ETH

- [ ] The operator key, funded on mainnet with about 0.02 ETH (deploys are a
      fraction; the rest is the operator's float for fronting gas).
- [ ] The **cold admin key**, not the deployer's: it accepts the admin role on
      the policy and the pool with one `acceptOwnership()` each after the
      deploy, and is the only key that can unpause or rotate the operator. Its
      address goes in `FLEET_ADMIN_ADDRESS`.
- [ ] A **guardian key** that is not the operator's: a hardware wallet or a
      second key kept apart. It can only `pause()`. Its address goes in
      `FLEET_GUARDIAN_ADDRESS`.
- [ ] **Dust on the guardian, about 0.005 ETH.** `pause()` is a transaction and
      a guardian that cannot pay for it is the late guardian, which is worse
      than an absent one. Measured on 4663 on 2026-09-25: gas at 0.036 gwei, a
      pause about 0.0000021 ETH, so 0.005 covers roughly two thousand calls and
      survives a hundredfold spike. Dust rather than a relayer or a signed
      message someone else broadcasts: at the moment it is needed, the fewest
      moving parts wins. It is the only ETH that key ever holds.
- [ ] The CHIT threshold for access, decided (in CHIT base units; the token
      has 18 decimals, so 1,000 CHIT is `1000000000000000000000`).

## 2. Rehearse on a fork of mainnet, no ETH spent

```bash
BLOCK=$(( $(curl -s https://rpc.mainnet.chain.robinhood.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r .result) - 64 ))
npx hardhat node --chain-id 4663 --chain-type l1 --fork https://rpc.mainnet.chain.robinhood.com --fork-block-number $BLOCK --port 8549 &
sleep 20
curl -s http://127.0.0.1:8549 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}'

cp app/chain-target.json /tmp/chain-target.bak
FLEET_CHAIN_ID=4663 FLEET_RPC_URL=http://127.0.0.1:8549 \
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
FLEET_GUARDIAN_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
FLEET_ADMIN_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
npm run fleet-redeploy:live
cp /tmp/chain-target.bak app/chain-target.json && rm deployments/fleet-4663.json
```

Expected: escrow, policy, factory and pool deployed, `setPool`,
`setGuardian`, the admin role offered to `FLEET_ADMIN_ADDRESS` on the policy
and the pool, the caps read back as 0.1 / 0.05 / 1, the record and the
chain target written. Rehearsed on 2026-09-16 against mainnet block
63,969,832.

The rest of the rehearsal FR-040 and SC-012 ask for is a test on the same
kind of fork, run by hand before the day and nightly by `verify-full.yml`:

```bash
npm run test:fork:rehearsal   # test/fork/mainnet-rehearsal.test.ts
```

It deploys the beta's pool on the fork with the beta's caps and a guardian,
then: the caps read back as 0.1 / 0.05 / 1 (T089); deployment is refused
without a guardian and with a guardian that is the operator; the guardian
pauses without the operator signing anything, the operator cannot unpause,
and an exit completes while paused; and each of FR-026's three triggers is
fired (T090): a charge past its window unrecorded and an exit that would
fail, each pausing the pool from the scheduled sweep itself, and a
depositor's loss, paused by the guardian's hand inside the fifteen minutes
of FR-034. Six cases; passed 2026-09-22 against mainnet block 69,633,641.

## 2b. The soak (T088, FR-039)

Forty-eight hours on testnet from the same code, with alerting on. Alerting
only becomes live at a production deployment, and that deployment is started
by hand, so the order is: set the alert environment, deploy, then start the
run — a soak that began before alerting was on did not soak with alerting on.

```bash
npm run fleet-soak -- --watch     # a sample every 10 minutes; leave it running
npm run fleet-soak                # the verdict; exit 1 until it holds
```

`--once` takes a single sample and exits, for a cron where a long-lived
process is awkward. The verdict refuses a run that is short of forty-eight
hours, broken by more than thirty minutes of silence, paused at any sample,
short of what the pool owes, or carrying a charge unposted past four hours.
Silence fails on purpose: an hour nobody watched is not a soaked hour. The
samples are working notes and are not committed; the printed verdict is what
goes in `specs/003-mainnet-beta/decision.md` against SC-004.

## 3. Deploy

```bash
FLEET_CHAIN_ID=4663 FLEET_ADMIN_ADDRESS=0x…admin… FLEET_GUARDIAN_ADDRESS=0x…guardian… npm run fleet-redeploy:live
```

- [ ] commit `deployments/fleet-4663.json` and `app/chain-target.json`:
      `git commit -am "chore(deploy): the capped beta set on Robinhood Chain mainnet"`

The record and the chain target are the two files that make the app and the
docs say mainnet. Nothing else in the repo names the chain.

- [ ] verify every contract's source on the explorer (T092), from the same
      checkout that deployed:

```bash
npm run explorer:verify:mainnet
```

It reads `deployments/fleet-4663.json`, takes each contract's constructor
arguments from its own creation transaction, writes the standard-JSON input
and the encoded arguments to `verify/4663/<Contract>.json`, and submits each
unverified contract to Blockscout (`robinhoodchain.blockscout.com`). That
explorer answers scripts with a browser challenge (checked 2026-09-22), so
if the submission is refused, verify by hand: explorer → the address →
Contract → Verify & publish → "Solidity (Standard JSON input)", compiler
`v0.8.35+commit.47b9dedd`, upload the `input` from the export, paste
`constructorArguments`. A contract the script SKIPs was not deployed from
this checkout's source; check out the deploying commit and run again. The
testnet run (`npm run explorer:verify`, `EXPLORER_DRY=1` to send nothing)
is the rehearsal: 2026-09-22, four of the six testnet contracts verifiable
from main, the paymaster and the session factory from their own commits.

## 4. The hosts

Two deploys of one app, one per chain (T080, T081, FR-019). The order below
is not arbitrary: **the playground is created first**. The existing project
holds `chit.tools` and is on 46630 today, so switching it to 4663 before the
playground exists leaves every testnet user pointed at an app that spends
real money. Playground first, then switch.

### 4a. The playground, `testnet.chit.tools` (T080)

A second Vercel project from the same repository, on 46630, with the domain
`testnet.chit.tools`. It exists as of 2026-09-23:

```
project   chit-testnet   prj_IP8f07OAs0aMTMlohsdvHXQ6TL4S
team      dahunsi-ajanakus-projects   team_xX0XGbdZx2CwP1duFPKDGVUe
git       Chit-org/chit-fleet, connected
dns       A  testnet  ->  76.76.21.21   (at the registrar; chit.tools is on
                                         third-party nameservers)
```

Connecting a project in this organisation to git needs the Vercel GitHub app
installed on `Chit-org`, not only on the personal account. Without it
`vercel git connect` refuses with "make sure you have access", which reads
like a typo and is not one.

These are set already, copied from `deployments/fleet-46630.json`:
`FLEET_CHAIN_ID=46630`, `FLEET_RPC_URL`, `FLEET_SESSION_FACTORY`,
`FLEET_POOL_ADDRESS`, `FLEET_POLICY_ADDRESS`, `FLEET_FACTORY_ADDRESS`,
`FLEET_ESCROW_ADDRESS`, `FLEET_ESCROW_BLOCK=120343548`,
`FLEET_ORIGIN=https://testnet.chit.tools`.

What remains is everything that is a secret, which Vercel stores write-only
and no one can read back — from the dashboard, pasted by hand, never through
a shell where it would land in history:

- [x] `DATABASE_URL`: **the existing one**, connected 2026-09-23. A database
      belongs to one chain. The store is not scoped by chain —
      `fleet_owed_spend`, `fleet_sent`, `fleet_idempotency` are charges
      against a pool and nothing in a row says which — so the host that
      serves 46630 needs the rows already written for 46630, and the host
      that serves 4663 needs a database that has never seen them. Today's
      database is full of testnet rows, and the playground is the testnet
      host from now on, so it keeps them and **the beta gets the new one**
      (§ 4c). The other way round is the arrangement that fails quietly:
      mainnet would inherit testnet charges by default, its sweep would
      queue them against the mainnet pool, and only the contract's cap on
      what a deposit backs would keep the loss at zero. Giving the
      playground an empty database fails too, and sooner: a charge already
      queued in the 46630 pool could never be posted, so it would age past
      four hours and pause the testnet pool by itself.
- [x] `CRON_SECRET` and `FLEET_NONCE_SECRET`, fresh values of its own, set
      2026-09-23
- [ ] `DEPLOYER_PRIVATE_KEY`, the same 46630 operator the pool records
- [ ] `FLEET_LEDGER_KEY`, **the same value the current project has**: a
      different key cannot open the charges already sealed in the 46630 pool
- [ ] no `CHIT_FEE_THRESHOLD`: the playground is the free one, so no gate
- [ ] and nothing else. In particular **not** `BUYBACK_KEEPER_KEY` or
      `BUYBACK_ADDRESS`. `vercel.json` is in the repository, so the new
      project inherits all six crons, and `/api/buyback/keeper` is fixed to
      chain 4663 and runs every five minutes: given the key, this host would
      race the beta's on one account, on a path that spends real ETH. The
      same goes for `TELEGRAM_*` and `BOT_*`, whose order and watch crons
      would then run twice. Without the keys those crons fail every five
      minutes, in the logs and nowhere else, which is the correct failure.

Then the A record above at the registrar, and a deployment. `vercel.json`
turns off deployment on a push to `main` for every project built from this
repository, so the playground is deployed by hand too — from the dashboard,
or from a checkout linked to it.

Check: the playground opens, says testnet 46630, and its cards link to
itself. Nothing on it links to the beta.

### 4b. Alerting, before the soak (FR-043, T088)

Alerting is only live from a production deployment, and that deployment is
started by hand. A soak begun before it did not soak with alerting on.

- [ ] `TELEGRAM_BOT_TOKEN` (already set) and `MONITOR_CHAT_ID`, the operator
      chat the alerts go to — not the group. Named before the beta opens, as
      FR-043 asks.
- [ ] `FLEET_TESTNET_URL=https://testnet.chit.tools` on the beta project and
      in the bot's environment, so the holders gate and the bot's playground
      door point at 4a rather than at the beta (T082).
- [ ] `vercel --prod`, by hand. This is also the deployment that publishes
      the corrected promise, which FR-008 requires to land **before** the
      change that opens the beta, never in it.
- [ ] then, and only then, `npm run fleet-soak -- --watch` (§ 2b).

### 4c. The beta, `chit.tools`

The existing project, switched to 4663 once § 3 has deployed the contracts.
It changes chain, so it changes database:

- [ ] **a new, empty `DATABASE_URL`**, and the old one disconnected from
      this project. It is the same rule as § 4a from the other side: the
      rows in it are charges against the 46630 pool, and a mainnet sweep
      reading them would queue them against the mainnet pool. `_post` caps a
      charge at what the depositor's deposit backs, so an unknown depositor
      is charged nothing and no money is lost — but it spends gas and writes
      phantom postings into the ledger the beta is judged on. Create the
      database in the same step as the chain id, never after the first
      deploy.

- [ ] `FLEET_CHAIN_ID=4663`, `FLEET_RPC_URL=https://rpc.mainnet.chain.robinhood.com`
- [ ] `FLEET_POOL_ADDRESS`, `FLEET_POLICY_ADDRESS`, `FLEET_FACTORY_ADDRESS`, `FLEET_ESCROW_ADDRESS`, `FLEET_ESCROW_BLOCK` from the script's output
- [ ] `FLEET_LEDGER_KEY` (32 bytes hex, now, before the first draw), `FLEET_NONCE_SECRET`, `FLEET_TOKEN_ALLOWLIST` (the tokens the beta may buy)
- [ ] holders only: `CHIT_FEE_THRESHOLD=<threshold>`, `CHIT_BASE_FEE=0`, `CHIT_FEE_DISCOUNT=0`, `CHIT_FEE_RECIPIENT=<operator>`, `CHIT_RPC_URL=https://rpc.mainnet.chain.robinhood.com`, `CHIT_TOKEN_ADDRESS=0xd523a627030509021cc39b6d7c8543417d3e50d8`
- [ ] no `FLEET_SESSION_FACTORY`: 4663 has none until one is deployed there,
      and the Sessions page says so rather than offering the testnet's
- [ ] redeploy; the app rebuilds with the beta note on every page and the balance page's caps read from the pool

Check: a wallet under the threshold gets `ineligible` on `quote`; one over it
gets a quote with a zero fee. `verifyDeployedAddresses` refuses the router
if any address holds no code. And T081's own check, which needs both hosts
up: each names its chain, neither offers the other's funds, and the only
link between them is the beta's door to the free playground (FR-004).

## 4d. Changing the threshold later

`CHIT_FEE_THRESHOLD` is what a wallet must hold to be let in, in base units.
It was set to 100,000 CHIT on 2026-09-25 — about $24 at $0.00023630, against a
maximum deposit of 0.1 ETH (about $267). The intent is a holder's marker, not
a paywall: the pool cap already limits the beta to roughly ten depositors, so
the gate is not what creates scarcity.

CHIT's price moves, so the number will want revisiting. It is one variable and
a redeploy, never a code change:

```bash
vercel env rm CHIT_FEE_THRESHOLD production    # on the beta host
vercel env add CHIT_FEE_THRESHOLD production   # the new figure, base units
vercel --prod
```

The service reads it per request, but Vercel freezes an environment into a
deployment, so the redeploy is what makes it take. Check it by quoting from a
wallet under the line: it is told what it holds and what is needed, never an
error (FR-004).

The arithmetic: base units are the figure times 10^18, so 100,000 CHIT is
`100000000000000000000000` — the number, then eighteen zeros. To aim at a
dollar figure, divide it by the price and round to something sayable in an
announcement.

**Not tied to the live price on purpose.** A gate that computes itself from a
feed makes who may deposit depend on that feed: a thin-liquidity tick or an
outage changes who is let in, and nobody notices until someone complains. The
threshold is a number the founder chose and can change in two minutes, which
is the right amount of friction for a decision about who is invited.

Whatever it becomes, it is also in the announcement (`marketing/CHIT-BETA-ANNOUNCEMENT.md`),
and FR-042 wants the two to agree on the day.

## 4e. The guardian, after pulling it

Lucian holds the guardian (FR-009), reachable 10:00–02:00 UTC+3 daily at
`@algo_cats`. What "bad" looks like is the alerting's own page, written by its
author. This is the half that is chain mechanics: how to know the pause landed,
and how to close the loop so nobody is left wondering whether it went through.

**Pausing.** Send `pause()` to the pool from the guardian address. It takes no
arguments and about 0.0000021 ETH of gas. It is refused from any address but
the guardian, the operator and the admin.

**Confirming it landed.** Three things, in order of how quickly they answer:

1. the transaction has a receipt with `status: success`
2. `paused()` on the pool reads `true` — this is the one that matters, because
   it is the state everything else reads
3. the pool emitted `PausedSet(true)` in that transaction

Reading it takes no key and no permission:

```bash
FLEET_CHAIN_ID=4663 npm run fleet-pool:check      # prints paused, caps, counters
```

**Telling the operator.** Post in the monitor chat, not in a direct message, so
the record of who pulled it and when is where everyone already looks:

> paused at `<time UTC>`, tx `<hash>`, `paused()` reads true. what I saw: `<the
> alert or the thing>`.

**What stays working while paused**, so nobody escalates over the wrong thing:
deposits stop, draws and buys stop, and **exits keep working** — a depositor can
still take their money out, which is the whole point of the exit living in the
contract rather than in a promise. The pool is not stuck; it is stopped.

**Unpausing is not the guardian's.** Only the admin's cold key can, and only
after the resume gate passes (`npm run fleet-resume-check`) and an account of
what happened is published (FR-035). A guardian who pauses is never the person
who decides when it ends, and that asymmetry is deliberate: pausing is cheap and
reversible, resuming is not.

## 5. The first loop, by us

Before anyone else: one deposit of 0.01, one fleet, one draw of 0.02, one
buy, pause, close, withdraw. Record the hashes under `firstBuy` in
`deployments/fleet-4663.json`. If any step fails, `pause()` from the
guardian and say so; nobody else has deposited yet.

## 6. Open the beta

Post the announcement (the one drafted on 2026-09-16), with: the pool
address, the caps, the threshold, "beta", "not audited by a firm yet", the
24h self-exit, and the guardian's existence. Pin it.

## What the beta is not

- Not a bigger pool. The cap grows when the firm audit closes, as a new
  pool; the record keeps the beta under `previous[]` then.
- Not a multisig operator. That is the "Then" lane; the guardian is the
  beta's second key.
- Not a fee. The gate holds CHIT; it charges nothing. A fee is a separate
  decision with legal.

## Resuming after a pause

The pool pauses itself on a charge that passed its deadline unrecorded or an
exit that would fail (the scheduled sweep, `src/fleet/pool-buy.ts`), the
guardian pauses it on anything else, and only the admin's cold key can unpause
it. Before that transaction, every time:

1. Write `incidents/<yyyy-mm-dd>-<trigger>.md` (the form is in
   `incidents/README.md`): the trigger, the cause, the commit that fixed it,
   the test that now covers it, where depositors were told, and the `donate()`
   that made the pool whole if it was short.
2. `FLEET_POOL_ADDRESS=0x… FLEET_CHAIN_ID=4663 npm run fleet-resume-check`. It
   reads the record and the pool and refuses, with every reason, until the
   record is complete, the test exists, the identity holds and the pool holds
   what it owes (`src/fleet/pool-solvency.ts` says how that follows from the
   counters).
3. The admin sends `setPaused(false)`.

A pause that fires again after a resume is a trigger the resume did not settle:
an exit that still fails, or a charge that expired after the pool came back.

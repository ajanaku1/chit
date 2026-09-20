# Design: the capped mainnet beta on Robinhood Chain (Stage 2 mainnet)

Status: approved 2026-09-20. Feature `003-mainnet-beta`.
Basis: the mainnet-readiness review of 2026-09-19 (rev2) and its verification
addendum; the runbook on `private/feat/mainnet-beta`; decisions taken by the
founder on 2026-09-19 and 2026-09-20.

This document owns the user-visible experience only. Technical architecture,
contracts, interfaces and test strategy belong to `speckit.plan`.

## Settled before this document

Carried in as constraints, not reopened:

- **M2 is a contract change.** `claimable()` becomes `totalPosted - totalOutflow
  - totalClaimed`, floored at zero; `postQueued` counts only the part of a
  charge still backed by unspent deposit. Ships with the caps change so mainnet
  gets one new bytecode, not two.
- **M6 targets every token on Robinhood Chain.** Day one is CHIT plus at most three
  memes, each hand-checked; the exact list is fixed before launch and recorded
  in the registry. Tokenized stocks sit in the registry disabled until legal
  clears them.
- **Caps, from the runbook:** 1 ETH pool, 0.1 per depositor, 0.05 per draw,
  deposit sizes 0.01 / 0.05 / 0.1, guardian required.
- **Access is holders only,** on a CHIT threshold held in env.
- **Ownership.** Boye owns M3, M5, the CI gate and the outside monitor. The
  founder owns M1, M4, the contract change, M6, the published-promise rewrite,
  the rebase and the redeploy script.
- **Window:** a capped beta targeted for the week of 2026-09-20, announced as a
  target rather than a promise.

## 1. Who this is for, and what they do

One user: a CHIT holder who already trades on Robinhood Chain and wants their
buys not to trace back to their main wallet. They arrive at chit.tools from the
announcement or from the bot.

The journey is the one testnet already proves, on 4663 with smaller numbers:

1. **Arrive.** Every page carries the beta note: capped at 1 ETH, not audited by
   a firm, the operator key can move what is in the pool.
2. **Get past the gate.** Connect a wallet. Holding the CHIT threshold opens the
   app. Below it, one state saying how much CHIT is needed and where to get it.
3. **Deposit.** 0.01, 0.05 or 0.1 ETH against a 0.1 per-depositor cap and a 1 ETH
   pool cap. The form shows headroom before offering a size, and shows the full
   disclosure next to the amount.
4. **Run a campaign.** Draw up to 0.05, fleet accounts seeded after a random
   delay, buys sponsored from the pool. Unchanged from testnet apart from the
   numbers and the token list.
5. **Buy.** Only tokens in the registry, each with a pinned PoolKey and a quote
   that handles its hook.
6. **Leave.** Withdraw through Chit, or exit from the pool directly after the
   24-hour delay without Chit's help. When the operator cannot cover a
   withdrawal, the app says so plainly and points at the exit.

What a depositor can lose is bounded by the pool cap, and that is said in the
same breath as the invitation.

## 2. The four new surfaces

Everything else is testnet's journey with different numbers.

### The holders gate

Checked after wallet connect, before the app opens.

- **Above the threshold:** through, silently. No badge, no celebration.
- **Below it:** "Chit's mainnet beta is open to CHIT holders. You hold
  <their balance>, you need <the threshold>," with a link to buy CHIT and a link to the testnet playground.
- **Unknown:** the RPC failed reading the balance, so retry. A read failure must
  never look like a rejection.

The threshold lives in env so it can move without a deploy. It gates the app
surface, not the contracts: the pool does not know about CHIT, so anyone who
finds the contract can still deposit. The page says so once rather than implying
the gate is stronger than it is.

### The beta note

One line on every page, read from `chain-target.json` so the app never hardcodes
a chain:

> Beta on Robinhood Chain. The pool is capped at 1 ETH. The contracts have not
> been audited by a firm, and Chit's operator key can move what is in the pool,
> up to that cap.

On the deposit form it appears in full next to the amount, not as a footnote. It
is never a dismissible banner.

### The withdrawal-refused state

When the operator float cannot cover the payout:

> We can't pay this right now. Try again in a few minutes, or take it out of the
> pool yourself: that path doesn't need us.

The exit sits beside it. Nothing is recorded, nothing is owed, and no charge
stands against a payout that never happened. The same state covers a paused pool.

### The token picker

Bound to the registry rather than free address entry. Each entry shows the token,
its HEY builder read and Orus safety read where the app carries them, and the
liquidity behind it. A token not in the registry is not an error; it is simply
not offered. Stocks sit in the registry with `enabled: false`, so listing one is
a flag flip once legal clears it.

## 3. Scope

**In:** the four surfaces above; the caps and gate from the runbook; the token
registry with CHIT plus at most three hand-checked memes; the testnet playground moved
to `testnet.chit.tools`; and the published-promise rewrite. FR-016,
`README.md:183`, `ONBOARDING.md:401` and the community brief all say a
professional audit precedes mainnet. That changes in its own commit, before
anything goes live.

**Preconditions, owned by `speckit.plan`, without which the beta does not open:**
the durable write lifecycle (M1, M4); the operator lock around each signed step
(M5); the contract change with the three counters, `postQueuedBatch` and a
paused-safe `donate()` (M2, M3); the sweep's operational fixes (M3); the CI gate;
the outside monitor.

**Out, explicitly:**

- The bot's mainnet session mode and the Chrome extension. Both are real user
  journeys and each gets its own design pass after the beta is live. The beta
  depends on neither.
- Sells through Chit. Sells stay in the app during the beta.
- Any anonymity claim beyond FR-015's existing wording. The pool being small
  makes amounts guessable, and the review's P1 finding shows charges join back to
  buys by amount. The claim does not get stronger because the chain changed.
- A chain switcher in one app. Two hosts, one chain each.
- Automated token listing. Every registry entry is checked by hand for this beta.
- Gas sponsorship on mainnet. It signs with the operator key outside the lock and
  has had no review of its own; it stays off on 4663.

**The rollback.** If something goes wrong after launch, the guardian pauses the
pool, the app says so and keeps the exit visible, and every depositor can leave
without Chit after the 24-hour delay. That path is rehearsed on a mainnet fork
before launch, not discovered during one.

## 4. Acceptance outcomes

### Before any real ETH moves

- All thirteen reproductions flip: the tests stating today's behaviour fail, and
  their replacements state the fixed behaviour and pass.
- The redeploy script passes `(admin, operator)` to both constructors and reads
  `FLEET_ADMIN_ADDRESS`.
- A fork rehearsal on 4663 deploys the set, reads the caps back as 0.1 / 0.05 /
  1, refuses without a guardian, and pauses via the guardian key.
- `feat/mainnet-beta` is rebased onto main, testnet is redeployed from it, T040
  is closed, and it has soaked at least 48 hours with alerting on and no unposted
  charge older than four hours.
- The audit-promise commit is merged, so no published sentence claims a firm
  audit precedes what is about to happen.
- CI blocks a deliberately broken test from reaching main.

### At launch

- A wallet below the CHIT threshold sees the gate, not an error; a wallet above
  it sees no gate; an RPC failure shows retry.
- The beta note is on every page and the deposit form carries the custody
  sentence next to the amount.
- Every registry token quotes and buys against its real pool on a 4663 fork, with
  quote and execution agreeing within the slippage bound.
- A withdrawal against a short float refuses cleanly, records nothing, and leaves
  the exit reachable.
- The monitor asserts the balance identity from public views and alerts on a
  sweep failure, a 503, an ageing unposted charge, and the operator balance.

### In the first week

- No trader is charged for a buy that did not happen, and none is charged twice,
  checked by reconciling each campaign's `spent` against the charges recorded for
  it.
- No charge expires unposted.
- Every withdrawal is either paid or refused, with none left owed.

## 5. Known tension

The 48-hour testnet soak, the fork rehearsal and the contract change together are
a lot to fit beside the announced week. The soak is the item most likely to be
squeezed and the one most likely to catch something. If the week gets tight, the
launch slips rather than the soak. The channel has already been told that is what
happens.

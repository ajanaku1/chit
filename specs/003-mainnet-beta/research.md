# Phase 0 research: the capped mainnet beta

**Date**: 2026-09-20. All chain facts below were read from the live RPCs on that date.

## R1. How a money-moving write survives an ambiguous failure

**Decision.** Every write that moves money gets one lifecycle: allocate a nonce,
sign locally, persist the resulting transaction hash beside the work it belongs
to, broadcast, then resolve by hash. An exception is never read as "it did not
happen". Resolution has exactly three outcomes: mined and successful, mined and
reverted, or never seen once the account's nonce has moved past it. Only the last
two release the work for a retry.

**Rationale.** The signed transaction's hash is computable before broadcast, so
the record exists before the network can lose the answer. That closes the window
the first version of the review left open, where the hash was stored after
`writeContract` returned and a process death in between lost it.

**Alternatives considered.** Storing the hash after the call returns: rejected by
the review's own verification as not crash-safe. Voiding the charge whenever the
send throws: rejected because an RPC can accept a transaction and drop the
answer, which would void a charge for a payout that did land.

**Second mechanism, deliberately kept.** The adapter's lifecycle protects against
a lost answer from a real node. It cannot protect a caller that treats its own
exception as proof of nothing happening. So callers additionally reconcile
against observable chain state before releasing or retrying: the queued entries
carry the exact sealed references we sent, a draw's spend is readable, and a
funded draw's state is readable. The reproductions drive this second path,
because they replace the adapter wholesale.

## R2. Where the nonce comes from

**Decision.** The signed step takes its nonce as an argument. The chain adapter
gains a small `nextNonce(address)` port whose default reads the pending
transaction count. The signing step is one function, so a lock can wrap it
without reaching into the adapter, and a store-allocated nonce can replace the
default later without touching callers.

**Rationale.** Requested by the co-developer who owns the locking work (M5), and
it is the shape that lets a two-instance test drive nonce behaviour directly
instead of inferring it.

**Alternatives considered.** Fetching the nonce inside the signed step: what the
code does today, and the reason the sweep and the buys can collide.

## R3. What changes in the contract

**Decision.** One new bytecode, carrying all of it, deployed once with the caps:

- `totalPosted`, accumulated in `postQueued`, counting only the part of a charge
  still backed by unspent deposit.
- `claimable()` becomes `totalPosted - totalOutflow - totalClaimed`, floored at
  zero.
- `postQueuedBatch`, which skips and reports per entry rather than reverting the
  batch, and takes a size cap.
- `donate()`, payable, crediting no depositor, working while paused.
- Three counters with events: cumulative deposits, exits paid, and donations.

**Rationale.** The first two make the pool reimburse the operator for withdrawals
it fronts, which is the whole of M2. The batch turns a sweep's postings into one
transaction, which is most of M3's write cost. `donate()` is the designed way to
make a short pool whole, and it must work while paused because that is exactly
when someone would be trying. The three counters let an outside monitor assert an
exact identity from public views alone rather than the inequality it can manage
today.

**Consequence, accepted.** With `claimable()` as a surplus, rounding grains and
any expired charge reduce the operator's claim rather than the pool's holdings.
Depositors are safer; the operator carries cents per charge. The comment at
`pool-buy.ts:46` currently says the grain is the pool's and must be corrected
with this change.

**Rationale for batch semantics.** One expired charge must not block the others,
or M3 reappears in a new place.

## R4. Making the read path affordable

**Decision.** Read through Multicall3 and cache entries that can no longer change.

**Verified.** Multicall3 has code at the canonical address `0xcA11…CA11` on both
46630 and 4663 (3,808 bytes on each, read 2026-09-20). No deployment needed.

**Rationale.** `ledgerInputs` costs `2N + M + 3` sequential reads today with one
request in flight, which is what makes a sweep slow enough to let charges expire.
A posted or closed entry never changes again, so it can be cached.

## R5. Quoting a hooked pool with no Quoter on the chain

**Decision.** Reuse what the bot already does. `pool-registry.ts` discovers a
token's deepest ETH pool and returns the real key, price and liquidity;
`market.ts`'s `quoteExactIn` prices a concentrated-liquidity swap locally;
`encodeV4EthBuy` already accepts a pool key. The fleet route gets the same
treatment the bot has, plus an explicit allowlist on top of discovery.

**Verified.** No v4 Quoter is deployed on 4663 at any of the canonical addresses
(zero bytes at each, read 2026-09-20). The PoolManager, the Universal Router and
CHIT's hook are all present and carry code. CHIT's real pool is fee 0, tick
spacing 200, hook `0xE5e7…E044`, which is not the shape the fleet route encodes
today.

**Rationale.** Deploying a Quoter would mean pulling in periphery source the
project does not depend on, which is a dependency decision, and it is unnecessary
because the arithmetic already exists in the repo and is already used against
this exact pool by the buyback keeper.

**Known limit, and why the per-token bound exists.** A hook charges its own fee,
and that fee is not in the local quote. So on a hooked pool the quote is
optimistic by the hook's cut, and a fixed 1% bound would refuse every buy on a
pool whose hook takes more than that. This is why FR-013 allows a per-token bound
recorded in the registry entry: the entry states the bound that accommodates that
pool's hook, measured on a fork before the token is listed.

**Alternatives considered.** Simulating the swap through `eth_call` against the
router for each quote: accurate, and it costs a round trip per keystroke on a
chain whose RPC already drops requests under burst. Kept as the verification step
at listing time rather than the live quote path.

## R6. Alerting without a new dependency

**Decision.** Route operator alerts through the Telegram bot the project already
runs, to an operator-only chat, on the three timescales FR-023 sets.

**Rationale.** The repository's rules forbid adding a dependency without asking
first. The bot already exists, already holds a send path, and is already where
the operator looks. No package, no account, no new secret beyond a chat id.

**Alternatives considered.** A hosted monitoring service: a dependency and an
account. Relying on the scheduler's own failure mail: covers a workflow that
fails outright, and says nothing about a sweep that completes while silently
dropping postings, which is the failure that matters.

## R7. Serving two chains from one repository

**Decision.** Two deployments of the same code, one per chain, each with its own
environment. `chain-target.json` is generated at build time from the chain
variables rather than committed per chain, so the two deployments cannot drift
and a commit cannot silently change which chain production points at.

**Rationale.** The service reads a single chain from its environment by design,
and the app reads a single chain target. Two deployments is the honest shape of
that. Generating the file at build time removes the failure where a deploy record
committed for one chain is served by the other.

**Alternatives considered.** A chain switcher in one app: needs per-chain routing
in the service too, and is not a week's work.

## R8. Bounding failed buys

**Decision.** Count, per campaign, the buys that spent the operator's gas without
completing. Three inside a rolling hour closes that campaign to new buys until
the hour passes. The counter lives in the shared store, so a retry on a second
instance sees the same count. Refusals that spend nothing never count.

**Rationale.** The cost being bounded is the operator's gas, so only gas-spending
failures are the thing to bound. Counting pre-flight refusals would lock a
depositor out for trading something volatile, which is a different and wrong
behaviour.

## R9. What the holders gate can and cannot do

**Decision.** The gate reads the connected wallet's CHIT balance against a
threshold held in the environment, and it gates the interface only.

**Rationale.** The pool contract has no notion of CHIT and is not being given one.
Anyone who finds the contract can deposit into it directly, within its caps. The
page says so once, because a gate described as stronger than it is would be a
false claim, and the project's pitch is that its claims hold.

# Phase 1 data model: the capped mainnet beta

Entities the feature adds or changes. Existing Stage 2 entities are listed only
where this feature changes them.

## On chain (FleetPool, new bytecode)

### Counters

| Field | Meaning | Changed by |
|---|---|---|
| `totalPosted` | Cumulative charge posted against depositors, counting only the part of each charge still backed by unspent deposit | `postQueued`, `postQueuedBatch` |
| `everDeposited` | Cumulative ETH deposited, never decreased | `deposit` |
| `exitsPaid` | Cumulative ETH paid out by exits | `executeExit` |
| `donated` | Cumulative ETH given to the pool crediting no depositor | `donate` |

`claimable()` is redefined as `max(0, totalPosted - totalOutflow - totalClaimed)`.

The monitor's identity, assertable from public views alone:

```
balance == everDeposited + donated - totalOutflow - exitsPaid - totalClaimed
```

Each counter emits an event on change, so a monitor can reconstruct history
without an archive node.

**Invariant change.** `invariant_claimableIsGasOnly` no longer holds by design and
is replaced by an invariant that claimable never exceeds the pool's surplus over
what it owes depositors.

### Queued spend entry

Unchanged in shape. `postQueuedBatch` reports per entry rather than reverting the
batch, with one of three outcomes: posted, expired, already posted.

## In the shared store

### Owed spend row (changed)

| Field | Meaning |
|---|---|
| `id`, `depositor`, `amount`, `incurredAt` | Unchanged |
| `txHash` | The hash of the signed transaction that was to settle this row, written **before** broadcast |
| `nonce` | The nonce that transaction was signed with, so a never-mined transaction can be told from a pending one |
| `state` | `owed`, `leased`, `sent`, `confirmed` — `sent` is the state that did not exist before and is the whole point |

A row in `sent` is never re-queued on the strength of an exception. It is resolved
by its hash, and only a reverted or provably-never-mined transaction returns it to
`owed`.

### Campaign failure counter (new)

| Field | Meaning |
|---|---|
| `campaign` | The campaign the failures belong to |
| `failures` | Timestamps of buys that spent gas without completing |
| `closedUntil` | When the campaign accepts buys again, set on the third failure within an hour |

Held in the shared store so a second instance sees the same count.

## In the repository

### Token registry entry (new)

| Field | Meaning |
|---|---|
| `token` | Address of the token |
| `symbol`, `decimals` | For display; read from chain at listing and pinned |
| `poolKey` | The exact pool: currency0, currency1, fee, tickSpacing, hooks |
| `poolId` | Derived from the key, recorded so a mismatch is caught rather than assumed |
| `slippageBps` | The bound in force for this token; defaults to 100 (1%) |
| `enabled` | False keeps the entry and its evidence without offering the token |
| `checks` | Evidence: transfer behaviour, holder restrictions, liquidity measured, the fork test that passed, and when |

Tokenized equities are present with `enabled: false` until the legal question is
resolved. The registry is a repository file, reviewed like code, not a runtime
list.

### Chain target (changed)

Generated at build time from the chain environment rather than committed.
Carries chain id, chain name, RPC URLs, the beta flag and the beta note.

## State transitions

### An owed row

```
owed --lease--> leased --sign+store hash--> sent
sent --receipt: success--> confirmed
sent --receipt: reverted--> owed
sent --nonce moved past, no receipt--> owed
leased --lease expires--> owed
```

The transition that does not exist, deliberately: `sent --exception--> owed`.

### A campaign's buy acceptance

```
open --3 gas-spending failures within 1h--> closed until +1h --> open
```

A refusal that spends nothing leaves the campaign open.

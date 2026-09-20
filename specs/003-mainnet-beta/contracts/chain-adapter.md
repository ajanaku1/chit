# Contract: the chain adapter's signed step

The interface every money-moving write goes through. Callers never call
`writeContract` directly.

```ts
/** The nonce a signed step will use. Default reads the pending count; a
 *  store-allocated nonce can replace it without touching callers. */
nextNonce(address: Address): Promise<number>;

/** Sign, persist, broadcast, resolve. `nonce` is supplied by the caller so a
 *  lock can wrap this call without reaching inside it. */
signAndBroadcast(call: {
  nonce: number;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  gas?: bigint;
  /** Called with the hash after signing and BEFORE broadcast. Must durably
   *  persist it. If this throws, nothing is broadcast. */
  record: (hash: Hex, nonce: number) => Promise<void>;
}): Promise<WriteOutcome>;

type WriteOutcome =
  | { status: "mined"; hash: Hex }
  | { status: "reverted"; hash: Hex }
  | { status: "unknown"; hash: Hex; nonce: number };

/** Resolve a write whose outcome was never observed. Called on the next sweep
 *  for any row left in `sent`. */
resolve(hash: Hex, nonce: number, from: Address): Promise<WriteOutcome>;
```

## Rules

1. `record` runs before broadcast. A failure to persist means no broadcast.
2. `signAndBroadcast` never throws to mean "nothing happened". A transport
   failure after signing returns `unknown` with the hash and nonce.
3. `unknown` is resolved, never guessed: a receipt for the hash decides mined or
   reverted; absence of a receipt once the account's nonce has moved past this
   one decides never-mined.
4. Only `reverted` and a resolved never-mined release work for retry.
5. The caller holds the operator lock across `nextNonce` and `signAndBroadcast`
   for one step, not across a whole sweep.

## What callers must additionally do

The adapter cannot protect a caller that interprets its own exception. Before
releasing or retrying any work, a caller reconciles against observable chain
state:

| Path | Observable evidence |
|---|---|
| Queue batch | The queued entries carry the exact sealed references that were sent |
| Sponsored buy | The draw's `spent` moved by the principal |
| Fleet funding | The draw is no longer Pending and its accounts hold headroom |
| Withdrawal payout | The recorded hash resolves to mined, reverted or never-mined |

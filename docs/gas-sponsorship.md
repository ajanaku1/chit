# Gas sponsorship for dapps

Your users transact on Robinhood Chain without holding ETH. You prepay a
budget, set the bounds, and Chit sponsors every operation inside them and
settles the cost plus a published fee against your budget, in the same
transaction. Chit never holds your users' money and never learns who they
are beyond a hash. Testnet (46630) only, for now.

This page is the whole integration. Everything is one route:

```
POST https://chit.tools/api/fleet/sponsor
{ "action": "...", "body": { ... }, "auth": { ... } }   // auth only on your own actions
```

## What you need

- A wallet, the one that will fund the budget and get the unspent part back.
- Your users on smart accounts. The canonical ERC-4337 v0.7 `SimpleAccount`
  factory is live on 46630 at `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985`;
  a user's first sponsored operation can carry the account's `initCode`, so
  the account is deployed, used and sponsored in one go and never needs ETH.
- Nothing else. No API key, no account with Chit. Your wallet's signature is
  your identity; your users need no identity at all.

## 1. Read the facts

```json
{ "action": "info" }
```
```json
{
  "chainId": 46630,
  "entryPoint": "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "paymaster": "0x…",
  "escrow": "0x…",
  "feeBps": 2000,
  "validitySeconds": 600,
  "paymasterVerificationGas": "200000",
  "paymasterPostOpGas": "100000"
}
```

`feeBps` is read from the paymaster contract, fixed at its deployment.
Every sponsored operation charges your budget the gas cost the EntryPoint
reports plus this percentage, and nothing else, ever.

## 2. Register, with a signature

Your own actions (`register`, `policy`, `pause`, `resume`, `close`, `status`,
`list`) are signed by your wallet through a challenge:

1. `{ "action": "challenge", "body": { "primaryWallet": "0xyou", "action": "register", "payloadHash": "0x…" } }`
   where `payloadHash` is keccak256 of the canonical JSON of the body you
   are about to send (keys sorted, no whitespace).
2. Sign the challenge bytes with your wallet (`personal_sign`), and send the
   action with `auth: { primaryWallet, nonce, issuedAt, expiresAt, action, payloadHash, signature }`.

The fleet app's `app/src/fleet/signed-request.ts` does exactly this in a
browser; copy it.

```json
{
  "action": "register",
  "body": {
    "policy": {
      "targets": [
        { "address": "0xYourGame", "selectors": ["0x33d425c4"] },
        { "address": "0xYourOtherContract", "selectors": [] }
      ],
      "maxCostPerOp": "1000000000000000",
      "maxPerUserPerDay": "3000000000000000",
      "maxPerSponsorPerDay": "100000000000000000"
    }
  },
  "auth": { ... }
}
```
```json
{ "sponsor": "0x…32 bytes…", "escrow": "0x…", "registerTx": "0x…", "policy": { ... } }
```

The policy, in wei:
- `targets`: the contracts Chit may sponsor calls to, each with the function
  selectors allowed; an empty list means any function of that contract.
  Nothing outside this list is ever sponsored, whatever a request says.
- `maxCostPerOp`: the ceiling on one operation's charge (cost plus fee).
- `maxPerUserPerDay`, `maxPerSponsorPerDay`: ceilings per UTC day, counted at
  each operation's ceiling until it lands and at its real charge after.

`sponsor` is your id. It is a campaign id in the escrow and it never appears
on any user-facing surface; keep it server-side.

## 3. Fund

From your wallet, on chain: `FleetCampaignEscrow.fund(bytes32 sponsor)` with
the ETH attached, on the `escrow` address from step 1. Top up the same way.
The budget is yours: `close(sponsor, openKeys)` on the escrow, from the same
wallet, returns whatever was not spent. `status` tells you the `openKeys`.

## 4. Sponsor an operation, no login

Your frontend builds the user operation as it would anyway, then asks:

```json
{
  "action": "sponsor",
  "body": {
    "sponsor": "0x…your id…",
    "op": {
      "sender": "0xTheUsersSmartAccount",
      "nonce": "0",
      "initCode": "0x…factory + createAccount…, or 0x",
      "callData": "0x…execute(target, 0, data)…",
      "callGasLimit": "150000",
      "verificationGasLimit": "600000",
      "preVerificationGas": "60000",
      "maxFeePerGas": "40000000",
      "maxPriorityFeePerGas": "0"
    }
  }
}
```
```json
{
  "paymasterAndData": "0x…",
  "paymaster": "0x…",
  "entryPoint": "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "key": "0x…",
  "maxCost": "44400000000000",
  "maxCharged": "53280000000000",
  "validUntil": 1789504200,
  "feeBps": 2000
}
```

`callData` must be the account's `execute(address target, uint256 value, bytes data)`
with `value` zero; batches are not sponsored. `maxCost` is the EntryPoint's
prefund for the gas limits you sent; `maxCharged` is that plus the fee, the
most your budget can be charged for this operation. The signature is good
for ten minutes.

A refusal is `422 { "code": "policy_rejected", "reason": "…" }` with one of:
`sponsor_unknown`, `sponsor_paused`, `sponsor_closed`, `call_not_execute`,
`value_not_zero`, `target_not_allowed`, `selector_not_allowed`,
`cost_over_ceiling`, `user_daily_cap`, `sponsor_daily_cap`, `budget_short`.
Nothing is signed and nothing is recorded on a refusal. A malformed request
is `400` with the field named. The same `(sender, nonce)` asked twice is
`409`.

## 5. Sign and submit

Put `paymasterAndData` into the packed operation, have the user sign
`EntryPoint.getUserOpHash(op)` (EIP-191, as SimpleAccount expects), and
send it back:

```json
{
  "action": "submit",
  "body": {
    "op": {
      "sender": "0x…", "nonce": "0", "initCode": "0x…", "callData": "0x…",
      "accountGasLimits": "0x…32 bytes: verificationGasLimit(16) ++ callGasLimit(16)…",
      "preVerificationGas": "60000",
      "gasFees": "0x…32 bytes: maxPriorityFeePerGas(16) ++ maxFeePerGas(16)…",
      "paymasterAndData": "0x…from step 4…",
      "signature": "0x…the user's…"
    }
  }
}
```
```json
{ "txHash": "0x…", "userOpHash": "0x…", "success": true, "charged": "1594297079760", "key": "0x…" }
```

Chit bundles it through the EntryPoint itself; there is no public bundler on
46630 and you do not need one. `charged` is what the escrow committed against
your budget: the cost plus the fee. The same operation submitted twice
answers from the record and is not bundled twice. Anything Chit did not sign
is refused before a wei of gas is spent (`not_our_paymaster`,
`sponsorship_not_ours`, `op_not_sponsored`, `sponsorship_expired`).

If you run your own bundler, the `paymasterAndData` works there too; only
`submit` and the dashboard's `charged` column are Chit's.

## 6. Watch it, stop it, close it

`status` (signed) returns your budget as the escrow holds it, the paymaster's
float, your policy, spend by UTC day, by target and by user hash, every
operation with its transaction hash, and `staleKeys` (signed, never landed,
past their window) for a `close`. It never returns a user's address: the
hash is `keccak256(sender ++ sponsor)`, different per sponsor.

`pause` refuses new sponsorship within one request; operations already
signed and inside their ten minutes still settle. `resume` undoes it.
`policy` replaces the policy. `close` stops sponsorship for good on Chit's
side; the budget comes back through `close` on the escrow, from your wallet.

## What is true about the money

- Chit holds none of your users' funds, ever. Your budget sits in the escrow
  under your id; only `fund` from you puts money in, only `close` from you
  takes it out, and the paymaster can only reserve and commit against it.
- The fee is on the gas cost the EntryPoint reports to the paymaster's
  `postOp`. Measured on 46630 with a 20% fee: the budget covers about 114% of
  the operator's real outlay on an operation that also deploys the account;
  the difference is Chit's, and that is the whole business.
- A sponsor with no cap is a faucet. The three ceilings are yours to set,
  and `status` shows the burn.

## Running it yourself

`npm run sponsor-deploy:live` deploys the escrow and the paymaster (fee from
`FLEET_SPONSOR_FEE_BPS`) and prints the two addresses to set in the host,
with `DATABASE_URL` for the ledger. `test/fork/sponsor-product.test.ts` is
this whole page as a test, on a fork of 46630.

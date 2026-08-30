# Fleet Mission Validation Guide

## Preconditions

1. Start from a clean eligible primary test account with a read-only mainnet CHIT balance meeting the published threshold.
2. Target Robinhood Chain testnet (chain 46630, `https://rpc.testnet.chain.robinhood.com`); fund the primary account from `faucet.testnet.chain.robinhood.com`.
3. Verify the provider, EntryPoint, paymaster, router, and venue by exact chain evidence before using them. The verified addresses are recorded in [research.md](research.md); the Fleet paymaster and the demo venue token stay labelled test-only doubles until they are deployed to 46630.

## Five-account journey

1. Connect the primary wallet and compare the displayed threshold, base fee, configured discount, and net fee.
2. Create a five-account campaign with a finite ETH budget, one approved router/function, trade cap, gas limits, and expiry.
3. Download the encrypted recovery vault; confirm it with a fresh second primary-wallet signature/decrypt round-trip before funding and activation. Only its commitment is sent to the service.
4. Fund and activate; reload during activation once and confirm there are no duplicate accounts, session keys, or budget reservations.
5. Submit one SDK buy for all five accounts; confirm token balances change, account native ETH is not charged, and the campaign budget debit is exact.
6. Inspect public activity for visible accounts, trades, amounts, timing, gas, and shared paymaster with no published primary-to-fleet edge.
7. Pause and resume one campaign. Revoke another, confirm a later request and key rotation reject, then Close and confirm unused ETH returns to the owner.

## Required validation coverage

Run the feature tests for contract policy, Vault v1 round-trip/tamper isolation, API/log redaction, budget arithmetic, idempotency, campaign states, SDK rejection, and the five-wallet end-to-end flow before release review.

## Evidence status — reconciled 2026-08-30

Every step of the five-account journey above is proven by the Fleet test suite
(`./verify.sh` tags `fleet-evidence` through `fleet-acceptance`, all green):
`test/fleet/quickstart.test.ts` walks steps 1–7 in order against the service
logic, `app/test/fleet-acceptance.test.ts` walks the browser journey with the
real Vault v1 cryptography, and `test/fleet/five-wallet-e2e.test.ts` proves
SC-003/SC-004/SC-009 against a public-ledger double.

Still pending on-chain, and therefore not yet claimable:

- Deployment of `contracts/fleet/*.sol` to Robinhood Chain testnet (46630) and a
  recorded deployment file with landed transaction hashes.
- A live sponsored UserOperation through EntryPoint v0.7 on 46630 (self-bundled
  or via a configured bundler), funded from the testnet faucet.
- A verified swap venue: either a seeded Uniswap v4 pool on 46630 or the
  labelled test-only token, recorded in the dependency evidence.
- Service configuration (`CHIT_RPC_URL`, `CHIT_TOKEN_ADDRESS`, fee facts,
  funding verification, operator submitter); until then the hosted routes answer
  503 by design rather than inventing dependencies.

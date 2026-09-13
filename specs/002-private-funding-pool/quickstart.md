# Private Funding Pool Validation Guide

## Preconditions
- Node with Rosetta on this Mac; `npm ci` done at root and in `app/`.
- `.env` with `DEPLOYER_PRIVATE_KEY` (operator) and, for live runs, the pool address in `deployments/fleet-46630.json` under `pool`.
- Robinhood testnet ETH on the operator wallet for gas and withdrawal float.

## Fork validation (no testnet spend)
1. `./verify.sh pool-foundation` — FleetPool fork tests: allowed sizes, caps, pause, exit after delay, draw lifecycle, principal rollback, operator claim bound; ledger math; ciphertext round-trip; ABI scan that no function or event names both a depositor and a campaign.
2. `./verify.sh pool-balance` — API and browser tests for balance, headroom, withdraw, exit status.
3. `./verify.sh pool-fund` — activation opens a Pending draw; a fresh router instance sweeps it after the due time; a just-in-time buy settles principal plus gas; a failing buy rolls principal back.
4. `./verify.sh pool-control` — close credits balance, top-up restores Active, operator pause blocks deposits, draws, and buys.
5. `./verify.sh pool-acceptance` — event-scan unlinkability test, FR-015 copy checks, Stage 1 gates green.

## Live validation (testnet spend)
1. `npm run fleet-pool-deploy:live` — deploys FleetPool, records it.
2. Deposit 0.05 ETH from a trader wallet via the Balance page on chit.tools.
3. Create a five-account fleet, activate with a 0.02 ETH draw, observe "Funding your fleet", then Active.
4. Run one buy; confirm the account holds FLEET, the draw fell by principal plus gas, and the pool posted the same spend.
5. Close; confirm the balance rose by the remainder with no transfer to the trader wallet.
6. Withdraw to a fresh address; confirm payout and posted spend.
7. Record every tx hash under `pooledBuy` in `deployments/fleet-46630.json`.

## Evidence status — 2026-09-13

Fork validation: `pool-foundation`, `pool-balance`, `pool-fund`, and
`pool-control` pass. `pool-acceptance` currently fails — not from a privacy or
code regression, but because the sibling `fleet-venue` gate's Hardhat fork is
pinned to `blockNumber: 113731448` (`hardhat.config.ts:44`), which has aged
roughly five million blocks behind the current testnet tip; the public RPC
returns `-32000: metadata is not found` for state queries at that block. The
privacy-relevant pieces of `pool-acceptance` — `test/fork/fleet-pool-observer.test.ts`
(runs the whole journey on a live EVM fork and reads back every log and
transaction it produced, asserting none joins the depositing wallet to the
fleet or the campaign) and the FR-015 claims checks — pass on their own. That
observer test is what makes SC-002 an assertion rather than a claim. Fixing the
stale fork pin is tracked separately and deliberately deferred for now.

Live validation has run. The pool was deployed 2026-09-08
(`deployments/fleet-46630.json`'s `pool` key, tx `0x9671b80...`). On
2026-09-13, steps 1–7 below ran end to end against live testnet 46630 with the
operator's explicit go-ahead: 0.05 ETH deposit, five-account fleet, 0.02 ETH
draw, one sponsored buy, close-to-balance, withdrawal to a fresh address. Every
tx hash is recorded under the `pooledJourney` key in
`deployments/fleet-46630.json` (the implementation's actual field name; the
task text above says `pooledBuy`).

## Expected outcomes
Match SC-001 to SC-010 in `spec.md`. The observer check reads all pool, factory, and policy events for the run and must fail to join the depositing wallet to the fleet accounts.

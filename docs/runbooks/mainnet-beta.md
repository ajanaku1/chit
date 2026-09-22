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

## 4. The host

Production environment on Vercel:

- [ ] `FLEET_CHAIN_ID=4663`, `FLEET_RPC_URL=https://rpc.mainnet.chain.robinhood.com`
- [ ] `FLEET_POOL_ADDRESS`, `FLEET_POLICY_ADDRESS`, `FLEET_FACTORY_ADDRESS`, `FLEET_ESCROW_ADDRESS`, `FLEET_ESCROW_BLOCK` from the script's output
- [ ] `FLEET_LEDGER_KEY` (32 bytes hex, now, before the first draw), `FLEET_NONCE_SECRET`, `FLEET_TOKEN_ALLOWLIST` (the tokens the beta may buy)
- [ ] holders only: `CHIT_FEE_THRESHOLD=<threshold>`, `CHIT_BASE_FEE=0`, `CHIT_FEE_DISCOUNT=0`, `CHIT_FEE_RECIPIENT=<operator>`, `CHIT_RPC_URL=https://rpc.mainnet.chain.robinhood.com`, `CHIT_TOKEN_ADDRESS=0xd523a627030509021cc39b6d7c8543417d3e50d8`
- [ ] redeploy; the app rebuilds with the beta note on every page and the balance page's caps read from the pool

Check: a wallet under the threshold gets `ineligible` on `quote`; one over it
gets a quote with a zero fee. `verifyDeployedAddresses` refuses the router
if any address holds no code.

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

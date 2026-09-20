# Quickstart: validating the mainnet beta

Every command here runs without real ETH. The last section is the only one that
touches mainnet, and it is a read.

## Prerequisites

- Node 24+, the repository installed (`npm ci && npm --prefix app ci`)
- No mainnet key is needed for anything below
- The reproductions from the readiness review, in `test/fleet/`

## 1. The reproductions must flip

The thirteen tests in `test/fleet/mainnet-blockers*.test.ts` and
`test/fleet/FleetPoolMainnetBlockers.t.sol` state today's broken behaviour and
pass today. After the fixes they must fail, and their replacements must pass.

```bash
npm run build:fleet
node --test --test-reporter spec "dist-fleet/test/fleet/mainnet-blockers*.test.js"
npx hardhat test solidity test/fleet/FleetPoolMainnetBlockers.t.sol
```

Expected before the work: 10 of 10 and 3 of 3 passing.
Expected after: every `finding_*` fails, and each has a sibling stating the fixed
behaviour that passes. A `finding_*` still passing means that fix is not done.

## 2. The contract change

```bash
npx hardhat test solidity test/fleet/FleetPool.t.sol test/fleet/FleetPoolInvariants.t.sol
```

Expected: the surplus invariant holds, `claimable()` covers a fronted withdrawal,
`postQueuedBatch` skips an expired entry without reverting the rest, and
`donate()` succeeds while paused where `deposit()` reverts.

## 3. The fork rehearsal

```bash
BLOCK=$(( $(curl -s https://rpc.mainnet.chain.robinhood.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r .result) - 64 ))
npx hardhat node --chain-id 4663 --chain-type l1 \
  --fork https://rpc.mainnet.chain.robinhood.com --fork-block-number $BLOCK --port 8549 &
```

Then, against that fork:

- Deploy the set with a guardian; expect the caps to read back as 0.1 / 0.05 / 1.
- Deploy without a guardian; expect refusal.
- For each registry token: quote a full-draw buy and execute it; expect them to
  agree within that token's bound.
- Pause with the guardian key; expect the pause to take effect with no operator
  participation, and an exit to remain possible.

## 4. The three pause triggers

Rehearsed on the fork, not discovered in production. Each must end with the pool
paused, the app saying so, and the exit reachable:

- a depositor losing money
- a charge expiring unrecorded
- an exit failing

## 5. The gate and the disclosure

```bash
npm run build && npm run app:shots
```

Expected: the beta note on every page, the custody sentence in full on the
deposit form, the gate showing holdings and threshold below the line, and a retry
rather than a rejection when the balance read fails.

## 6. Reading mainnet, without spending

```bash
curl -s https://rpc.mainnet.chain.robinhood.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xcA11bde05977b3631167028862bE2a173976CA11","latest"]}'
```

Expected: Multicall3 has code (verified 2026-09-20). The same call against a v4
Quoter address returns `0x`, which is why quoting is local arithmetic against the
discovered pool rather than a Quoter call.

## 7. Before opening

- `./verify.sh` green, and running as a required check in CI
- The audit-promise commit merged
- Testnet redeployed from the rebased branch, T040 closed, soaked 48 hours with
  alerting on and no unposted charge older than four hours
- Every registry token's liquidity re-measured the same day

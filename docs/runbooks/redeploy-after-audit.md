# Runbook: redeploy after the September audit

The audit branch changes three contracts (`FleetPool`, `FleetSessionPolicy`,
`FleetAccountFactory`) and they move together: a fleet account admits the pool
through `policy.pool()`, and that check is in the account bytecode the factory
carries. The escrow and the venue do not change and are not touched. This is
the whole sequence, in order, with what each step needs. About an hour, most
of it waiting on Vercel.

Everything below runs with the operator key (`DEPLOYER_PRIVATE_KEY`). The
pool's operator is immutable and the hosted service signs with that same key,
so nobody else can do the chain steps. Fund it with 0.01 ETH of testnet ETH
first; the redeploy costs a fraction of that.

## 0. Merge

- [ ] `audit/contract-fixes` reviewed and merged into `main` (26 Solidity,
      53 fork, 169 unit tests green on the branch; `./verify.sh` from a fresh
      clone is the check that counts).
- [ ] `chore/redeploy-after-audit` (this runbook and the script) merged with it.

## 1. Rehearse on a fork, no ETH spent

A local node forking 46630 carries the live contracts, so the script runs
against the real old pool and a fresh new set. Two quirks: EDR refuses a read
on a fresh fork until one block is mined, and the script refuses a key that is
not the recorded operator, so the rehearsal swaps the record's operator for
the test key and restores it after.

```bash
BLOCK=$(( $(curl -s https://rpc.testnet.chain.robinhood.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r .result) - 64 ))
npx hardhat node --chain-id 46630 --chain-type l1 --fork https://rpc.testnet.chain.robinhood.com --fork-block-number $BLOCK --port 8548 &
sleep 20
curl -s http://127.0.0.1:8548 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}'

cp deployments/fleet-46630.json /tmp/record.bak
# hardhat account 0: a public test key, never a real one
node -e "const f='deployments/fleet-46630.json',r=require('./'+f);r.operator='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';require('fs').writeFileSync(f,JSON.stringify(r,null,2)+'\n')"
ROBINHOOD_TESTNET_RPC_URL=http://127.0.0.1:8548 \
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
FLEET_GUARDIAN_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
npm run fleet-redeploy:live
cp /tmp/record.bak deployments/fleet-46630.json
```

Expected: three deploys, `setPool`, `setGuardian`, "recorded", and the env
block printed. Rehearsed on 2026-09-15 against block 120,02x,xxx: the old pool
held 0.1465 ETH of testers' deposits at the time.

## 2. Tell the testers before, not after

The old pool (`0xce92096098ae1e397b167292edad8f3bdb8200c9`) keeps its ETH; the
app just stops pointing at it. Depositors get it back themselves, on the
contract, through the 24 hour self exit. Post in the group, before step 3:

> the pool is being redeployed with the audit fixes. anything you have in the
> old pool stays yours: call `exit()` on 0xce92…00c9 and `claim()` after 24h,
> or ask here and we walk you through it. the new pool address follows once
> it is live. testnet, test eth.

The operator cannot move anyone's deposit, and the script does not try.

## 3. Deploy, for real

```bash
FLEET_GUARDIAN_ADDRESS=0x…   # a second key, not the operator's; it can only pause
npm run fleet-redeploy:live
```

The script refuses if the key is not the recorded operator, if the operator
holds under 0.01 ETH, if `policy.pool()` does not read back as the new pool,
or if any of the three operators reads back wrong. It writes the new set to
`deployments/fleet-46630.json` and moves the old one under `previous[]`.

- [ ] commit the record: `git commit -am "chore(deploy): pool, policy and factory redeployed after the audit"`

## 4. The host

In Vercel, project settings, environment variables, production:

- [ ] `FLEET_POOL_ADDRESS`, `FLEET_POLICY_ADDRESS`, `FLEET_FACTORY_ADDRESS` from the script's output
- [ ] `FLEET_LEDGER_KEY` (32 bytes hex) **now, before the first draw**; changing it later makes every sealed depositor reference unreadable
- [ ] `FLEET_NONCE_SECRET` (32+ characters)
- [ ] `FLEET_TOKEN_ALLOWLIST` (the venue token, comma separated if more)
- [ ] `FLEET_MAX_SLIPPAGE_BPS` if the default is not wanted
- [ ] update `DEPLOYED_46630` in `src/fleet/service-runtime.ts` to the same three addresses and commit, so a host with no env still points at the live set
- [ ] redeploy the service

Check: `verifyDeployedAddresses` runs once at boot and marks the router
unhealthy if any address holds no code. `POST /api/fleet/campaign` with
`{"action":"status","campaign":"x"}` must answer `campaign_unknown`, not
`misconfigured_address`.

## 5. T040, the last open task

`specs/002-private-funding-pool/tasks.md` has one box left: the live
validation on chit.tools, hashes recorded under `pooledBuy`. Run the quickstart
against the hosted service on the new pool, record the hashes, tick the box.
`progress.json` moves to 81/81 on the next push to `main`, and the landing
says so by itself.

Post the new pool address in the group with the T040 buy hash, the way the
first buy was posted.

## 6. The bots (GitHub, not Vercel)

Repository secrets, if not set yet: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
(`@group`). Then Actions, "Announce push", Run workflow, to see the hello land.
The daily pool and token numbers read the record, so they pick up the new
pool on their next run without a change.

## Still open after this, and not this runbook's

Paid audit by a firm; multisig operator; the legal shape of custody; the
shared nonce store across instances; EIP-712 in the app. All on the roadmap's
"Then" lane, all the founder's calls.

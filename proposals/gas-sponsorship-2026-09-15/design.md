# Gas sponsorship for dapps (proposed design, not approved)

**Status:** proposal, written 2026-09-15 by the advisor. Nothing here is built or
promised. It exists so the founder can accept, cut or reject it on paper before
anyone writes a line, per `plan.md` (new surface stops and asks). The one-day
spike at the end was run the same day on a fork of 46630; its numbers are in
"Spike result" below and nothing else in this document has changed because of
them except where marked *(spike)*.

**One sentence.** A dapp on Robinhood Chain prepays a gas budget with Chit, sets
the bounds, and its users transact without holding ETH; Chit sponsors each
transaction inside those bounds and settles the cost against the budget in the
same operation, using the paymaster and escrow already deployed for fleets.

## Why this, and why now

Robinhood Chain has no gas abstraction. A wallet that has never held ETH cannot
do anything, and every dapp on the chain has the same first step to explain.
Chit already runs the two pieces that solve this: a verifying ERC-4337
paymaster (`FleetPaymaster`) that sponsors an operation only when the operator
has signed it, and an escrow (`FleetCampaignEscrow`) that reserves the maximum
cost before the operation and commits the actual cost after, atomically inside
the EntryPoint's `handleOps`. Today the sponsor is a fleet campaign. It can just
as well be a dapp.

This is the "why not just Jupiter" question from the community, turned into a
product. It is also the first revenue that does not depend on the pool growing,
holds none of a user's money, and gives the token a use with no privacy to
break.

## Who pays, who is protected

| Party | Puts in | Gets | Risk carried |
|---|---|---|---|
| Sponsor (a dapp) | ETH into its own escrow budget; a policy | Its users transact without ETH | Its budget, bounded by its own caps |
| User of the dapp | A signed operation from a smart account | A transaction that costs them nothing | None. Nothing of theirs is held |
| Chit (operator) | Gas fronted per operation, a signature per operation | A fee on top of gas, settled from the budget | Fronted gas until the budget commits, bounded by the reservation |

No user money is ever held. The sponsor's budget is the sponsor's, refundable
minus what was spent, which is the escrow's existing close path. This is not
the pool and does not share its custody question.

## The journey

**Sponsor side, once.**
1. Register: a sponsor id, a payout address for refunds, a contact. Signed by
   the sponsor's wallet with the same challenge flow the fleet app uses.
2. Set the policy: which target contracts and which function selectors Chit
   will sponsor calls to; a maximum cost per operation; a maximum per user
   per day; a maximum for the sponsor per day; optionally a list or an
   attestation the sponsor supplies of users who qualify.
3. Fund: ETH into the sponsor's escrow budget, one transaction from the
   sponsor's wallet. Top up the same way. Close returns the unspent budget to
   the payout address.

**User side, every transaction.**
1. The dapp's frontend builds the user operation as it would anyway, then
   asks Chit for sponsorship: `POST /api/sponsor` with the operation's fixed
   fields and the sponsor id.
2. Chit checks the policy off chain: target and selector allowed, cost under
   the per-operation ceiling, the user under the daily cap, the sponsor under
   its daily cap and its budget, and any sponsor-supplied qualification. If
   all hold, Chit signs the sponsorship (the existing digest: sender, nonce,
   callData, gas, campaign, reservation key, cost bound, validity window) and
   returns `paymasterAndData`.
3. The dapp submits the operation. Chit's paymaster verifies the signature,
   reserves the ceiling in the sponsor's escrow, the operation runs, `postOp`
   commits the actual cost plus Chit's fee. All inside one `handleOps`.
4. The sponsor's dashboard shows spend per day, per target, per user (hashed),
   remaining budget, and every sponsored transaction hash.

## Settled decisions to make (the founder's)

1. **Who can be a sender.** The paymaster sponsors ERC-4337 operations, so the
   user needs a smart account, or an EOA delegated under EIP-7702 if 46630
   supports it. *(spike)* Answered for smart accounts: the canonical
   SimpleAccount factory for EntryPoint v0.7 is live on 46630, and a user's
   first sponsored operation can carry the account's own `initCode`, so the
   account is deployed, used and sponsored in one transaction without ever
   holding ETH. EIP-7702 delegation was not tested; if only smart accounts
   qualify, the first customers are dapps that already deploy one per user
   (games, social, anything with an embedded wallet).
2. **Who bundles.** Chit can submit `handleOps` itself, as the fleet service
   does, so no public bundler is needed on the chain. That makes Chit the
   bundler too, which is fine at this scale and worth saying. *(spike)*
   Measured: with the bundler transaction priced like the operation, the
   EntryPoint's refund to the operator covers the bundling gas; the operator's
   real outlay is the bundler transaction and nothing else.
3. **The fee.** A percentage on top of gas (proposal: 20%), committed with the
   cost in `postOp` so it is never invoiced separately, or a flat monthly
   amount per sponsor. Percentage is simpler and scales with use. *(spike)*
   The budget as committed today covers about 95% of the operator's outlay on
   a first operation and about 98.5% on a later one (the EntryPoint hands
   `postOp` a cost that predates `postOp`'s own gas and its unused-gas
   penalty). A percentage fee on the committed cost has to clear that gap
   before it is revenue; 20% does, with room. The paymaster could also add
   its post-op allowance to the commit, which is a small contract change and
   the founder's call.
4. **The token.** A discount on the fee for sponsors that hold CHIT, paid by
   the sponsor, who is already known to Chit. No user is involved, so nothing
   of the pool's claim is touched. This is the one token utility in the
   product that is safe to state today; it still waits for legal like the rest.
5. **Testnet first.** The venue token and the fleet app are the first sponsor,
   sponsoring its own users' buys through the same path, so the whole loop is
   proven on ourselves before a second dapp is onboarded.

## Scope

In: sponsor registration and policy; a budget per sponsor in the existing
escrow keyed by sponsor id; the `/api/sponsor` signing route with the checks
above; per-user and per-sponsor daily caps enforced off chain and bounded on
chain by the budget; a sponsor dashboard page in the existing app shell; the
fee committed in `postOp`; testnet only.

Out: any change to the pool; user-facing UI beyond what the dapp builds; token
gating of users; mainnet; a public bundler; sponsoring calls to targets the
sponsor did not list.

## What exists and what is new

| Piece | Exists | New |
|---|---|---|
| Paymaster that sponsors on operator signature | `FleetPaymaster`: written, fork-tested, not deployed | one deployment, bound to the sponsor escrow below |
| Budget with atomic reserve and commit | `FleetCampaignEscrow`: the one deployed on 2026-08-31 predates the settler role the paymaster needs (its bytecode has no `setSettler`), so it cannot be the sponsor escrow | one fresh deployment for sponsor budgets, which also keeps them apart from fleet budgets; `registerCampaign` becomes `registerSponsor` in naming only; a fee field in commit |
| Signed request flow, challenge, nonce | `campaign-service.ts` | reused as is |
| Policy checked off chain before signing | `session-policy.ts` (router, selector, caps) | a sponsor policy type: targets, selectors, per-op ceiling, per-user and per-sponsor daily caps |
| Off chain accounting of daily caps | none | a small ledger, per sponsor, per user hash, per day; this needs a store that survives an instance, which the fleet service has avoided so far |
| Sponsor dashboard | app shell, balance and control room patterns | one page |
| The `/api/sponsor` route | `api/fleet/*` shape | one route |

The one architectural cost is the daily-cap ledger: it is the first state the
service must keep between instances. Neon is already a dependency; a table of
(sponsor, userHash, day, spent) is enough. Without it the caps are per instance
and a user can exhaust a sponsor's budget by spreading requests across
instances.

## Risks, said plainly

- **Budget draining by sybil users.** A sponsor with no qualification list is
  a faucet. The per-user daily cap limits each user; the per-sponsor daily cap
  limits the day; the qualification hook lets the sponsor say who counts. All
  three are the sponsor's choice, and the dashboard shows the burn.
- **Gas price spikes.** The reservation is a ceiling; an operation that would
  cost more than the ceiling is not signed. The fee is on actual cost.
- **Chit as the single signer.** If the signing key stops, sponsored dapps
  stop. Same shape as the fleet service; the same outside monitor covers it.
- **Naming.** The escrow and paymaster are called "campaign" throughout. A
  sponsor is a campaign with a different policy. Rename in the service layer,
  not on chain, until a redeploy is due anyway.

## What it would earn

*(spike)* Measured on the fork: a sponsored call costs the operator about
198k gas of bundler transaction when the account exists, and about 402k on
the operation that also deploys it. At the 0.01 gwei base fee 46630 was
showing on 2026-09-15 that is 0.000002 ETH and 0.000004 ETH, fractions of a
cent; at 0.1 gwei, 0.00002 ETH, still under a cent. A 20% fee on that is
nothing per transaction. The money is in volume: a dapp doing 10,000
sponsored transactions a day at 0.1 gwei pays about 0.2 ETH a day in gas and
0.04 ETH in fee, roughly $100 and $20 at a $500 ETH; ten such dapps are about
$6,000 a month in fee with no custody and no privacy claim, and at 46630's
current base fee a tenth of that. Small, real, and recurring; it pays for the
monitoring and the operator float on its own only with volume, and the
numbers above are the ones to plan with, not the earlier estimate.

## First step if accepted

A one-day spike: sponsor the fleet app's own buys through `/api/sponsor` on
46630 with the venue token, from a throwaway smart account, and record the
transaction hashes in `deployments/`. That proves sender type, bundling and
the fee commit before any dashboard exists. Then the spec.

## Spike result (2026-09-15, fork of 46630)

Run the same day, on a fork of Robinhood Chain testnet against the real
EntryPoint v0.7 and the real SimpleAccount factory that are live there, with
nothing deployed to the chain itself. The code is `src/fleet/sponsored-op.ts`
(the builder), `test/fork/sponsor-spike.test.ts` (the proof) and
`scripts/sponsor-spike-live.ts` (the same steps against the live testnet,
which records under `sponsorship` in `deployments/fleet-46630.json`; not run,
it needs the operator key). No route, no page, no change to any deployed
contract or to the pool.

What it did: a throwaway smart account that had never existed and held no ETH
made one call to a sponsor's contract (`FleetSponsorProbe`, a test target that
moves no value). The operator signed the sponsorship with the existing
`paymaster-data.ts` digest; `FleetPaymaster` reserved the EntryPoint's own
prefund in a fresh `FleetCampaignEscrow` budget; the EntryPoint deployed the
account from the operation's `initCode`, ran the call, and `postOp`
committed the cost; the operator submitted `handleOps` itself. Then the same
account made a second call. A third operation, sponsored with a signature
that was not the operator's, was refused by the EntryPoint (AA34) before the
account was deployed or the budget moved.

| Measured | First operation (deploys the account) | Second operation |
|---|---|---|
| Gas by the EntryPoint's count | 449,254 | 248,972 |
| Gas on the bundler's transaction (the operator's real outlay) | 402,341 | 197,749 |
| Committed from the sponsor's budget, as a share of the outlay | 94.8% | 98.5% |
| Reservation ceiling (the EntryPoint prefund, 1.11 million gas at the max fee) | reserved, then released in full | same |
| Account ETH before and after | 0 and 0 | 0 and 0 |

What it settles:
- Sender type on 46630: smart account via the canonical v0.7 factory, deployed
  by its first sponsored operation. EIP-7702 not tested.
- Bundler: the operator, self-submitting; the EntryPoint refund covers the
  bundling gas, so the operator's outlay is the bundler transaction alone.
- The budget pays the operation's cost as the EntryPoint reports it to
  `postOp`, never the ceiling (SC-002). That report leaves out `postOp`'s
  own gas and the unused-gas penalty, which is the 1.5% to 5% gap above; the
  fee has to clear it, or the paymaster adds its post-op allowance to the
  commit.
- The deployed fleet escrow cannot be the sponsor escrow (no settler role in
  its bytecode); sponsorship needs its own escrow and paymaster deployment,
  which the live script does on first run.

What it does not settle: anything off chain. The policy checks, the daily
caps, the shared ledger, the `/api/sponsor` route and the dashboard are the
product and are not started.

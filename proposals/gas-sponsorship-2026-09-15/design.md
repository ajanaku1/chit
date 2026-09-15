# Gas sponsorship for dapps (proposed design, not approved)

**Status:** proposal, written 2026-09-15 by the advisor. Nothing here is built or
promised. It exists so the founder can accept, cut or reject it on paper before
anyone writes a line, per `plan.md` (new surface stops and asks).

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
   supports it. This has to be checked on chain before anything else; if only
   smart accounts qualify, the first customers are dapps that already deploy
   one per user (games, social, anything with an embedded wallet).
2. **Who bundles.** Chit can submit `handleOps` itself, as the fleet service
   does, so no public bundler is needed on the chain. That makes Chit the
   bundler too, which is fine at this scale and worth saying.
3. **The fee.** A percentage on top of gas (proposal: 20%), committed with the
   cost in `postOp` so it is never invoiced separately, or a flat monthly
   amount per sponsor. Percentage is simpler and scales with use.
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
| Paymaster that sponsors on operator signature | `FleetPaymaster` (deployed 46630) | none, or a copy bound to a sponsor escrow if the fleet one must stay separate |
| Budget with atomic reserve and commit | `FleetCampaignEscrow` (deployed) | `registerCampaign` becomes `registerSponsor` in naming only; a fee field in commit |
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

At a gas price of 0.1 gwei and 150k gas per operation, one sponsored
transaction costs about 0.000015 ETH, under five cents. A 20% fee is a cent.
The money is in volume: a dapp doing 10,000 sponsored transactions a day pays
about $100 a day in gas and $20 a day in fee. Ten such dapps are $6,000 a month
in fee with no custody and no privacy claim. Small, real, and recurring; it
pays for the monitoring and the operator float on its own.

## First step if accepted

A one-day spike: sponsor the fleet app's own buys through `/api/sponsor` on
46630 with the venue token, from a throwaway smart account, and record the
transaction hashes in `deployments/`. That proves sender type, bundling and
the fee commit before any dashboard exists. Then the spec.

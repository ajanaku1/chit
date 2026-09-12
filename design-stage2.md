# Chit Fleet Stage 2 — Private Funding Pool (approved design)

Approved in dialogue on 2026-09-06. Product/experience design only; technical
architecture, contracts, data model, and tests belong to `speckit.plan`.
Builds on the live Stage 1 (Robinhood Chain testnet 46630, operator-executes,
FleetAccount/Factory/SessionPolicy, app at chit.tools).

## Why this stage exists

Stage 1's escrow is a per-campaign deposit that names the owner on chain, and
the same campaign key appears on every fleet account it creates, so the
primary-wallet-to-fleet relationship is derivable from 46630 events today.
Stage 2 replaces that with a shared, unkeyed pool that funds both the fleet's
gas and its trade principal, so no transaction joins the trader's wallet to a
fleet. This is where "your main wallet never funds your fleet" becomes true.

## Settled decisions

1. Deposit path: the trader's main wallet deposits directly into the shared
   pool contract; the deposit carries no campaign identifier.
2. Balance model: one trader account per primary wallet in the operator's
   ledger; any number of campaigns draw principal and gas from it; leftovers
   stay in the account; withdrawals go to an address the trader signs for.
3. Withdrawal: prompt payout via Chit after a signed request, plus a
   self-serve contract exit that pays the deposit minus operator-posted spend
   after a fixed delay (24 hours), usable with the service offline.
4. Deposit sizes: fixed denominations only (testnet: 0.01, 0.05, 0.1 ETH), so
   every deposit of a size looks alike.
5. Caps, contract-enforced, refused before any ETH moves: per-trader balance
   0.5 ETH, per-campaign draw 0.2 ETH, whole pool 5 ETH.
6. Timing: deposit and activation are separate acts; at activation the pool
   funds the fleet after a random 1 to 15 minute delay shown honestly in the app.
7. Journey shape: wallet-first. A Balance area you top up; fleets draw from it.

## The journey

Connect the primary wallet as today. Two areas replace the linear wizard's
funding step:

- **Balance.** Held ETH for this wallet with headroom against the caps.
  Deposit: pick a fixed size; one transaction from the main wallet to the pool;
  balance updates on confirmation. Withdraw: amount and destination address,
  signed; Chit pays and shows the tx hash; the form warns that paying to the
  main wallet recreates the link. Exit: the contract path, the delay, any spend
  the operator has posted for this wallet, and the exact call to make.
- **Fleets.** Wizard steps: connect, size, backup, confirm, activate. Activate
  asks for the campaign's draw within the campaign cap and the balance, then
  shows "Funding your fleet" with the delay range and a countdown. When the pool
  has funded the accounts and the session is open, the campaign is Active.
  Buys run as in Stage 1: principal from the fleet account, gas from the
  operator, both settled against the draw. A short balance sends the trader to
  the Balance page instead of failing.
- **Control Room.** Balance strip; per campaign: draw, spent, remaining; pause,
  resume, revoke, close. Close credits the unspent draw back to the balance,
  not to a wallet, so closing publishes nothing. A depleted campaign can top up
  its draw from balance without a new deposit.

## Screens and states

- Balance page: `/app/balance.html`, inside the existing app shell and styling.
  Deposit card (size buttons; disabled with reason when a size breaches a cap;
  pending while confirming; new balance). Withdraw card (amount, destination,
  signed request, paid state with tx hash). Exit card (delay, posted spend,
  exact contract call).
- Wizard: activate step gains draw amount with cap and balance shown, then the
  "Funding your fleet" state.
- Control Room: balance strip and per-campaign draw/spent/remaining.
- Campaign states as the trader sees them: Draft, Awaiting backup
  confirmation, Ready to activate, Funding your fleet, Active, Paused,
  Depleted, Expired, Revoked, Closed.
- Errors, honest and specific: cap reached, balance short, pool paused by
  operator, service unreachable (self-serve exit always visible).

## Scope

In: the pool contract on 46630 (unkeyed fixed-size deposits, three caps,
operator draws to fleet accounts, operator-posted spend per depositor,
operator-paid withdrawals, delayed self-serve exit, operator pause); the
operator ledger mapping deposits to trader accounts and campaign draws; the
Balance page; wizard and Control Room changes; buy settlement of principal
plus gas against the draw. Testnet only, test token only.

Out: mainnet; any CHIT gating; ZK or view keys (Stage 3); batched funding
windows; a mixer-style anonymity set; multi-asset deposits. A professional
audit is a gate before mainnet, not part of this build.

## The claim this stage earns

"Your main wallet never funds your fleet. The chain shows a deposit into Chit
and fleets funded by Chit, and no transaction links the two. Chit's operator can
link them, and with few users, amounts and timing can be guessed at. Private,
not anonymous." Never "untraceable" or "anonymous".

Until Stage 2 ships, the live app's "No trail back to you" and "The chain never
shows it funding the fleet" lines are not true of Stage 1 and should narrow to
"the operator pays your fleet's gas".

## Demo path

One wallet deposits 0.05 ETH. Later it creates a five-account fleet with a
0.02 ETH draw, sees "Funding your fleet", then Active. One sponsored buy lands
FLEET in a fleet account. Close returns the remainder to balance. Withdraw pays
to a fresh address. Evidence shown: the deposit tx, the fleet funding txs, and
the absence of any tx joining them. Everything shown must genuinely run on
46630; nothing is mocked.

## Acceptance outcomes

- A fresh observer reading 46630 events cannot join the depositing wallet to
  any fleet account of its campaign.
- Over-cap deposits and draws are refused on-chain and pre-empted in the app.
- With the service offline, a trader recovers their unspent deposit through
  the contract exit after the delay.
- A sponsored buy settles principal plus gas within the campaign's draw.
- Close credits the unspent draw to balance without a public refund.
- All Stage 1 `verify.sh` gates stay green.

## Engineering concerns for speckit.plan (recorded, not designed here)

- How the pool posts per-depositor spend without naming the fleet.
- Randomised funding delay needs a scheduler that survives serverless
  instances; the service is currently stateless per request.
- The operator ledger is custody accounting and needs durable storage; the
  current service keeps no state across function instances.
- Withdrawal signing reuses the Stage 1 challenge flow.
- Selective disclosure (view keys) stays Stage 3; Stage 2 discloses only that
  the operator holds the mapping.

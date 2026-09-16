# CHIT buyback and burn

Tokenomics only: a slice of what the fleet earns buys CHIT on the pool and
burns it, in a contract nobody can drain and everybody can read. Not a
promise about price, not a product feature; a fact of the token, if the
group wants it. Nothing here is deployed until the GC says so.

**Decided by the GC, 2026-09-16: the default parameters below, as proposed.**
`spendBps` 100 (1% of the balance a call), `minSpend` 0.002 ETH, `maxSpend`
0.1 ETH, `interval` 3600 s, `maxSlipBps` 500 (5% under the pool's quote).
Immutable once deployed; a different number is a new contract.

## The idea, as proposed

1. The team seeds the contract with 1 ETH.
2. Every day the team sends in 10% of the day's fleet fees. The share
   grows by one point for every 100k of market cap (11% at 100k, 12% at
   200k, and so on): the team's rule, posted with the numbers, not the
   contract's (the contract cannot know the market cap in dollars; see
   "the share" below).
3. The contract buys CHIT from the pool and burns it, a bit at a time, so a
   big day is not dumped into the pool in one buy and a quiet week does not
   starve it.
4. Once a day the group gets the numbers: what came in, what was bought and
   burned, the running totals, straight from the chain.

## The contract

`contracts/chit/ChitBuyback.sol`. No owner, no withdraw, no parameter that
can change after deploy; the deployer's key is worth nothing afterwards.
ETH arrives by plain transfer (or `fund()`), and `buyAndBurn()` is public:
anyone can call it, and a keeper makes sure someone does.

Each call:

- waits at least `interval` since the last one (decided: one hour);
- spends `spendBps` of the balance (decided: 1%), never less than
  `minSpend` (0.002 ETH; the whole balance when less is left, so the last
  wei is spent and not left as dust) and never more than `maxSpend`
  (0.1 ETH, so no single buy moves the pool much);
- quotes the buy from the pool's own price and liquidity, on chain, the
  same exact-in math the app uses, and refuses a fill more than
  `maxSlipBps` (5%) under it; the hook on the CHIT pool takes 2% on every
  buy, which sits inside that;
- buys through the Universal Router, receives the CHIT, and calls
  `burn()` on the token, which lowers `totalSupply` (measured: the supply
  fell by exactly the burned amount). Anything sent to the contract in
  CHIT directly is burned with the next buy too;
- emits `BoughtAndBurned(caller, ethIn, bought, burned, totalSpent,
  totalBurned)`, and every deposit emits `Funded(from, amount, balance)`.

Sizing follows the balance, which is what makes it self-regulating: with
1% an hour, a balance loses about 21% a day and 81% a week, so a deposit is
spread over roughly a week; a bigger deposit means bigger buys, and when the
token runs and the same ETH buys fewer tokens, the ETH still gets spent at
the same pace instead of sitting forever. The cap and the floor are the
two ends of that.

### What it is not

- **Not a price oracle.** The guard compares the fill to the pool's state
  at the moment of the call. Someone who moves the price in the block
  before can make the buy more expensive; they cannot make the contract
  accept a worse fill than the pool then offers. On this pool the hook's
  2% on both legs makes a sandwich of a 0.1 ETH buy a losing trade: the
  buy moves the price of a 7 ETH pool by about 3%, and the attacker pays
  4% round trip on their own size to capture a slice of that. The chain has
  a single sequencer and no public mempool besides. That, plus the small
  cap, is the protection.
- **Not upgradeable.** The pool key is immutable. If the CHIT pool ever
  moves (a new hook, a new fee tier), the fee source has to stop sending
  here; what is already inside keeps buying on the old pool while it has
  liquidity, and reverts with `NoPrice` when it has none. Keep the inflow
  daily-sized, so the most that can ever be stranded is a few days of fees.
- **Not a wallet with a bot on it.** There is no key that can move the
  ETH anywhere but into the pool, which is the point.

### Measured on a fork of mainnet (2026-09-16)

`test/fork/chit-buyback.test.ts` on a fork of 4663 against the live pool
(id `0x84a4…9f41`: ETH/CHIT, fee 0, spacing 200, hook `0xE5e7…e044`,
about 7 ETH on the ETH side, 17.65M CHIT per ETH):

- 1 ETH in, first call spends 0.01 ETH, buys 177,001.70 CHIT against a
  zero-fee quote of 180,613.98 (the hook took exactly 2.00%), burns all of
  it, `totalSupply` falls by the same; the contract keeps no token.
- A second call inside the hour reverts `TooSoon`; an hour later it spends
  0.0099 (1% of 0.99).
- A contract holding 0.003 ETH spends the 0.002 floor, then the last
  0.001, then reverts `NothingToSpend`.
- 50 ETH in: 0.1 a call, the cap.
- A contract that accepts only 1% under the quote refuses every fill
  (the hook's 2% is more than that) and keeps its ETH: the guard bites.
- No function moves ETH out; a call with unknown data reverts.

Run it with `npm run test:fork:buyback`.

## The daily loop

- **The keeper** (`.github/workflows/buyback-keeper.yml`, hourly) calls
  `buyAndBurn` when it is due and there is something to spend, from a
  throwaway key with dust ETH (`BUYBACK_KEEPER_KEY`; a call is about 250k
  gas at 0.01 gwei). Anyone else can call it too; the keeper is just the
  guarantee.
- **The post** (`scripts/announce-buyback.mjs`, the third step of the
  daily `announce-pool.yml`, needs the repository variable
  `BUYBACK_ADDRESS`) reads the last 24 hours of `Funded` and
  `BoughtAndBurned` events and the contract's counters and posts:

  ```
  🔥 CHIT buyback and burn, today
  last 24h: 1.0000 ETH in · 1 buy · 0.0100 ETH spent · 177.0k CHIT burned
  all time: 0.0100 ETH spent over 1 buys · 177.0k CHIT burned, 0.017% of the minted billion
  in the contract now: 0.9900 ETH · next buy 0.0099 ETH, due in 60 min
  supply after burns: 986.96M
  how it works: … the team sends in 10% of the fleet fees, plus one point every 100k of mcap.
  the contract · every figure read from the chain just now; the totals are the contract's own counters
  ```

  The totals are the contract's counters, never a sum kept elsewhere, so
  they cannot drift; the "team sends in" line is the variable
  `BUYBACK_SHARE`, posted as the team's promise, not as a reading.

## The share

"10% of fees, plus one point every 100k of mcap" is a rule about what the
team deposits, and the contract cannot check it. Three ways to run it,
cheapest first:

1. **By hand, posted.** The team sends the day's share; the daily post
   shows what came in, and the group can hold the team to the rule. This is
   what is built.
2. **A fee splitter.** A second small contract that receives the fleet's
   fee (`CHIT_FEE_RECIPIENT` points at it) and forwards `shareBps` to the
   buyback and the rest to the treasury, with the share settable by the
   team and every change an event. The deposit becomes automatic; the step
   rule is still the team's to apply. Thirty lines, when the fee is live.
3. **On chain by market cap.** Needs an ETH/USD price on Robinhood Chain
   the contract can trust; no oracle has been verified there yet. Not
   promised.

## Deployed

On 2026-09-16 at `0xe5a7dbd4fd12edfb5b2c1e584b5d1ea9131f8b64` on 4663
(`deployments/buyback-4663.json`), with the parameters above, seeded with
1 ETH. The first `buyAndBurn` spent 0.01 ETH, was quoted 178,865.5 CHIT
and burned 175,288.2: 2.00% under, the hook's fee, a clean fill. The
keeper's call cost 273k gas, 0.0000148 ETH. The explorer is
`robinhoodchain.blockscout.com` (the `explorer.mainnet.chain.robinhood.com`
name only redirects to its root).

## Deploying it

1. `.env`: `BUYBACK_DEPLOYER_KEY` (any key with a little mainnet ETH) and,
   if the GC changed them, the five parameters (`BUYBACK_SPEND_BPS`,
   `BUYBACK_MIN_SPEND_ETH`, `BUYBACK_MAX_SPEND_ETH`,
   `BUYBACK_INTERVAL_SECONDS`, `BUYBACK_MAX_SLIP_BPS`). They are immutable:
   this is the one moment to pick them.
2. `npm run buyback-deploy:live`. It deploys, checks the contract computes
   the live pool id and reads a price, and writes
   `deployments/buyback-4663.json`.
3. Repository variable `BUYBACK_ADDRESS` (and `BUYBACK_SHARE` for the
   post's wording), secret `BUYBACK_KEEPER_KEY`.
4. Verify the source on the explorer from the record's constructor
   arguments, so anyone can read that there is no withdraw.
5. Send the seed by plain transfer. The keeper does the rest, and the next
   morning's post says so.

## Ideas the group can take or leave

- A small tip to whoever calls `buyAndBurn` (say 0.5% of the amount) so
  the keeper is not needed at all; left out because it is ETH leaving the
  burn.
- ~~A burn page on chit.tools reading the same events, with the totals and
  every transaction.~~ Built: see below.
- Milestone posts when `totalBurned` crosses round numbers, from the same
  script.

## The burn page (chit.tools/burn)

`landing/public/burn/index.html` is the public face of the contract: CHIT
burned so far as one number, the share of the minted billion, the balance
waiting, the next buy as a countdown, the last buy, today's share of the
fees by the team's rule, the log of every funding and every buy with its
explorer link, the mechanism in four lines, and the immutable parameters.
Lowercase, in Outfit, on the brand's ink and coral; the hero is the mark
from the Higgsfield banner cut free of its words (`landing/public/bot/burn-mark.png`)
with embers drawn over it. Nothing on it is typed in.

The numbers come from `api/burn.js`, one JSON read server-side from the
contract and its events (the chain's public RPC rate-limits bursts and has
no CORS, so a visitor's browser never talks to it), cached at the edge for
two minutes; the instance keeps its last good reading and serves it marked
stale when the RPC does not answer. The market cap for the share is
DexScreener's and is named as such; the share itself is the team's rule
(`SHARE_BASE` 10, `SHARE_STEP_USD` 100000), never a contract reading.
Event times: the latest eight carry the block's own timestamp, older ones
are placed by the chain's cadence since the deploy and wear a ≈.

Before the host: `node scripts/site-preview.mjs` serves the landing and
mounts `/api/burn` at http://localhost:4173/burn/ with the live numbers.

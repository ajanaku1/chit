# Chit Bot on mainnet: the same buttons, no key held

A design for the bot's second mode, written 2026-09-19 so the build starts
from decisions, not from a blank page. Everything here builds on what exists:
the playground (`docs/chit-bot.md`), the session account
(`docs/session-keys.md`, branch `feat/session-keys`), the capped beta
(`docs/runbooks/mainnet-beta.md`). Where a choice is open it is named as
open, with a recommendation and the reason.

## The one sentence

On testnet the bot holds a throwaway key, and says so, because the ETH is
test ETH. On mainnet the bot holds nothing of yours: you keep your wallet,
you create a session account of your own, you grant the bot's key a bounded
session (which router, how much a trade, how much in all, until when), and
the bot's Buy is one `execute` on your account, signed by the bot's own key.
Pause or revoke from your wallet in one transaction. Trojan gives speed by
taking your key; Chit gives speed without it. That sentence is the product,
and every choice below serves it.

## What already exists

- `SessionAccount.sol` + `SessionAccountFactory.sol` (feat/session-keys, not
  merged): one account per owner, address known before it exists; sessions
  granted to a key with up to eight `(target, selector)` rules, a per-call
  value cap, a total cap, an expiry; pause, resume, revoke; the owner's own
  withdraw path for ETH and tokens; `canExecute` so a bot never spends gas on
  a refusal. Proven on a fork against the live Uniswap v4 router; thirteen
  contract tests including a fuzz that spend never passes a cap.
- `src/fleet/session-keys.ts`: the ABI, `encodeSessionExecute`, `canExecute`.
- `app/sessions.html`: create, fund, grant, watch, pause, resume, revoke.
- The bot: handlers over ports (store, chain, telegram), the v4 swap encoder
  (`v4-swap.ts`), exact-in quotes (`market.ts`), the token card with the
  Orus and HEY lines (mainnet only, so they light up the day this ships).
- The runtime's refusal to start on any chain but 46630, because the
  playground holds keys. That refusal is the seam this design opens.

## The mode

`BOT_MODE=session` on chain 4663 (env `FLEET_CHAIN_ID=4663`). The playground
stays as it is on 46630; this is a second runtime configuration of the same
handlers with a different chain port and a different wallet store, chosen at
boot and named on every card ("Robinhood Chain · 4663 · your keys stay with
you"). One codebase, two deployments (two Vercel projects or one project with
two bots; recommendation: **one project, two bots**, `@usechit_bot` for
mainnet and `@usechit_test_bot` for the playground, so the group's buttons
all point at the real one and the playground is where the docs send people
to try things).

## Linking a Telegram user to their account

The hard part is not the trade, it is knowing whose account to trade from.
A session is granted to the bot's key on chain, and the contract does not
know Telegram ids. If the bot simply believed "my account is 0x…", anyone
could name someone else's account and make the bot spend that owner's ETH
within its caps on tokens the owner did not choose. Nothing could be stolen
(tokens land in the account, only the owner can move them out), but it is a
griefing hole and it goes in the audit scope either way. So the link is
signed.

1. `/start` on mainnet shows the card with one button, **Connect your
   wallet**, and a line: "the bot never holds your key; you grant it a
   session from your own wallet." The button opens
   `chit.tools/app/sessions.html?link=<nonce>`; the nonce is random, stored
   against the Telegram id with a 15-minute expiry.
2. The Sessions page does its three steps as today (create, fund, grant), with
   the bot's signer address filled in and the defaults below. The grant is
   the bot's permission; the link is separate.
3. **Link to the bot**: the page asks the wallet to `personal_sign`
   `chit-bot-link|4663|<account>|<nonce>` and POSTs `{nonce, account,
   signature}` to `/api/bot/link`. The route recovers the signer, checks it is
   the account's owner (`owner()` on the account), checks the nonce is fresh
   and unused, and stores `tgId → account`. The bot then edits its card:
   "linked to 0x…, session active, 0.05 ETH a trade, 0.5 ETH in all, 7 days".
4. Re-linking (a new account, or a second Telegram) is the same flow; the
   last valid link wins and the card says which account it is on.

Why not the Telegram deep link for step 3: a signature is 130 hex characters
and `start=` carries 64. Why not skip the signature: see the paragraph above.

## Defaults the page suggests

The grant is the owner's; the page only fills the form. Recommended defaults
for the beta, matched to the pool's own caps so one number in the
announcement covers both: **0.05 ETH per trade, 0.5 ETH in all, 7 days**,
rules = Universal Router `execute(bytes,bytes[],uint256)` only. The page
says what each field bounds in one line each, the way the pool page does.

## Buy

Card → Buy → the bot quotes from the pool as today (`market.ts`), builds the
swap calldata (`v4-swap.ts`, the same exact-in ETH → token path), and:

1. `canExecute(botKey, router, 0x3593564c, amountWei)` on the account. A
   refusal is shown in the contract's own words: "over your per-trade cap",
   "session paused", "expired", "spent". No gas is burned on a refusal.
2. `execute(router, amountWei, calldata)` sent **from the bot's signer key**,
   which pays the gas. The account pays the trade with its own ETH. The
   reply carries the hash, as today.
3. The bought tokens sit in the account. Positions reads the account's
   balances; the share card draws them the same way.

Confirm-trades and slippage settings stay per user in the store; sell
protection is moot (see Sell).

## Sell: decided, B, built

A sell through the router needs the account to approve Permit2 for that
token first. A session rule is `(target, selector)` and the token is the
target, so selling any token the user might hold would need a rule per
token, which the owner cannot grant in advance for tokens that do not exist
yet. Three ways were on the table: A, sells stay with the owner for the beta
(the Sell button opens the Sessions page); B, one contract change, a sell
flag per key, read by the firm with the rest; C, the owner grants a rule per token
from the card, a tap too many. B is the one built, and in a stricter shape
than first sketched: a standing approval plus an open `execute` on the
router was no sale, since the router's calldata names who receives and a key
could have moved the position to itself.

The contract: `setSellAllowed(key, bool)` by the owner, and
`sell(router, poolKey, amountIn, minOut, deadline)` by a live key with the
flag. The account writes the router calldata itself (the same bytes as
`encodeV4TokenSell`, so the router pays the account), makes the two Permit2
approvals for `amountIn` and that block only, calls the router, clears the
approvals, and reverts unless at most `amountIn` of the token left and at
least `minOut` of ETH arrived. The router has to be a rule target for
`execute`; a sale counts as a call and spends none of the caps; `canSell(key,
router)` says why not before any gas. Nothing of a sale outlives it, so
"stop selling" is complete and no other key inherits an allowance. What the
flag does not bound is the price: the pool and the floor are the key's, so a
hostile key can sell into a thin pool of its own; the owner is told this on
the page where the flag is set. The Sessions page has the toggle per key,
and the flag is an item in `docs/audit/2026-09-scope.md`.

The bot, in three lines:

1. Sell 25/50/100% or Sell custom on the token card, over a position. The
   bot reads `sellAllowed`; without the flag it says where to turn it on and
   what the flag trusts the key with, and sends nothing.
2. The share in the token's units, the pool's quote, the floor at 3%, the
   pool key (the token's hooked pool or the venue's), then `canSell` first:
   a refusal is quoted in the contract's words and burns no gas.
3. One `sell(...)` from the bot's signer, which pays the gas; the account
   gives up only the tokens and the ETH lands in it; the reply carries the
   hash. It counts against the user's daily trades and fronted gas like a
   buy.

## Gas, and who pays it

The bot's signer pays gas for every `execute`: about 250k gas at Robinhood
Chain's prices is dust, but it is the operator's dust, and a hostile user can
tap Buy in a loop. Two limits in the handler, both env: a per-user daily
count of executes (default 200) and a per-user daily gas spend (default
0.002 ETH), refused with a plain line when reached. The signer's own float
is watched the way the buyback keeper's is (a warning in the log under a
threshold, and the daily post says the float). A per-trade fee from the
account to the operator is possible later; it is the founder's and legal's
call and it is not in this design.

## Fleet, Withdraw, Faucet, Bridge

- **Fleet** from the bot on mainnet: unchanged in shape (signed requests
  relayed to the hosted service), but the signature is the owner's wallet's,
  so the bot deep-links into the app's fleet pages rather than signing
  anything. Out of scope for the first mainnet release; the card explains and
  links.
- **Withdraw**: never through the bot on mainnet. The owner's path on the
  Sessions page is the only way out, by design of the account.
- **Faucet**: none on mainnet; the card's "Fund" opens the Sessions page.
- **Bridge**: as today (Relay links, the user's own wallet).

## The store

On mainnet the wallet table holds no key: `tgId`, `account`, the link
signature and its nonce, settings. The sealing machinery stays for the
playground and is simply unused here; the runtime refuses to start in session
mode if a key column is populated for the chain, the same way it refuses a
half-configured playground today.

## What the card says

Every card on mainnet carries "your keys stay with you · session 0x…" and,
when the session is paused, expired or spent, says so instead of offering
Buy. The Orus and HEY lines appear as built. The chain and the mode are
named in words on every card, never inferred from a colour.

## Risks, named

- **Bot signer compromise.** An attacker holds a key with a session on every
  linked account. What the caps bound is ETH: at most the per-trade cap per
  call and the total cap in all, sent only to the router. What they do not
  bound is where the router's output goes, since the key writes the calldata
  and a v4 `TAKE` names its recipient: the attacker can spend each account's
  remaining cap on tokens paid to itself. So the loss is up to the unspent
  cap of every linked account, not "unwanted positions". With the sell flag
  on, the attacker can also sell what an account holds, into the account
  only, but at the price of a pool it names, so the position is exposed
  too; the flag is off by default for that reason. Response: revoke is the
  owner's, in one transaction; the bot's key rotates (new address announced,
  every user grants a new session; the card walks them through it). The key
  lives in Vercel like the bot token; no human copies it.
- **Link phishing.** The only URL the bot ever sends is `chit.tools/…`; the
  Sessions page shows the bot's signer address in full and names it; the
  daily post names it too, so a wrong address is noticed.
- **Griefing gas.** The two daily limits above.
- **Wrong chain.** The runtime reads the chain from the environment and
  refuses a mismatch between `BOT_MODE`, `FLEET_CHAIN_ID` and the deployment
  file, with the reason in the log.
- **A flooded feed.** The watcher's alerts (`bot-watch.ts`, `bot-alerts.ts`)
  post what the chain wrote, and anyone with ETH can write a big buy. Only
  the pools of $CHIT and the allowlist are watched, so a pool a stranger
  opens on the pool manager and washes is not a door into the feed; a
  buy the bot's own signer sent is not posted again or as the signer's.
  The group gets at most twenty posts a pass, a user one message per token
  an hour, each claimed in the store in one statement so two overlapping
  passes announce nothing twice, a first pass starts at the head and
  replays nothing, and the words never go past the orus line: a buy is a
  fact, not a recommendation, and a missing read is "unknown", never a
  clean line. `BOT_WATCH_OFF=1` is the switch.

## Rollout

1. Session mode on **testnet** first, with test ETH, next to the playground:
   the same flow end to end, the harness that ran T040 runs it (link, grant,
   buy, positions, revoke, refused buy).
2. Mainnet, **holders only**, the same CHIT threshold as the app's beta, the
   caps above, labelled beta and "not audited by a firm yet" on every card.
3. The firm audit reads SessionAccount with the sell flag and `sell` in it
   (`docs/audit/2026-09-scope.md`); sells are in the bot behind the flag,
   which is off by default until an owner turns it on.

## Work, roughly

Contract: the sell flag and `sell` were a day plus the Solidity and fork
tests. SDK: exists, with `encodeSetSellAllowed` and `encodeSell`. App: the
`?link=` deep link and the Link button on the Sessions page, one day, and the
"let it sell" toggle per key. Bot: the link route and store (one day), Buy
through `execute` with `canExecute` first (one day), Sell through `sell` with
`canSell` first (half a day), Positions from the account, the card copy and
the refusals (half a day), runtime mode, env and tests (one day), the harness
run on testnet (half a day). Done, less the audit's calendar.

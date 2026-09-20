# Chit Bot

The Telegram trading bot on Robinhood Chain. The card every degen knows: a
wallet, a balance, and buttons. Two modes, both labelled on the card.

## Playground (testnet, now)

Press Start in private. The bot makes you a wallet on Robinhood Chain
testnet (46630), funds it with test ETH from a faucet, and shows the card.
Everything after that is a button; when a number or an address is needed,
the reply field opens with a hint, the way Trojan does it.

```
Robinhood Chain testnet · 46630
0x…your wallet…  (tap to copy)
balance: 0.02 ETH
4.95 FLEET · 1980 PEPE

[ 💰 Buy ]      [ 💸 Sell ]
[ 📊 Positions ] [ 🆕 New ]
[ 🚀 Fleet ]     [ 🔑 Sessions ]
[ 🤝 Refer ]     [ 🌉 Bridge ]
[ ⚙️ Settings ]  [ 🏦 Withdraw ]
[ 🚰 Faucet ] [ ❓ Help ] [ ↻ Refresh ]
```

- **Paste any token's contract address** and its card appears: price per
  ETH, the pool's ETH, what you hold, and your buy and sell buttons. Any
  token with an ETH pool on uniswap v4 on the chain, a launchpad's hooked
  pool included: the pool's key is found from the chain (`pool-registry.ts`:
  the common keys read from storage first, then the Initialize events, the
  deepest pool wins). A hooked pool says so on the card, since the hook's
  own fee is not in the quote and the slippage guard is the limit. A token
  with no pool says so.
- **Checked by Orus**: with `ORUS_PARTNER_API_KEY` set, the card carries one
  more line under the price, from Orus's scan of the token (`bot-orus.ts`):
  honeypot, taxes, bundlers, top-10 share, holders, liquidity and whether the
  LP is burned, the deployer's launches, then "checked by orus" linking to
  them. Orus is asked alongside the chain reads with the same patience (1.5 s)
  and a card never waits on it alone; an answer or a miss is kept a minute
  per token, so refresh spam stays inside their quota (30 a minute). A null
  from Orus reads as "unknown", never as "safe". Orus scans Robinhood Chain
  mainnet only, so on testnet the line is never asked for and never shown.
- **Hey Research Lab**: under the Orus line, the builder line from Hey Research Lab
  (`bot-hey.ts`): the project's status ("shipping", "still building"), commits
  and releases in 30 days, "verified builder", then "see on HEY" linking to the
  project's page there. Their rules kept: `found:false` prints nothing, a missing
  field is skipped (unknown, never zero). Asked alongside the chain reads, same
  patience and cache as Orus; anonymous (120 a minute) unless `HEY_API_KEY`
  is set, `BOT_HEY_OFF=1` hides it. HEY indexes 4663 only, so testnet shows
  nothing.
- **Buy**: your three presets, or a custom amount through the reply field.
  Quoted from the pool with fee and price impact (the exact-in math, matched
  to the wei on a fork), a slippage guard from your settings, then the real
  Uniswap v4 router. The reply carries the hash and the tokens received.
- **Sell**: your three shares, or a custom one. The first sale of a token
  approves Permit2 and the router once. Sell protection asks before more
  than 75% of a position.
- **Positions**: every token you hold, and what each would fetch if sold now,
  with sell buttons on the row.
- **Fleet**: Chit's own product, step by step, from the chat: deposit a
  published size into the pool from your wallet, then one tap creates a
  fleet of five (fresh keys, sealed; the service sees addresses and salts)
  and activates it with a draw the pool balance covers, then buy from every
  wallet through the router, pause, resume, close, and your pool balance.
  Create and activate are one tap on purpose: the service keeps an
  un-activated fleet only in the instance that created it, so the two steps
  never straddle a redeploy. Every signed action goes through the hosted
  service's challenge flow, signed by the playground key the way the wallet
  signs in the browser, with an idempotency key derived from the tap. The
  card's claim about privacy is FR-015's and no more. Until the service is
  wired to the pool it answers with its reason, and the card says so.
- **Settings**: buy amounts, sell shares, buy and sell slippage, confirm
  trades (every trade asks first), sell protection. No priority fees, no MEV
  toggles, no turbo: the chain has a sequencer and none of that exists here.
- **New**: the venue's newest ETH pools, read from the pool manager's own
  events over about a day, with a buy button where this bot can trade the
  pool and a plain "cannot trade yet" where the pool has a hook or another
  fee tier.
- **Bridge**: the way in from another chain through Relay, and the way to
  CHIT from anywhere: ethereum, base, arbitrum, optimism, bnb, polygon,
  solana, arc. The card asks Relay which routes quote at that moment and
  shows only those, each a link into Relay's app with the fields filled
  in; the transaction is the user's, from their own wallet. Mainnet, and
  the card says so on the testnet playground. `BOT_BRIDGE_OFF=1` hides it.
- **Deep links**: `t.me/<bot>?start=t-<contract>` opens that token's card,
  for a partner's "trade in chit bot" button or a group's pinned message.
- **Share** (📸 on Positions): the position as a picture, the kind people
  post when a trade went their way: the symbol, the change as one big
  number, what was paid and what the pool would fill right now, and the
  poster's referral link. The cost is the bot's own record of its buys in
  that token, less what its sales returned (a sale is recorded as what it
  left in the wallet after gas, so a card never flatters); the value is
  the fill for the whole position, fee and impact included. Tokens that
  arrived any other way have no cost the bot knows, so there is no card
  for them, only an offer to buy. The card says which chain and says
  testnet on the playground. Drawn on the spot from
  `landing/public/bot/share-bg.png` (the chit mark blown into shards) in
  IBM Plex from `landing/public/bot/fonts`; `BOT_SHARE_OFF=1` hides the
  button, `BOT_ASSET_DIR` moves the assets.
- **Refer**: your link, `t.me/<bot>?start=r-<code>`, and how many came
  through it. Rewards: none yet, said plainly; the roadmap's referral pays
  from the fee when the fee goes live.
- **Withdraw**: paste the address, pick half or all-but-gas, or type an
  amount. **Faucet** tops you up once a day from the card. **/pool** answers
  in the group with the pool's numbers; every other command there is sent
  to private.

Every figure is read from the chain when the card is drawn. Every trade is a
real transaction and the reply says its hash; one that has no receipt
within forty seconds is reported as still landing, with the hash, and the
bot refuses to send it again. Money moves under a lock the store holds per
wallet, across every function instance, so two taps (or one tap answered
twice) cannot race on a nonce or spend twice; every Telegram update is
claimed by its id before it is acted on, so a redelivery does nothing.
Every button carries what it needs in Telegram's 64 bytes, amounts as wei;
every reply prompt names the token or the address it is about in its own
text, so the answer can land on any instance. A chain failure is a message
in the chain's words; an internal one is a plain line, with the detail in
the log.

**The bot holds this key.** It says so on the card. It can, because the key
holds test ETH and test tokens and nothing else; the playground exists so
anyone can try Chit in one tap with nothing to lose. Keys are sealed at rest
with AES-256-GCM under a key derived from the host's secret with scrypt,
each blob bound to its Telegram id and purpose (a row moved under another
id does not open), and the fleet record is sealed the same way, so a copy
of the table shows nothing but addresses. The blob names the key that
sealed it, and a canary row lets the runtime check the secret before it
serves anyone: a rotated `BOT_KEY_SECRET` stops the bot with a clear line
instead of making wallets nobody can open. The faucet pays once a day per
wallet, within a daily budget across everyone, from one send at a time.
The runtime refuses to start on any chain but testnet.

## Your wallet (testnet, then mainnet)

The bot holds nothing of yours. Two paths, both of which already exist in
pieces:

- **Fleet and control room from the chat**: create, fund, draw, pause,
  resume, close, with your signature on each action, the way the app does
  it now. The bot relays; your wallet approves.
- **Fast trades through session keys**: you grant the bot's key a session
  once, from the Sessions page in your wallet: which router, how much per
  trade, how much in all, until when. The bot signs only inside that, from
  its own key, and you pull the key from your wallet in one transaction.
  `docs/session-keys.md` is the contract; the bot's Buy becomes an
  `execute` on your session account, and Sell one `sell` on it, behind a
  "let it sell" flag you set per key: the account writes the router
  calldata itself, the ETH lands in the account, nothing stays approved.

Trojan gives speed by taking your key. Chit gives speed without it.

Standing orders ride on the same session. From a token's card, **Limit buy**
takes an amount and a price as tokens per ETH (`0.02 at 1200000`: buy when
one ETH gets at least that many, the price per token at or below the level)
and **DCA** takes an amount, an interval and a count (`0.01 every 4 hours 6
times`, the first buy at the next check). A cron (`api/bot/orders.js`, every
five minutes, the `CRON_SECRET` bearer) fires what is due as the same one
`execute` a tapped Buy is: the account is asked `canExecute` first, the
quote sets the floor (for a limit, the level itself when that is higher, so
a fill never lands under the price you named; a pool too thin to give it
waits), the bot's key signs, the account pays. A refusal (a paused session,
over a cap) leaves the order open with the reason on it and tells you;
three in a row switch it off. **Orders** on the home card lists what is
open, a cancel under each; a cancel is one statement in the store and a run
mid-send cannot write over it. Money moves at most once per slot: the run
claims an order before the send, the claim names the DCA slot it is for (so
two runs overlapping cannot buy one slot twice from an older read), and a
run cut off in between is settled by the next as sent, never sent again.
Orders are the owner's alone: a limit buy or a DCA that fires is neither
posted to the leaders' feed nor mirrored into followers' accounts, and the
cards say so. One pass sends at most twenty executes,
one per owner in turn, each owner has the same daily budget a tapped Buy
has, and an account keeps at most ten orders open, so a cron gone wrong or
one owner cannot drain the signer's gas. Orders carry the chain they were
placed on; `BOT_ORDERS_OFF=1` stops the cron with the buttons.
`src/fleet/bot-orders.ts`.

Leaders ride on the same session too, two ways. **⭐ Become a leader → from
my session account** opens your tapped buys to followers: when one lands,
the same token is bought on each follower's own session account, sized to
the smaller of your amount and their cap, behind orus's read, inside their
session's caps and their daily allowance, in the order they followed, then
posted once to the group (`BOT_GROUP_CHAT_ID`) with the hash and two doors
(buy this, follow them, by your account and never your Telegram id). **From
my own wallet** is for someone who trades outside the bot and will not move
into it: the bot mints a one-time code and opens the Sessions page with
`?lead=`, the wallet you trade from signs one message (no account, no
session, nothing moves), and the watcher reads that wallet's ETH buys from
the venue's swap logs and mirrors and posts them the same way, telling you
in private how many followed; the list marks you "trades from their own
wallet". A wallet is one signature, so the venue path keeps its own bounds:
a buy is read from 0.01 ETH, through the token's own pool on the venue (the
one the bot quotes; a pool you opened for yourself is yours alone), up to
twenty a day, and a token orus will not clear is neither posted nor
mirrored, the followers hear nothing for it and you are told why in
private. The transaction is claimed in the store before the first mirror,
so two overlapping runs of the watcher cannot mirror it twice. A follower's
daily allowance is one ledger for the taps they make here and the mirrors
of both paths. Either way your sells, your standing orders and, for a
wallet leader, your taps in the bot are never mirrored, so a follower's
exit is their own, and close leader stops it any time.
`src/fleet/bot-copy.ts`, `bot-copy-cards.ts`, `bot-lead-runtime.ts`.

## What is built, what is next

Built (branch `feat/chit-bot`): the playground, end to end, buttons and
reply prompts. Handlers over ports (store, chain, Telegram, the fleet
service) with seventeen conversation tests against fakes, one of which
drives the whole fleet journey against a fake service that recovers every
signature and recomputes every payload hash; the store's contract run over
the memory store, over the Neon store on PGlite (a real Postgres in-process)
and, given `BOT_TEST_DATABASE_URL`, over Neon itself; the webhook's door
(secret required, half-configured deployments refused with a reason); the
chain adapter with a fork test against the live Uniswap v4 router (faucet,
token info, quote, buy, sell with and without approvals, send); the sell
encoder and Permit2 approvals in `v4-swap.ts`; exact-in quotes with fee and
price impact in `market.ts`, which also fixes the service's slippage guard
on thin pools; the webhook in `api/bot.js`; `scripts/bot-set-webhook.mjs`.
Audited before any deployment: `docs/audit/2026-09-16-chit-bot.md`.

Next: session-key trading on mainnet (the same buttons, no key held), and
recovery of what a fleet wallet holds after a close.

## Turning it on

1. Vercel, the chit.tools project, environment variables: `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET` (16+ characters; the bot refuses to start
   without it, and refuses every update that does not carry it),
   `BOT_USERNAME`, `BOT_KEY_SECRET` (32+ characters with twelve distinct
   ones; never rotate once wallets exist), `BOT_FAUCET_PRIVATE_KEY` (a
   throwaway with a few tenths of test ETH; never the operator's),
   `BOT_FAUCET_ETH` (default 0.02) and `BOT_FAUCET_DAILY_ETH` (default 0.5,
   the most the faucet pays in a UTC day), `DATABASE_URL` (Neon; required,
   the wallets, locks and update ids live there), and the fleet's
   `FLEET_TOKEN_ALLOWLIST` and `FLEET_POOL_ADDRESS` if set. `vercel.json`
   gives `api/bot.js` sixty seconds and ships `landing/public/bot/**` with
   it (the share card's plate and fonts). Redeploy.
2. Once: `TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/bot-set-webhook.mjs`.
   It sets the webhook and the command menu (`--drop` also discards updates
   Telegram is holding).
3. In BotFather, `/setprivacy` Disable, so the bot sees `/pool` in the group.
4. Send the bot `/start` in private.
5. The daily invitation (`.github/workflows/announce-bot.yml`, 15:00 UTC):
   one thing the bot does, a button that opens it in private, beta and
   testnet said plainly, ideas and bugs asked for. Needs the repository
   variable `BOT_USERNAME`; `DATABASE_URL` as a secret adds the wallet
   count. `scripts/announce-bot.mjs` prints it without the secrets. It
   posts nothing while `GET /api/bot` on the site is not 200, which is the
   host saying the runtime built with every variable it needs; a button to
   a bot that does not answer is worse than no post.

The home, buy, refer and fleet cards carry a banner (`landing/public/bot/`,
served at `/bot/*.png`; `BOT_BANNER_BASE` moves them, an empty value turns
them off): the photo on top, the card as its caption, and a tap from one
banner card to another swaps the picture in place. A card that has no
banner, or whose text would not fit a caption, is plain text as before.

Before the host: `node --env-file=.env scripts/bot-poll.mjs` runs the same
runtime from one machine by long polling (any 16+ character webhook
secret), for trying it and for screenshots; it removes the webhook when it
starts, so never against the live bot. Its store: `BOT_PGLITE_DIR=<folder>`
keeps the Neon store's tables in a Postgres on disk (PGlite), so the
wallets survive a restart of the process and a redeploy of the code;
`BOT_MEMORY_STORE=1` keeps them in memory, gone when it stops. Neither
replaces Neon on the host: one machine, one process.

Testnet only: the runtime refuses to start on any other chain, because the
playground holds keys and the mainnet bot must not. A missing or malformed
variable is a refusal with its reason in the log (and a 200 to Telegram, so
it stops retrying), never a bot built on a guess.

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
[ 📊 Positions ] [ 🚀 Fleet ]
[ 🔑 Sessions ]  [ 🤝 Refer ]
[ ⚙️ Settings ]  [ 🏦 Withdraw ]
[ 🚰 Faucet ] [ ❓ Help ] [ ↻ Refresh ]
```

- **Paste any token's contract address** and its card appears: price per
  ETH, the pool's ETH, what you hold, and your buy and sell buttons. Any
  token with an ETH pool on the venue; one without says so.
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
  `docs/session-keys.md` is the contract; the bot's Buy and Sell become
  `execute` calls on your session account.

Trojan gives speed by taking your key. Chit gives speed without it.

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
   gives `api/bot.js` sixty seconds. Redeploy.
2. Once: `TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/bot-set-webhook.mjs`.
   It sets the webhook and the command menu (`--drop` also discards updates
   Telegram is holding).
3. In BotFather, `/setprivacy` Disable, so the bot sees `/pool` in the group.
4. Send the bot `/start` in private.
5. The daily invitation (`.github/workflows/announce-bot.yml`, 15:00 UTC):
   one thing the bot does, a button that opens it in private, beta and
   testnet said plainly, ideas and bugs asked for. Needs the repository
   variable `BOT_USERNAME`; `DATABASE_URL` as a secret adds the wallet
   count. `scripts/announce-bot.mjs` prints it without the secrets.

Testnet only: the runtime refuses to start on any other chain, because the
playground holds keys and the mainnet bot must not. A missing or malformed
variable is a refusal with its reason in the log (and a 200 to Telegram, so
it stops retrying), never a bot built on a guess.

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
[ ❓ Help ]      [ ↻ Refresh ]
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
  published size into the pool from your wallet, create a fleet of five
  (fresh keys, sealed; the service sees addresses and salts), activate with a
  draw, buy from every wallet through the router, pause, resume, close, and
  your pool balance. Every signed action goes through the hosted service's
  challenge flow, signed by the playground key the way the wallet signs in
  the browser. Until the service is wired to the pool it answers with its
  reason, and the card says so.
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
real transaction and the reply says its hash. One trade at a time per
wallet, so two taps cannot race on the nonce. A failure is a message with
the error's first line, never silence.

**The bot holds this key.** It says so on the card. It can, because the key
holds test ETH and test tokens and nothing else; the playground exists so
anyone can try Chit in one tap with nothing to lose. Keys are sealed at rest
(AES-256-GCM under a secret the host holds) in a store shared by every
function instance, so a user meets the same wallet whichever one answers.
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
service) with eleven conversation tests against fakes, one of which drives
the whole fleet journey against a fake service that recovers every
signature; the chain adapter with a fork test against the live Uniswap v4
router (faucet, token info, quote, buy, sell, send); the sell encoder and
Permit2 approvals in `v4-swap.ts`; exact-in quotes with fee and price impact
in `market.ts`, which also fixes the service's slippage guard on thin pools;
the webhook in `api/bot.js`; `scripts/bot-set-webhook.mjs`.

Next: session-key trading on mainnet (the same buttons, no key held), and
recovery of what a fleet wallet holds after a close.

## Turning it on

1. Vercel, the chit.tools project, environment variables: `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET` (any 16+ characters), `BOT_USERNAME`,
   `BOT_KEY_SECRET` (32+ characters; never rotate once wallets exist),
   `BOT_FAUCET_PRIVATE_KEY` (a throwaway with a few tenths of test ETH; never
   the operator's), `DATABASE_URL` (Neon, so wallets survive across
   instances), and the fleet's `FLEET_TOKEN_ALLOWLIST` and
   `FLEET_POOL_ADDRESS` if set. Redeploy.
2. Once: `TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/bot-set-webhook.mjs`.
   It sets the webhook and the command menu.
3. In BotFather, `/setprivacy` Disable, so the bot sees `/pool` in the group.
4. Send the bot `/start` in private.

Testnet only: the runtime refuses to start on any other chain, because the
playground holds keys and the mainnet bot must not.

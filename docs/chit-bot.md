# Chit Bot

The Telegram trading bot on Robinhood Chain. The card every degen knows: a
wallet, a balance, and buttons. Two modes, both labelled on the card.

## Playground (testnet, now)

Press Start in private. The bot makes you a wallet on Robinhood Chain
testnet (46630), funds it with test ETH from a faucet, and shows the card:

```
Robinhood Chain testnet · 46630
0x…your wallet…  (tap to copy)
balance: 0.02 ETH · 4.95 FLEET

[ Buy ] [ Sell ]
[ Positions ] [ Fleet ]
[ Withdraw ] [ ↻ Refresh ]
[ Help ]
```

- **Buy**: 0.001 / 0.005 / 0.01 ETH, or `/buy 0.002`. Quoted from the pool
  with fee and price impact, a 3% slippage guard, then the real Uniswap v4
  router. The reply carries the transaction hash and the tokens received.
- **Sell**: 25 / 50 / 100%, or `/sell 50`. The first sale approves Permit2
  and the router once; then the router, guard included.
- **Positions**: ETH, tokens, and what the tokens would fetch at the pool's
  current price.
- **Withdraw**: `/withdraw 0xAddress 0.01`. Test ETH, worth nothing off the
  chain.
- **Faucet**: `/faucet`, once a day per wallet, while the faucet key has ETH.
- **Fleet**: what the real product does, and where it lives today (the app).
- **/pool**: the pool's numbers, read from the chain; the one command that
  answers in the group.

Every figure is read from the chain when the card is drawn. Every trade is a
real transaction and the reply says its hash. A failure is a message with
the error's first line, never silence.

**The bot holds this key.** It says so on the card. It can, because the key
holds test ETH and test tokens and nothing else; the playground exists so
anyone can try Chit in one tap with nothing to lose. Keys are sealed at rest
(AES-256-GCM under a secret the host holds) in a store shared by every
function instance, so a user meets the same wallet whichever one answers.

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

Built (branch `feat/chit-bot`): the playground, end to end. Handlers over
ports (store, chain, Telegram) with seven conversation tests against fakes;
the chain adapter with a fork test against the live Uniswap v4 router
(faucet, quote, buy, sell, send); the sell encoder and Permit2 approvals in
`v4-swap.ts`; exact-in quotes with fee and price impact in `market.ts`,
which also fixes the service's slippage guard on thin pools; the webhook in
`api/bot.js`; `scripts/bot-set-webhook.mjs`.

Next: the fleet from the chat (the signed flow through the SDK), then
session-key trading, then any token with a v4 pool rather than the venue
token alone.

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

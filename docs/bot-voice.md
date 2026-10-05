# The bot's voice

The bot wrote in lowercase from its first card. That reads as a tone, and a
tone is a claim: it says this is a casual thing. The bot now moves real money
on mainnet, under limits a person has to read and understand, so the cards are
being converted to ordinary sentence case, card by card.

This file is the rule, so a card converted in a later phase matches one
converted today.

## What changes

- Sentences begin with a capital and end with a full stop. One idea a line
  where the line is an instruction.
- A list of limits is spelled out rather than parenthesised: "which router it
  may use, how much per trade, how much in total, and when it expires" beats
  "(which router, how much a trade, how much in all, until when)".
- No em dashes. A comma, a full stop or a colon, as in the rest of the project.

## What does not change

- Addresses, hashes and anything inside `<code>`.
- Commands: `/start`, `/positions`, `/help`.
- Symbols and units: ETH, CHIT, USDG, bps.
- Proper nouns: Telegram, Robinhood Chain, Uniswap, Sessions page, Positions.
- Button labels, which are already capitalised, and their emoji.
- The three sentences the tests pin, in meaning if not in case: that the bot
  never holds your key, that your keys stay with you, and that it is not
  audited by a firm yet. Those are safety copy. Reword them only deliberately,
  and change the assertion to the new words rather than loosening it to match.

## Order

1. home and the safety card (`bot-session.ts`) — done
2. token card and the buy flow
3. positions and sessions
4. alerts and watch
5. competition, copy, and what is left

A card is converted when its own test asserts the new words and
`./verify.sh` is green.

# Notes on the video script

**For:** the creator · 10 Sep 2026
**Short version:** the script is good. Two things in it describe stuff that is not live yet, and both are easy to fix without losing the beat.

---

## What is right in the draft

Keep all of this, it is on message:

- The bubble map opening. That is the whole video.
- "Your trades, the amounts, and your timing still show."
- "Private, not anonymous."
- "The Chit team can see the mapping."
- "You keep your keys."
- Testnet, Robinhood Chain, no real money, no audit.
- The first sponsored buy on 6 September, and the transaction.
- Ending on follow instead of a link.

---

## The two problems

**1. The funding link is not cut yet.**

The script says Chit cuts the path from your main wallet to your fleet, present tense. What is live today sponsors the gas, not the money you trade with. The pool that cuts the funding trail is written and passing its tests, but it has not been deployed. There is no pool address on chain.

Saying it in present tense is the one claim we cannot make yet, and it is the claim someone will check.

**2. The pool is described as if you can use it.**

"Deposits go into a shared pool with small caps, and if they don't pay out, you can exit yourself after 24 hours." All of that is true in the contract. None of it is deposited into by anyone yet, because it is not deployed. Same fix: say it as the next thing, not the current thing.

Everything else stands.

---

## Two smaller notes

Once the pool is live, Chit does hold your deposit for a short window. So "they're not holding the wallet for you" is right about keys and wrong about money. Worth separating the two, because the comments will separate them for you.

Check the handle before you record. If this is paid in any form, disclose it, and "my friend built this" already does most of that work.

---

## Revised script

> Traders, come.
>
> You know how when you run a lot of wallets and fund all of them from one main wallet, the chain maps the whole fleet back to you? Sometimes you don't want that exposure. *(bubble map)*
>
> A friend of mine is building Chit to cut that funding link.
>
> Here is what is live right now. Chit pays the gas for your fleet's trades. The first sponsored buy was September 6th, a fleet wallet bought through a real Uniswap router while Chit paid for it. I'll drop the transaction below. *(site visual)*
>
> *(on screen, and in the caption)*
> `0x62ced39074adaa0b922e558dbafdf8c6405b3c21fcf45b77d5d3afb3a53b2d71`
>
> Gas is the small link though. The money you are actually trading with is the big one, and today that still comes from you. He'll tell you that himself.
>
> So the thing they are building next is a shared pool. One deposit, fixed sizes, small caps, and your fleet draws from your balance instead of from your main wallet. It is written and passing tests. Not deployed yet. When it goes live they'll post the transaction, same as the first one.
>
> And even then, private, not anonymous. Your trades, the amounts, your timing, all of that still shows. The Chit team can still see the mapping, and they say so out loud. What breaks is the path from your main wallet to the rest.
>
> You keep your keys the whole time, Chit never holds those. When the pool ships it does hold your deposit for a short window, which is why the caps are small and why the contract lets you exit yourself after 24 hours if they don't pay out.
>
> Testnet only for now, on Robinhood Chain, at chit.tools. Test money, no audit.
>
> Follow @chit and watch them build it.

---

## Why this version is better than a fix

The draft had one thing to show and one claim it could not back. This one has a receipt in the middle of it, the September 6th buy on screen, and an open loop at the end. When the pool lands you get a second video with its own transaction hash, and that one is easier to make than this one.

---

## The transaction

This is the one to put in the caption and on screen. Robinhood Chain testnet, chain 46630, 6 September 2026.

```
0x62ced39074adaa0b922e558dbafdf8c6405b3c21fcf45b77d5d3afb3a53b2d71
```

A fleet wallet bought the test token through the real Uniswap router. Chit's operator paid the gas and the campaign escrow paid the operator back. Test token, no real money.

Explorer link: TO CONFIRM. Ask us for the URL before you publish rather than searching for one, because a wrong explorer on a testnet chain usually shows nothing and looks like the transaction is fake.

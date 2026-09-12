# Chit Progress Update #2: We are sponsoring the whole trade

**For:** Community Manager. Source material for an article or thread.
**Version:** 2.0 · 7 Sep 2026
**Supersedes:** the roadmap section of [CHIT-UPDATE-AND-TOKEN.md](CHIT-UPDATE-AND-TOKEN.md) v1.0 (1 Sep).
**Read first:** the [claims-discipline table in the main brief](CHIT-COMMUNITY-BRIEF.md#12-claims-discipline--what-we-can-and-cannot-say), plus Part 4 below, which changes what we can and cannot say. When unsure, ask before posting.

---

## The headline

The first article said Chit's first version sponsors gas. That has changed. Chit now funds the trade itself, not just the gas to send it.

Stage 2, the private funding pool, was on the roadmap as a later stage. We pulled it forward and it is being built now.

---

## Part 1: Why we changed it

The v1.0 article was straight with the community about a limit, and that limit is the reason for the change.

Sponsoring gas hides one link. It does not hide the trail. To buy a coin, a fleet wallet needs the money it is going to trade with, and if that money comes from your main wallet, the map gets drawn anyway. Gas was the small link. The principal was always the big one.

Two things pushed the decision.

The first is that gas-only cannot carry the claim. "No trail back to you" was never true at Stage 1, and we said so in the article. We could keep shipping a product whose headline promise sat one stage away, or we could go build the stage that makes it true.

The second is that we read our own live contracts properly and found the link. The Stage 1 escrow names the fleet owner on chain, and every fleet account in a campaign shares one campaign key. Someone reading the chain carefully can derive the main wallet to fleet link today. Stage 1 does exactly what the article said it does, and nothing beyond that, but the finding belongs in this update.

The honest version of Chit needs a pool that holds no key back to the depositor. So that is what we are building, instead of polishing a stage that ends in an asterisk.

---

## Part 2: How it works now

One deposit. Your main wallet sends ETH into a shared pool, in fixed sizes so the amount itself is not a fingerprint. Every deposit looks like every other deposit.

Your balance sits in that pool. When you launch a fleet, the fleet draws from your balance, so your main wallet never sends money to a fleet wallet for any reason.

Three details carry the privacy, and they are worth explaining because they are the actual engineering:

- Nothing on chain names both sides. No function and no event in the pool contract mentions a depositor and a fleet in the same place. We have a test that scans the contract and fails the build if one ever does.
- The money moves late. Principal lands in a fleet wallet at the moment of the buy, not when the fleet is created. There is no funded wallet sitting around waiting to be matched to a deposit by size or timing.
- The timing is broken on purpose. Funding a fleet, and posting spend against your balance, each happen after a random delay of one to fifteen minutes, so a deposit and a fleet launch do not line up on the clock.

Getting money out has two doors. Chit pays withdrawals promptly from the operator wallet, and the contract has a self-serve exit you can take after 24 hours if Chit never pays. The second door is the one that matters. It is the difference between handing money to a service and hoping, and having a way out that does not need us.

Limits, since the pool means Chit briefly holds capital: 0.5 ETH per trader, 0.2 ETH per fleet draw, 5 ETH across the whole pool. Deposits are fixed at 0.01, 0.05, or 0.1 ETH. The caps are small on purpose and stay small until an audit says otherwise.

---

## Part 3: What is actually built

The design is finished and the build is running. About half of it passes its checks today. Testnet only.

Passing its tests, on a fork of the live chain:

- The pool contract. Deposits, the fixed sizes, the caps, and the operator pause.
- The scan that proves no contract function or event names a depositor and a fleet together.
- The encrypted ledger that tracks who is owed what.
- Balances, available headroom, withdrawals paid from the operator wallet, and the 24 hour self-serve exit.
- The Balance page in the app.

Still being built:

- Fleets drawing principal from a pool balance, which is the core of the whole thing.
- The Control Room changes for pooled balances.
- The copy pass across the app, the site, and these docs.
- Deploying the pool to testnet and running a live pooled buy.

Stage 1 stays live at chit.tools throughout, and every Stage 1 check has to stay green while this lands.

---

## Part 4: Claims discipline, updated

Read this part twice. The direction change does not unlock the big claim yet.

Can say now:

- Chit is building a private funding pool that funds the whole trade, not just gas.
- The pool contract is written and passing its tests on a fork of the live chain, along with deposits, balances, withdrawals, and the self-serve exit.
- Deposits are fixed size, the caps are small on purpose, and there is a 24 hour exit that does not need Chit's cooperation.
- We found a limit in our own live Stage 1 build and published it.

Cannot say until the pool is live on testnet and a pooled buy has landed:

- Any form of "no trail back to you", including hedged versions.
- That principal funding is private today. It is not. Stage 1 is what is live.
- Anything implying the pool is running, deployed, or usable.

Cannot say at any stage, including after the pool ships:

- Anonymous, untraceable, mixer, or anything in that family.
- That Chit cannot see the mapping. Chit can. The pool hides you from the public chain, but not from us, and that stays true until Stage 3.

The line does not move: private, not anonymous. The pool makes the public chain claim true. It does not make Chit blind. Say both, in that order, every time.

Someone will also ask whether Chit holds their money. Yes, for a short window. That is why the caps are small, why the exit lives in the contract rather than in a promise, and why an audit comes before mainnet. Do not let that question get answered by silence.

---

## Part 5: Draft copy

Founder voice. Edit freely, keep the boundaries in Part 4.

Thread opener:

> We said the first version of Chit would sponsor your gas. We changed it. It sponsors the trade.
>
> Here is why, and here is the part of our own build that pushed us into it.

The reason:

> Sponsoring gas hides one link. It does not hide the trail.
>
> Your fleet still needs the money it is going to trade with. If that comes from your main wallet, the map gets drawn regardless. We wrote that in the last update. Then we went and fixed it instead of shipping around it.

The self-audit:

> We also read our own live contracts properly. Stage 1 names the fleet owner on chain. A careful observer can derive the link today.
>
> It does what we said it does in the article. We are telling you the rest because you would find it anyway, and because a privacy team that hides its own limits is not one.

Where it stands:

> The pool contract is written and passing tests on a fork of the live chain. Deposits, balances, withdrawals, and a 24 hour exit you can take without us all work.
>
> Fleets drawing from the pool is the piece being built now. Not live yet. When it is live you will see the transaction, same as last time.

Closing:

> One deposit. Fixed sizes. Small caps. An exit written into the contract instead of into a promise.
>
> Private, not anonymous. We will keep saying it that way.

---

## Notes for you, not for the post

- Do not attach a date to the pool going live. The remaining work has a real chance of turning up something that needs redesigning, and a missed date on a privacy product costs more than a vague one.
- When it does go live, we announce it the way we announced the first buy, with the transaction hash, on chain, visible.
- Everything here is testnet, test tokens, no real money, and there is no audit yet. Keep that on any post that could read as an invitation to deposit.
- $CHIT's position does not change with this update. Access and discounts, never a gate. If anyone reads the pool as a reason to expect a price move, that is not a claim we make.

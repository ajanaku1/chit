# Chit — Progress Update, Privacy Explainer & Token Plan

**For:** Community Manager, source material for a detailed article/thread.
**Version:** 1.0 · 1 Sep 2026
**Read first:** the [claims-discipline table in the main brief](CHIT-COMMUNITY-BRIEF.md#12-claims-discipline--what-we-can-and-cannot-say). Everything below stays inside those rules. When unsure, ask before posting.

This document has three parts you can turn into one article or split into a thread:
1. Where we are right now.
2. Why the full product takes time (the privacy-tech story).
3. The plan for the token.

---

## Part 1: Where we are right now

We're building in the open, so here's the honest state.

**Live on testnet.** The core Chit Fleet contracts are deployed and verified on Robinhood Chain testnet (chain 46630). Not a mock, not a slide, real contracts, real bytecode you can look up on-chain:

- Fleet account factory, session policy, and campaign escrow: deployed and verified.
- A verifying paymaster (the piece that actually sponsors gas and settles the cost): built and tested against a live blockchain, deploying next.

**The app is built.** The full trader flow exists as a web app: connect wallet, size your fleet, generate your wallets in the browser, download an encrypted backup, and a dashboard to watch the budget and pause, stop, or refund. The wallet-generation and encrypted-backup steps already run for real, in your browser, with no backend.

**What's left before you can do a full sponsored buy in the app.** Being straight about this matters more than hype:

- Deposit gas into the paymaster so it can sponsor transactions.
- Wire the app to the deployed contracts (right now the app runs on an internal test engine, not the live contracts yet).
- Set up something to trade against on testnet.
- Deploy the connected app so the buy flow is live end to end.

So: the foundation is on-chain and the app is built, but a holder can't run an end-to-end sponsored buy today. That's the next milestone, and it's close. Early access for $CHIT holders opens when it lands.

---

## Part 2: Why the full product takes time

Short version: we're building real privacy infrastructure and real security, not a screenshot. Here's the honest breakdown for the community.

### Two kinds of privacy

Chit started life as a hackathon project that did something genuinely hard: it hid the link between who paid for a transaction and who received it, and it kept that link encrypted *on-chain* using confidential computing (secure hardware enclaves, via a system called iExec Nox). That version answered the hardest question: can you hide the relationship on-chain, with no trusted middleman? Yes. It settled real transactions on Ethereum testnet.

The Chit Fleet product you'll actually use takes a more practical approach for now. Instead of encrypting the relationship on-chain, it simply never creates the link in the first place. Your gas comes from a shared pool, so there's no transaction connecting your main wallet to your fleet. That's the honest boundary we've stated from day one:

- What's hidden: the funding link between your main wallet and your fleet.
- What's public: the fleet wallets, their trades, amounts, timing, and gas.
- The trade-off: in this version, Chit's operator can see the mapping. We say so plainly: it's hidden from the public chain, but not from us.

The deeper, no-middleman version (where not even the operator can see the mapping) is the upgrade path, not the launch. That's the honest reason the *full* privacy vision takes time: the launch product ships the privacy we can deliver truthfully today, and the stronger version comes later.

### Why the on-chain version isn't here yet

The hackathon version was built on iExec Nox, a confidential-computing tech that kept the private mapping encrypted on-chain. Nox isn't available on Robinhood Chain yet, so that version can't run here today. The Fleet product uses the practical approach above for now, and the Nox-style version stays on the roadmap for when Nox reaches Robinhood.

### The takeaway for the community

We're not slow because we're stuck. We're deliberate because we're building the real thing: on-chain contracts, a real gas-sponsoring paymaster, security hardening against every issue our review found, and a clear plan for deeper privacy once the tech for it is available on Robinhood.

---

## Part 3: The token plan

Here's how we think about $CHIT, and the language we use around it. This section is deliberately careful. Read it before writing anything about the token.

### The token is about access, not promises

$CHIT's job is to connect you to the product:

- **Eligibility.** Holding $CHIT above a threshold lets you create a fleet.
- **Discounts.** Holders pay a lower service fee.
- **Early access.** Holders get first access to new features, starting with the testnet early-access round.

The flywheel is simple and honest: as more people use Chit, more people need $CHIT to use it and to get better terms. Real usage creates real reasons to hold. That's a reason to hold that doesn't depend on anyone promising you a price.

### It's cheap to qualify, on purpose

The amount of $CHIT you need to hold to use the protocol is deliberately small. Low enough that a regular trader, not a whale, can comfortably hold it. Eligibility is a light touch that ties the token to the product. It isn't a paywall meant to price people out. The goal is for almost anyone who wants to use Chit to be able to afford to qualify.

### On buybacks and fees: the honest policy

Trading fees are helping fund the build, and it's fair that the token benefits from the protocol's success. Here's how we'll handle that, and it's important we say it this way:

- A portion of fees may fund buybacks and ecosystem incentives.
- Those decisions are made transparently, and only once real revenue exists and the essentials are covered first: security audit, infrastructure, paymaster liquidity, and runway to keep building.
- We report buybacks after they happen. We don't pre-promise amounts.

Why we talk about it this way, and why the CM should too:

- **We do not promise price, returns, or guaranteed buybacks.** Not a number, not a date, not "payback for holders." Promising returns turns a community token into something regulators and exchanges treat very differently, and it sets us up to disappoint people if reality doesn't match a number we tweeted. We're not doing that.
- **We reward early believers with utility, not price promises**, early access, better limits, lower fees. Things we can actually deliver.
- **Buybacks, if and when they happen, strengthen the protocol** (treasury, paymaster liquidity) and are shown after the fact, never dangled beforehand.

If someone in the community asks "wen buyback" or "how much will the token do," the correct answer is the honest one: the token is for access and discounts, the protocol funds itself first, and any buybacks are transparent and reported after they happen, never promised in advance.

### What NOT to say about the token

- No price predictions, no "100x," no guaranteed graduation.
- No promised buyback amounts or dates.
- No "payback for holding" or "revenue share" framing.
- No implying the token is an investment.

(Full list in the [claims-discipline table](CHIT-COMMUNITY-BRIEF.md#12-claims-discipline--what-we-can-and-cannot-say).)

---

## Article angles & talking points

Pick what fits the format. All of these stay truthful.

**Headline options**
- "Building in the open: where Chit is, and why the real thing takes time."
- "Chit is live on testnet. Here's what that means, and what's next."
- "Why we're building privacy the hard way."

**Key messages to hit**
- Core contracts are live and verified on Robinhood testnet. Real, not mock.
- The app is built; end-to-end sponsored buys are the next milestone; early access for holders follows.
- Our privacy is honest: we hide the funding link, not your trades, and we say exactly what the operator can see.
- The deeper, no-middleman privacy is a roadmap item: it was built on iExec Nox, which isn't available on Robinhood Chain yet.
- $CHIT is about access and discounts, it's cheap to qualify, and the protocol funds itself before anything else.

**Suggested thread shape**
1. Hook: we're live on testnet, and we're going to be straight about where things stand.
2. What's built (contracts + app), what's next (end-to-end buys, early access).
3. The privacy story: what we hide, what we don't, and why we say it plainly.
4. Why the strongest privacy takes time: the tech it was built on (Nox) isn't on Robinhood yet.
5. The token: access, cheap to qualify, honest treasury policy. No promises.
6. Close: we'd rather build the real thing honestly than ship a mock. Early access is coming.

**Tone**
Confident, plain, a little dry. We respect the reader. We under-promise. Honesty is the brand, it's the thing most projects won't do, and it's why people should trust this one.

---

## Disclaimers (keep these in mind, don't necessarily publish verbatim)

- The product is testnet-stage and not yet usable end to end. Don't imply it is.
- Nothing here is financial advice or an offer. $CHIT is a community access token. Do not present it as an investment or promise any return, price move, or buyback amount.
- Privacy claims are limited to those stated above. Do not extend them.
- The contracts have not had a professional third-party audit yet. Don't call the product "audited" or "safe for real funds" until one is done.
- The token utility details (exact threshold, discount, fee) are being finalized. Describe them directionally; don't publish specific numbers until confirmed.

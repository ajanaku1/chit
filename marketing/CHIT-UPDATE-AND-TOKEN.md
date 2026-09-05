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

**Live on testnet.** The core Chit Fleet contracts are deployed and verified on Robinhood Chain testnet (chain 46630). Not a mock, not a slide, real contracts, real bytecode you can look up on-chain. The three live addresses:

- Session policy: `0x57c7436bbbb40b08adef5c84f0aeaee0c4f3e011`
- Account factory: `0x5c0e2ec619c11b66e0e0efb7931bccfa6b784ea6`
- Campaign escrow: `0xd2c31ec466ead5f745bc6ba08cc49ff8435f1325`

A verifying paymaster (the piece that actually sponsors gas and settles the cost) is built and tested against a live blockchain, and deploys next.

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

The Chit Fleet product you'll actually use takes a more practical approach. Instead of encrypting the relationship on-chain, it never creates the link in the first place. Your fleet's gas comes from a shared pool, so no transaction shows your main wallet paying for the fleet's gas.

Here's the part we have to be precise about, because it's where most "private trading" projects quietly cheat. Sponsoring gas is not the whole job. To actually buy a coin, each fleet wallet also needs the money it's going to trade with (the principal). Today, that principal still has to be funded, and if it comes from your main wallet, that's a trail. A bigger one than the gas.

So the honest boundary today:

- What's hidden today: the gas-funding link between your main wallet and your fleet.
- What's not hidden yet: the trade principal. Funding it privately is the next stage (see the roadmap below).
- What's always public: the fleet wallets, their trades, amounts, timing, and gas.
- The trade-off: in this version, Chit's operator can see the mapping. We say so plainly: it's hidden from the public chain, but not from us.

The full promise, where even the trading capital leaves no trail, is a roadmap stage, not something live today. We won't pretend otherwise.

### The roadmap: from private gas to private funding

The whole point of Chit is that funding a fleet shouldn't leak a trail back to you. Getting there is three stages, and we're honest about which one we're in.

- **Stage 1 (now): private gas.** Chit sponsors the fleet's gas from a shared pool. This proves the plumbing and is what's live on testnet.
- **Stage 2: private funding.** Chit funds the fleet's trading capital too, from one pooled deposit, so your main wallet never funds the fleet directly. This is the stage where "no trail back to you" actually becomes true. It means Chit briefly holds pooled capital, so it comes with strict limits, a security audit, and the accountable-privacy model below.
- **Stage 3 (the final product): trustless private funding.** A shielded pool where nobody, not even Chit, can link your deposit to your fleet, with a view key so you can still prove a flow to an auditor if you choose. This needs privacy tech that isn't on Robinhood yet, so it's the north star.

Start narrow, prove it, then widen. We ship what's real at each stage and say plainly what's still ahead.

### Why the on-chain version isn't here yet

The hackathon version was built on iExec Nox, a confidential-computing tech that kept the private mapping encrypted on-chain. Nox isn't available on Robinhood Chain yet, so that version can't run here today. The Fleet product uses the practical approach above for now, and the Nox-style version stays on the roadmap for when Nox reaches Robinhood.

### Private, not anonymous

This is the line we want the community to remember, because it's what keeps Chit on the right side of regulation.

Chit is not a mixer. Mixers try to make you disappear: nobody can ever know it was you. That path gets sanctioned and delisted, and wallets that touch it get frozen. We're building the opposite idea, called selective disclosure.

The goal is that the link between your main wallet and your fleet stays hidden from the public, but you hold a key that lets you prove specific facts to a specific party when you choose to. Think of it like a bank statement you can show an auditor: the public sees nothing, but you can reveal one flow to one party without revealing everything. Privacy for everyone else, accountability when it matters.

Today this is partial and honest: the mapping is hidden from the public chain, and the operator holds it. The direction we're building toward is user-held view keys, where you, not the operator, decide who gets to see what. That is real, active research (combining zero-knowledge privacy with auditability), and it's the same idea our hackathon version already touched: back then, a designated auditor could decrypt a round while everyone else was denied.

So the honest framing is: private, not anonymous. Accountable privacy, not a mixer. We'll say what's delivered and what's still direction, and we won't pretend the trustless version exists before it does.

### The takeaway for the community

We're not slow because we're stuck. We're deliberate because we're building the real thing: on-chain contracts, a real gas-sponsoring paymaster, security hardening against every issue our review found, and a clear plan for deeper, accountable privacy (selective disclosure and user-held view keys) as the tech for it reaches Robinhood.

---

## Part 3: The token plan

Here's how we think about $CHIT, and the language we use around it. This section is deliberately careful. Read it before writing anything about the token.

### The token is about access, not promises

$CHIT's job is to connect you to the product:

- **Discounts.** Holders pay a lower service fee.
- **Early access.** Holders get first access to new features, starting with the testnet early-access round.
- **Governance, later.** Holders get a say in how verified service revenue is used, once there is any to talk about.

One thing $CHIT does not do: it does not gate the door. You do not need to hold $CHIT to create a fleet. We removed that on purpose. Requiring $CHIT on your main wallet would mark that wallet as a Chit user, which is exactly the kind of trail a privacy tool should not create. So holding is optional, and it only ever makes the product cheaper or earlier for you.

The flywheel is simple and honest: as more people use Chit, more people want $CHIT for better terms. Real usage creates real reasons to hold. That's a reason to hold that doesn't depend on anyone promising you a price.

### It's cheap to qualify, on purpose

The amount of $CHIT you need to hold for the discount and early access is deliberately small. Low enough that a regular trader, not a whale, can comfortably hold it. It's a light touch that ties the token to the product, not a paywall. The goal is for almost anyone who wants better terms on Chit to be able to afford them.

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
- Core contracts are live and verified on Robinhood testnet, at published addresses. Real, not mock.
- The app is built; end-to-end sponsored buys are the next milestone; early access for holders follows.
- Stage 1 (now) is private gas. The full promise, funding your fleet with no trail back to you, is the funding-pool stage on the roadmap. Say which stage we're in, don't skip ahead.
- Private, not anonymous. We hide the funding link, not your trades, and we say exactly what the operator can see.
- Chit is not a mixer. We're building selective disclosure: hidden from the public, provable to an auditor you choose. Privacy with accountability.
- $CHIT is optional: discounts and early access, never a gate on your main wallet. Cheap to qualify, and the protocol funds itself before anything else.

**Suggested thread shape**
1. Hook: we're live on testnet, and we're going to be straight about where things stand.
2. What's built (contracts + app, with addresses), what's next (end-to-end buys, early access).
3. The privacy story: what we hide, what we don't, and why we say it plainly.
4. The honest gap: gas is stage one; funding your fleet with no trail is the next stage. Here's the three-stage roadmap.
5. Private, not anonymous: selective disclosure, why we're not a mixer, and why that's the survivable path.
6. The token: access, cheap to qualify, honest treasury policy. No promises.
7. Close: we'd rather build the real thing honestly than ship a mock. Early access is coming.

**Tone**
Confident, plain, a little dry. We respect the reader. We under-promise. Honesty is the brand, it's the thing most projects won't do, and it's why people should trust this one.

---

## Disclaimers (keep these in mind, don't necessarily publish verbatim)

- The product is testnet-stage and not yet usable end to end. Don't imply it is.
- Nothing here is financial advice or an offer. $CHIT is a community access token. Do not present it as an investment or promise any return, price move, or buyback amount.
- Privacy claims are limited to those stated above. Do not extend them.
- The contracts have not had a professional third-party audit yet. Don't call the product "audited" or "safe for real funds" until one is done.
- The token utility details (exact threshold, discount, fee) are being finalized. Describe them directionally; don't publish specific numbers until confirmed.

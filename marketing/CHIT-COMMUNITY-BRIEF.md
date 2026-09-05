# Chit — Community & Marketing Brief

**For:** Community Manager onboarding
**Version:** 1.0 · Last updated: 31 Aug 2026
**Status:** Product testnet-ready; not yet deployed to a public network. Read the [Claims Discipline](#12-claims-discipline--what-we-can-and-cannot-say) section before writing anything public.

Contract address (CHIT): `0xD523A627030509021cC39B6d7C8543417D3E50D8`
Repository: https://github.com/ajanaku1/chit

---

## Contents

1. [The 15-second pitch](#1-the-15-second-pitch)
2. [Backstory — how Chit got here](#2-backstory--how-chit-got-here)
3. [What Chit is (plain English)](#3-what-chit-is-plain-english)
4. [The problem we solve](#4-the-problem-we-solve)
5. [How it works](#5-how-it-works)
6. [The privacy boundary — stated honestly](#6-the-privacy-boundary--stated-honestly)
7. [Who it's for](#7-who-its-for)
8. [Product scope — built vs. coming](#8-product-scope--built-vs-coming)
9. [White paper](#9-white-paper)
10. [$CHIT — the token and its utility](#10-chit--the-token-and-its-utility)
11. [Positioning & messaging pillars](#11-positioning--messaging-pillars)
12. [Claims discipline — what we can and cannot say](#12-claims-discipline--what-we-can-and-cannot-say)
13. [Community toolkit](#13-community-toolkit)
14. [Roadmap](#14-roadmap)
15. [FAQ](#15-faq)
16. [Glossary](#16-glossary)
17. [Assets & links](#17-assets--links)
18. [Disclaimers](#18-disclaimers)

---

## 1. The 15-second pitch

**Chit is a private gas desk for traders who run more than one wallet.**

Fund one ETH budget, run a whole fleet of trading wallets off it, and the chain never shows your main wallet paying for any of them. Your keys stay yours. You set the spend limits, and you can pause, stop, or pull unused ETH back whenever you want.

**One line:** *One budget. Many wallets. No public trail funding them back to you.*

---

## 2. Backstory — how Chit got here

Chit did not start as a trader tool. It started as a hackathon project, and a proof.

The original build was made for a hackathon, on iExec's confidential-computing stack (iExec Nox). It was a confidential gas-sponsorship system on Ethereum: a way to pay for someone else's on-chain transaction without publishing the link between the sponsor and the person being sponsored. It used trusted-execution (TEE) computation to keep that relationship encrypted while the transaction itself stayed public. And it wasn't a slide-deck demo, it was a working ERC-4337 build that settled real transactions on Ethereum Sepolia testnet, with the sponsor-to-user mapping kept off the public graph, verifiable on a block explorer.

That hackathon build answered a narrow question, and answered it for real: *can you sponsor gas privately, on-chain, today?* Yes. That's the seed everything else grew from.

Then a more practical question showed up from the people who actually feel the problem: meme traders who run fleets of wallets. If you run 10, 20, 50 sniper wallets, the moment you top them all up with gas from one main wallet, you've drawn a map. Anyone with a block explorer and a bubble-map tool can see that 30 wallets were funded by the same wallet, and cluster them straight back to you.

Chit's second life answers that. Take the private-sponsorship engine and turn it into something a trader can actually use to fund a fleet, without that funding trail existing on-chain.

The token, $CHIT, launched on Pons (Pons V2 fair-launch, paired with ETH, 1 billion fixed supply, 1% creator tax). The token came first as a community rally point. The product is what gives it a reason to exist past the chart.

**The story in one line:** we built private gas as a science experiment, the traders told us where to point it, and now we're building the tool.

---

## 3. What Chit is (plain English)

Imagine you trade with a bunch of wallets, not just one.

Normally, every one of those wallets needs ETH to pay gas. You send that ETH from your main wallet. That's the leak, the funding transactions are public and permanent, and they connect every trading wallet back to you.

Chit changes where the gas comes from. Instead of your main wallet topping up each trading wallet, you fund **one shared gas budget**. Chit sponsors the gas for every wallet in your fleet out of that budget. On-chain, your trading wallets just... have their gas paid. There's no transaction showing your main wallet funding them.

Three promises, in the user's words:

- **You keep the keys.** The fleet's wallets are generated inside your browser and never leave it. Chit is non-custodial. It never holds your keys.
- **One gas budget.** Fund it once, in ETH. Every wallet trades off it. You set the limits.
- **Your main wallet stays out of sight.** The chain never shows it funding the fleet.

---

## 4. The problem we solve

**The funding trail is how wallet fleets get de-anonymized.**

Chain-analysis tools (Bubblemaps, Arkham, Nansen, and every free explorer) cluster wallets mainly by following the money. "Wallet A sent gas to wallets B through Z" is the single clearest signal that they're one operator. Sniper fleets, launch teams, community wallets, DAO contributor sets, they all have the same weak point: somebody funds them, and that funding is public.

Traders currently deal with this by hand: fresh wallets, mixers, CEX withdrawals to break the trail, careful timing. It's tedious, error-prone, and one lazy top-up undoes all of it.

Chit removes the need for the funding transaction to exist at all. The gas comes from a shared paymaster, not from you. That single edge, the one that clusters a fleet back to its owner, is the one we never draw.

---

## 5. How it works

The trader journey, start to finish:

1. **Connect** your main wallet. Chit asks your wallet to switch to the supported network. No $CHIT is required to continue. If you hold $CHIT, a read-only, off-chain balance check applies your discount; it doesn't link your wallet to anything.
2. **Size your fleet.** Pick how many wallets (5–50) and how much ETH to budget, and a duration. Everything technical (the router, the gas caps) is preset to a verified route.
3. **Save your backup.** Chit generates the fleet's wallets *in your browser* and hands you one encrypted backup file. Only your wallet's signature can open it. You download it, then sign once more to prove it opens, before any money moves. Lose that file and your local browser data, and nobody can recover the fleet, not even Chit. That's the cost of being genuinely non-custodial.
4. **Launch.** Fund the budget and switch the fleet on.
5. **Trade & manage.** Each wallet makes its approved buy, gas paid from the shared budget. From the dashboard you watch the budget draw down and can **pause**, **resume**, **stop for good**, or **close and get unused ETH back** at any time.

Under the hood it's built on account abstraction (ERC-4337 smart accounts + bounded session keys), so a wallet can only do the one approved action within the limits you set, it can't be tricked into draining itself or sending your funds somewhere.

---

## 6. The privacy boundary — stated honestly

**This is the most important section in this document. Read it twice.** Chit is a privacy tool, and the worst thing we can do is promise privacy we don't deliver. Being precise here is a feature, not a weakness, it's what separates us from the scams.

### What stays private

- **The link between your main wallet and your fleet wallets is not published on-chain.** The chain shows no transaction of your main wallet funding the fleet. That specific edge (the one bubble-map tools use to cluster a fleet back to its owner) does not exist.

### What is fully public (do not claim otherwise)

- **The fleet wallets themselves**, their addresses, and every trade they make.
- **The amounts, the tokens, the timing, and the gas** of those trades.
- **The shared paymaster** that sponsored them.

Chit does **not** hide trades. It does **not** make wallets invisible. It does **not** make you "anonymous" or "untraceable."

### The honest caveats (say these plainly)

- **The operator knows the mapping.** In the current version, Chit's operator can see which fleet belongs to which trader. Hidden from the *public* is not the same as hidden from *Chit*. We say this out loud.
- **Privacy scales with the crowd.** If hundreds of traders use the shared paymaster, your fleet hides among thousands of wallets. If you're the only user, "someone using Chit" and "you" are the same suspect. Adoption is part of the privacy.
- **You can undo it yourself.** The moment you consolidate profits from the fleet back into your main wallet, you draw the exact line Chit avoided. Exit discipline matters as much as entry.
- **Behavioral clustering still exists.** Wallets that share a paymaster, launch together, and buy the same token within seconds can still be *grouped* as one operator by advanced tools. What they can't read off the chain is *which human* is behind them.

**The truthful headline:** *"Your main wallet never appears on-chain next to your fleet."* — not — *"untrackable."*

---

## 7. Who it's for

Primary audience, in priority order:

- **Individual meme traders** running 5–50 wallets. The launch persona.
- **Small trading teams / alpha groups** sponsoring member wallets from a shared budget.
- **Launch teams and community wallets** that need to operate many addresses without a public funding map.
- **Later:** DAO contributor sets, game studios with many player accounts, agent/automation fleets.

We lead with meme traders because that's who asked for it and who feels the pain hardest. We describe the product a little more broadly (*wallet-fleet infrastructure*) because the same machine serves all of the above.

---

## 8. Product scope — built vs. coming

Be precise about this in public. Overstating readiness is the second-fastest way to lose trust.

### Built and working today

- The complete trader flow as a web app: connect → size fleet → generate wallets in-browser → download encrypted backup → confirm → dashboard.
- The encryption for the recovery backup, generated and verified entirely in the browser (real cryptography, tested exhaustively).
- The full engine behind it: the optional-discount fee logic, the bounded session-key policy, the ETH budget accounting, and the lifecycle controls (pause / resume / stop / close-and-refund).
- The on-chain contracts (fleet accounts, session policy, campaign escrow), **hardened against every issue our security review found**, and tested against a live blockchain environment.
- Deployment tooling ready to push those contracts to testnet with one command.

### Not done yet (do not imply it is)

- **Not deployed to a public network.** There is no live contract address a user can interact with today.
- **The live sponsored buy** is pending the testnet deployment and a funded paymaster.
- **A professional third-party security audit**, required before real money, not yet done.

### The honest status line for public use

> *"Chit is built and hardened. Testnet deployment and early access for $CHIT holders are coming soon."*

---

## 9. White paper

*A plain but complete technical and economic overview. Suitable to adapt into a formal PDF; keep the honesty intact when you do.*

### 9.1 Abstract

Chit is non-custodial infrastructure for privately funding the gas of a fleet of programmable wallets. A trader funds a single ETH budget; Chit's paymaster sponsors the gas for every wallet in the fleet, so no on-chain transaction links the trader's primary wallet to the fleet it controls. Wallets, trades, and gas remain public; only the primary-to-fleet funding relationship is withheld from the chain. The system is built on the ERC-4337 account-abstraction standard with bounded session keys, so each fleet wallet can perform only the single approved action within trader-set limits.

### 9.2 Motivation

The dominant heuristic in on-chain forensics is fund-flow tracing. A set of wallets that are all funded from one source are trivially clustered to that source. For any operator of multiple wallets (traders, launch teams, communities) this funding trail is the primary de-anonymization vector. Existing mitigations (fresh wallets, mixers, exchange hops) are manual, fragile, and undone by a single careless top-up. Chit eliminates the vector at its root by removing the need for the funding transaction to exist.

### 9.3 System overview

Four components:

- **Fleet accounts.** Newly generated ERC-4337 smart accounts, one per fleet wallet, controlled by browser-generated keys. Never imported EOAs.
- **Session policy.** One bounded session key per campaign. It authorizes exactly one operation (the approved buy) on the approved router, within the trade cap, per-wallet gas cap, total gas budget, and expiry. It rejects arbitrary transfers, ownership changes, gas withdrawal, key authorization, and any unapproved contract call.
- **Campaign escrow.** Holds the campaign's ETH budget. It reserves before a sponsored request, commits only the actual cost, rolls failed reservations back, and returns unused ETH to the owner on close.
- **Paymaster.** Sponsors the gas for authorized fleet operations out of the shared pool.

### 9.4 The recovery vault

Because fleet keys are generated in the browser and never transmitted, loss of local data would mean loss of the fleet. Chit mitigates this with a versioned, encrypted recovery vault:

- A random data-encryption key encrypts the fleet's key material (AES-256-GCM).
- A key-encryption key is derived from a signature by the trader's primary wallet (via HKDF-SHA256), so **only that wallet can ever open the backup.**
- The trader downloads the encrypted vault and must prove it opens (a second signature and full decrypt round-trip) **before any funding is allowed.**
- Only a commitment (hash) of the vault ever reaches Chit's service, never the keys, never the ciphertext.

Every failure to open the vault (wrong wallet, tampered file, changed context) collapses into one indistinguishable error, so an attacker learns nothing from probing it.

### 9.5 Security model

The contracts have been hardened against a full security review. Key protections:

- **Owner escape hatch.** The owner can always recover tokens and ETH a fleet account holds, directly, outside the sponsored path, so assets a fleet buys are never stranded.
- **Bounded authorization.** The sponsored path is operator-driven and policy-bound; it cannot move assets arbitrarily.
- **Budget integrity.** Reservations are keyed and idempotent; a retry never double-charges; a race between the operator settling a transaction and the owner closing the campaign is resolved by a time-bounded lock, with an owner escape hatch if the operator ever abandons a locked reservation.
- **Anti-squatting and validation.** Campaigns are registered to their owner before funding; sessions reject malformed configuration (wrong chain, past expiry, zero router, inconsistent gas budgets).

Every fix is proven by automated tests that run against a live blockchain environment, and the whole suite gates every change.

**Explicit limitation:** contracts holding real user funds warrant a professional third-party audit before mainnet. That audit is planned and has not yet been done. Nothing in this document substitutes for it.

### 9.6 Trust assumptions

- **Non-custodial keys.** Chit never holds fleet keys. It cannot move a user's funds.
- **Operator knows the mapping.** In the current version, a trusted operator can see the primary-to-fleet relationship and verifies budget solvency. This is a deliberate, disclosed assumption of the current design, not a hidden one. Reducing this trust (toward operator-blind attribution) is future work.
- **Public trades.** Chit makes no claim that trades, amounts, or timing are private. Only the funding edge is withheld.

### 9.7 Network

Chit's fleet product targets a network with first-class ERC-4337 and EIP-7702 support and a live decentralized-exchange stack, so the session-key and sponsorship model is native rather than emulated. The original confidential-settlement proof remains on Ethereum. The demo and early access are testnet-only; the product does not present testnet activity as a production integration.

### 9.8 Token

See [Section 10](#10-chit--the-token-and-its-utility). In brief: $CHIT is optional. Holding it grants discounts and early access; it never gates fleet creation. Gas budgets are denominated in ETH, not $CHIT — the token is not required to pay for gas, which avoids forced conversions and sell pressure.

---

## 10. $CHIT — the token and its utility

### The facts

- **Launch:** Pons V2 fair launch on ponsfamily.com, paired with ETH.
- **Supply:** 1,000,000,000 (1 billion), fixed. No mint function.
- **Tax:** 1% creator fee.
- **Contract:** `0xD523A627030509021cC39B6d7C8543417D3E50D8`

Because this is a Pons V2 launch, the token's supply, tax, and trading mechanics are fixed and cannot be rewritten. Utility is added by the products built *around* the token, not by changing the token.

### What $CHIT does (the utility plan)

- **No gate.** You do not need $CHIT to create a fleet. Requiring it on the main wallet would fingerprint that wallet as a Chit user, which defeats a privacy tool.
- **Discounts.** Holders get a reduced service fee.
- **Early access.** Holders get first access to new capabilities (the first of which is the testnet early-access round).
- **Governance, later.** Whether any part of verified service revenue supports holder benefits, buybacks, or gas credits is a decision to be made transparently by the community, with runway and legal considerations weighed first, not an impulsive promise.

### What $CHIT deliberately does NOT do

- **It is not the gas currency.** Gas budgets are ETH. We don't force $CHIT conversions to use the product, because that creates friction and sell pressure and helps nobody.
- **It is not a yield or revenue-share instrument today.** Do not market it as one. Do not promise distributions, buybacks, or returns. (See [Claims Discipline](#12-claims-discipline--what-we-can-and-cannot-say).)

### How to talk about the token

Point at **shipped evidence**, not price. "Testnet paymaster deployed." "First 100 sponsored operations." "First external team ran a private campaign." Real usage is a far stronger narrative than manufactured volume, and it's the only kind that survives scrutiny. **Avoid** wash trading, incentivized volume, and artificial buybacks staged purely for chart activity, they destroy trust fast and we don't do them.

---

## 11. Positioning & messaging pillars

**Category:** Wallet-fleet infrastructure. **Wedge:** private gas for meme traders.

Four pillars everything ladders up to:

1. **Private funding, not private trading.** We break the one link that clusters your fleet back to you, and we're precise about the rest. Precision is the brand.
2. **You keep the keys.** Non-custodial, always. Chit never touches your keys and never can.
3. **Bounded and reversible.** Hard spend caps, one approved action per wallet, pause or stop or refund whenever you want. It's a leash, not a blank check.
4. **Built in the open, honestly.** Hardened contracts, tests that gate every change, and a team that tells you exactly what is and isn't private. We'd rather under-promise.

**Tone:** confident, technical but readable, a little dry, allergic to hype. We sound like builders who respect the reader, not a pump account.

---

## 12. Claims discipline — what we can and cannot say

Print this. Pin it. This is the guardrail that keeps us out of trouble, reputationally and legally. When unsure, ask before posting.

| ✅ Say this | ❌ Never say this |
|---|---|
| "Your main wallet never appears on-chain next to your fleet." | "Untraceable." / "Anonymous." / "Invisible wallets." |
| "We break the funding trail that clusters a fleet to its owner." | "Your trades are private." (Trades are public.) |
| "Private *funding*." | "Fleet-wide unlinkability." (We explicitly don't claim this.) |
| "Non-custodial — we never hold your keys." | "We keep your funds safe." (Custody framing — we're not a custodian.) |
| "The operator can see the mapping in this version." (disclose it) | Implying nobody, including Chit, can link you. |
| "Testnet-ready; deployment and early access coming soon." | "Live now." / "Trade on Chit today." (Not deployed yet.) |
| "Hardened contracts, tested against a live chain." | "Audited." / "Audit-proof." (No third-party audit yet.) |
| "$CHIT is optional: discounts and early access." | "You need $CHIT to use Chit." / "$CHIT pays for gas." (No gate; gas is ETH.) |
| Point to shipped milestones. | Promise price, returns, buybacks, or distributions. |
| "This is a testnet demonstration." | Present testnet as a production/mainnet integration. |

**Two hard rules:**

1. **Never promise financial return or price action.** No "100x," no "guaranteed graduation," no "buybacks incoming," no APY. This is both a trust issue and a legal one.
2. **Never overstate privacy.** If a claim could make someone believe their *trades* are hidden or that they are *anonymous*, it's wrong. When in doubt, downgrade the claim.

If a community member asks "so is it actually private?" — the correct answer is the honest one from [Section 6](#6-the-privacy-boundary--stated-honestly). That honesty is a selling point. Lead with it.

---

## 13. Community toolkit

### Approved taglines

- One budget. Many wallets. No public trail back to you.
- Private gas for your whole wallet fleet.
- Fund once. Trade everywhere. Stay off the map.
- Your keys. Your fleet. Your business.
- We break the funding trail. We're honest about the rest.

### Elevator descriptions (pick by length)

- **Short:** Chit is private gas for traders who run multiple wallets. Fund one ETH budget, run your whole fleet off it, and your main wallet never shows up on-chain funding them.
- **Medium:** Chit lets a trader fund one shared ETH gas budget for a fleet of 5–50 self-custodied wallets. Chit sponsors the gas, so the chain never shows your main wallet topping up the fleet, the exact link bubble-map tools use to cluster your wallets back to you. Trades stay public; the funding trail doesn't exist.

### Sample posts (adapt the voice, keep the claims)

**Progress / build-in-public:**
> While humans were sleeping, our dev was cooking.
> Chit turned into something real: private gas for your whole wallet fleet. Fund one ETH budget, run all your wallets off it, and your main wallet never shows up on-chain next to them.
> Your keys stay yours. Encrypted backup, hard spend caps, pause or kill it anytime.
> Hitting testnet soon. $CHIT holders get early access first.

**Education / privacy explainer (thread starter):**
> Quick truth about wallet privacy 🧵
> Most fleets get de-anonymized the same boring way: one wallet funds all the others, and that trail is public forever. Bubble maps love it.
> Chit removes the trail. Your gas comes from a shared budget, not from you. Here's exactly what that does and doesn't hide 👇

**Honesty-as-brand (this performs better than hype in crypto):**
> We're not going to tell you Chit makes you invisible. It doesn't.
> Your trades stay public. What we hide is the funding link between your main wallet and your fleet — the one thing that clusters them back to you.
> Private funding, not private trading. We say it plainly because most projects won't.

### Discord / Telegram structure (suggested)

- **#announcements**, milestones only, low noise.
- **#start-here**, the plain-English pitch + the privacy boundary + FAQ pinned.
- **#how-it-works**, walkthroughs, the trader journey, the recovery-vault explainer.
- **#privacy-truths**, a channel that *proudly* states the limits. Turns our honesty into culture.
- **#early-access**, $CHIT holder gating and testnet onboarding when live.
- **#support**, recovery-vault help is the #1 predictable support need; prep for it.
- **#gm / community**, the usual.

### Recurring content ideas

- "What bubble maps see vs. what Chit hides", visual, side-by-side.
- "The one leak that de-anons every fleet", the funding-trail explainer.
- Shipped-evidence drops: each testnet milestone as its own post.
- Recovery-vault deep dive: why non-custodial means *you* hold the backup.
- Myth-busting: "No, this isn't a mixer. Here's the difference."

---

## 14. Roadmap

Framed as evidence, not dates, ship, then announce.

- **Now:** Product built and hardened. Deployment tooling ready.
- **Next:** Deploy contracts to testnet; open early access to $CHIT holders; land the first live sponsored buy on testnet.
- **Then:** First external trading team runs a private campaign; publish a live usage dashboard (sponsored operations, gas sponsored, active fleets, paymaster reserve, contract addresses).
- **Before mainnet:** Professional third-party security audit; production bundler; strict allowlists and conservative budgets.
- **Later:** Reduce the operator-trust assumption toward operator-blind attribution; broaden from meme traders to teams, communities, and automation fleets; governance decisions on token utility taken transparently.

---

## 15. FAQ

**Is Chit a mixer?**
No. A mixer pools and re-routes funds to break a trail. Chit never moves your funds. It just makes the gas for your fleet come from a shared budget instead of from you, so the funding transaction never happens. Your trades stay fully public.

**Does Chit make me anonymous?**
No, and we won't claim it does. Your fleet wallets and their trades are public. What's not on the chain is the link between your main wallet and the fleet.

**Can Chit steal my funds?**
No. It's non-custodial, the fleet keys are generated in your browser and never leave it. Chit never holds your keys. You set spend limits, and you can stop or close a campaign and reclaim unused ETH at any time.

**Do I need $CHIT to use it?**
No. Anyone can create a fleet. Holding $CHIT above a small threshold gets you discounts and early access, and that balance check is read-only. You do **not** pay for gas in $CHIT, gas budgets are in ETH.

**What happens if I lose my backup?**
If you lose the encrypted backup file *and* your local browser data, the fleet cannot be recovered, not even by us. That's the trade-off for being genuinely non-custodial. Keep the backup safe.

**Is it live? Can I use it now?**
Not yet. It's built and hardened, and testnet deployment plus early access for holders are coming soon. Watch announcements.

**Who can see that I'm using Chit?**
The public can see the fleet wallets, their trades, and that a shared Chit paymaster sponsored them. The public cannot see that *you* are behind the fleet. Chit's operator can see the mapping in the current version, we disclose that openly.

**Is it audited?**
The contracts are hardened and tested against every issue our security review found, but a professional third-party audit is still pending. We won't call it "audited" until it is.

---

## 16. Glossary

- **Fleet**, the set of trading wallets a user runs under one campaign (5–50).
- **Campaign**, one funded, time-bounded fleet with its own budget and controls.
- **Paymaster**, the contract that pays gas on behalf of the fleet's wallets.
- **Session key**, a bounded permission that lets a wallet do exactly one approved action within set limits, and nothing else.
- **Recovery vault**, the encrypted backup of your fleet's keys, openable only by your wallet's signature.
- **Non-custodial**, you hold your keys; the service never can move your funds.
- **ERC-4337 / account abstraction**, the standard that makes smart-contract wallets and gas sponsorship possible.
- **The funding trail / edge**, the public transaction(s) that would otherwise link your main wallet to your fleet. The thing Chit removes.

---

## 17. Assets & links

- **CHIT contract:** `0xD523A627030509021cC39B6d7C8543417D3E50D8`
- **Repository:** https://github.com/ajanaku1/chit
- **Launch:** Pons V2 (ponsfamily.com)
- **Brand:** the "blind seam" mark, two halves that don't quite meet, for the public/private split. Palette: signal coral, warm paper, ink. (Assets in the repo `brand/` folder.)

*(Fill in as they go live: website, X/Twitter, Discord/Telegram, testnet app URL, live contract addresses, demo video.)*

---

## 18. Disclaimers

- Chit is experimental software. The product described here is testnet-stage and not yet deployed to a public network.
- Nothing in this document is financial advice, an offer, or a solicitation. $CHIT is a community token; do not present it as an investment or promise any financial return, price movement, buyback, or distribution.
- Privacy claims are strictly limited to those in [Section 6](#6-the-privacy-boundary--stated-honestly). Do not extend them.
- Contracts have not undergone a professional third-party audit. Do not describe the product as "audited" or "safe for real funds" until one is completed and published.
- Live metrics (holders, volume, graduation progress) change constantly, always pull them fresh; never publish stale numbers as current.

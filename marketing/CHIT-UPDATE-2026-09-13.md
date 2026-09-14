# Chit Progress Update #3: The pool is on chain and a pooled buy has landed

**For:** Community Manager. Source material for posts, threads, and replies.
**Version:** 3.0 · 13 Sep 2026
**Supersedes:** [CHIT-UPDATE-2026-09-07.md](CHIT-UPDATE-2026-09-07.md) v2.0 (7 Sep).
**Read first:** Part 4 below. It changes what we can and cannot say, and it unlocks the one claim we have been holding back since day one. The older [claims table in the main brief](CHIT-COMMUNITY-BRIEF.md#12-claims-discipline--what-we-can-and-cannot-say) is still correct on the token and on trades being public, but Part 4 here overrides it on privacy wording.

---

## The headline

Update #2 said the private funding pool was half built and told you not to attach a date to it. It is now deployed on Robinhood testnet, and a full journey has run through it on the live chain: a deposit in, a fleet funded from the pool, a buy executed by a fleet wallet, the unspent part credited back, and a withdrawal out. Every step has a transaction hash.

That is the stage where our headline sentence becomes true, and it is now the sentence on the front page:

> Your main wallet never funds your fleet. The chain shows a deposit into Chit and fleets funded by Chit, and no transaction links the two.

Read Part 4 before using it. It comes with a qualifier that is not optional.

---

## Part 1: What changed since 7 September

**The pool contract is deployed.** Address `0xce92096098ae1e397b167292edad8f3bdb8200c9` on Robinhood Chain testnet 46630. Deploy tx `0x9671b802…5e7afc`, deployed 8 Sep.

**A full pooled journey ran on the live chain, today.** Deposit of 0.05 ETH (`0x4986a9cc…1ef41e`), a five-wallet fleet created, a draw of 0.02 ETH funded to one of those wallets and a sponsored buy executed by it (`0xc37f0bdd…7c427ad`), 0.0015 ETH actually spent, the remaining 0.0185 ETH credited back to the trader's balance, then withdrawn out (`0x8fba5a00…c0dc1f99`). The main wallet sent money to the pool. It never sent money to any of the five fleet wallets.

**The last two pieces of the build closed.** Fleets drawing principal from a pooled balance, and the Control Room changes for pooled balances, were the two items Update #2 listed as still being built. Both are done and passing their checks. Everything in the Stage 2 task list is closed except the live hosted validation described in Part 3.

**The front page was rebuilt and is live at chit.tools.** New two-screen design, contract address and copy button in the masthead, and the claim above as the hero. The honesty lines came with it rather than being quietly dropped: trades are still stated as public, the second screen still says the operator can link a deposit to a fleet, and "Private, not anonymous" is still on the page. A test in the build fails if any of that wording regresses or if "anonymous", "untraceable" or an unqualified "no trail" ever appears.

**A production configuration bug was found and fixed.** One environment variable on the host held the wrong address, which meant the hosted service could not reach the pool at all from the day the pool shipped until today. Balance reads, the sweep, and the login challenge were all down in production for that window and the failure was silent. It is fixed and the sweep now answers correctly. This is worth knowing because it is why the hosted end-to-end run in Part 3 is still outstanding.

**Wallet connection was rebuilt.** On a browser with several wallets installed, only one can own the page's wallet slot, and the app was talking to whichever one won that race rather than the one the trader picked. It now discovers every installed wallet properly and asks which to use. Four smaller defects came out of the same work, including one where a deposit could have been sent on whatever network the wallet happened to be on. Deposits and exits now confirm the testnet first.

---

## Part 2: How it works, in one pass

Unchanged from Update #2, restated because you will need it constantly.

One deposit. Your main wallet sends ETH into a shared pool in fixed sizes, so the amount is not a fingerprint. Your balance lives in that pool. When you launch a fleet it draws from the balance, so your main wallet never sends money to a fleet wallet for any reason.

Three details carry the privacy:

- Nothing on chain names both sides. No function and no event in the pool contract mentions a depositor and a fleet in the same place, and a test scans the contract and fails the build if one ever does.
- The money moves late. Principal lands in a fleet wallet at the moment of the buy, not when the fleet is created.
- The timing is broken on purpose. Funding a fleet, and posting spend against a balance, each happen after a random delay of one to fifteen minutes.

Two doors out. Chit pays withdrawals from the operator wallet, and the contract has a self-serve exit the trader can take after 24 hours if Chit never pays. The second door is the one that matters.

Limits, since the pool means Chit briefly holds capital: 0.5 ETH per trader, 0.2 ETH per fleet draw, 5 ETH across the whole pool. Deposits are fixed at 0.01, 0.05 or 0.1 ETH. Small on purpose, and they stay small until an audit says otherwise.

---

## Part 3: What is built, and what is not

Built and proven, on testnet:

- The pool contract, deployed on 46630, with the fixed deposit sizes, the caps, and the operator pause.
- Deposits, balance, available headroom, withdrawals, and the 24 hour self-serve exit.
- Fleet creation, fleets drawing principal from a pooled balance, and the just-in-time buy that moves principal at the moment of the trade and rolls it back if the trade fails.
- Close a fleet and the unspent draw returns to the balance rather than to the trader's wallet.
- The Balance page, the wizard, and the Control Room.
- The check that no contract function or event names a depositor and a fleet together, and the copy check across the app, the site, and these documents.

Not done, and do not imply otherwise:

- **The hosted end-to-end run.** Today's journey ran against the live chain but through a local service, because production could not reach the pool until the configuration fix landed. Re-running it through chit.tools is the one open item on the Stage 2 list. Until it passes, the accurate line is "proven on the live chain", not "you can do this on the site".
- **The trading panel.** The plumbing under it is finished and the buy path works. What is missing is the panel a trader uses: paste a contract address, pick which fleet wallet buys, set the size, send. That is what is being built now, and it is the thing standing between private testing and letting people in.
- **Mobile.** The app is desktop only for now. Signing on a phone means leaving the browser for the wallet app and coming back, and that round trip is a second surface we are not opening while the first one is unproven. The session handling it needs is already fixed and tested, so this is a scope decision rather than a missing capability. Mobile comes after the pool is live. Do not describe the app as working on a phone, and do not describe mobile as abandoned.
- **No audit.** Still true, still needs saying on anything that could read as an invitation to deposit.
- **No mainnet, no real money.** Testnet 46630 and a test token only.

The app itself is in private testing. chit.tools is a public page that describes the product; it is not an open sign-up. When someone asks for access, the honest answer is that it is not open yet and the trading panel is what opens it.

---

## Part 4: Claims discipline, version 3

This is the part that changed. Read it twice.

**Now unlocked, because the pool is deployed and a pooled buy has landed:**

- "Your main wallet never funds your fleet. The chain shows a deposit into Chit and fleets funded by Chit, and no transaction links the two." Use the whole sentence. It is the claim the build was tested against.
- The private funding pool is live on testnet and a full journey has run on chain: deposit, fleet funded from the pool, buy, credit back, withdrawal.
- Deposits are fixed size, the caps are small on purpose, and there is a 24 hour exit written into the contract that does not need Chit.
- Principal moves at the moment of the trade, not before, and the timing is randomised.
- Point at the transaction hashes. Every one of them is in Part 1 and on the explorer.

**The qualifier that ships with the claim, every time:**

The operator can still link a deposit to a fleet. Chit knows. The pool hides the trader from the public chain, not from us, and that stays true until Stage 3. Amounts and timing can still be guessed at while the pool is small, because a small anonymity set is a small anonymity set no matter how the contract is written. Say this in the same post as the claim, not in a follow-up nobody reads.

**Still cannot say, at any stage:**

- Anonymous, untraceable, mixer, invisible, or anything in that family.
- "No trail" on its own, without the qualifier above.
- That trades are private. Trades, amounts, timing, and gas are all public and always will be.
- That Chit cannot see the mapping.
- Audited, safe, or anything that reads as an invitation to deposit real money.
- Any price, return, buyback, or distribution claim about $CHIT. Unchanged: $CHIT is discounts and early access, never a gate.

**Still cannot say yet, until the hosted run passes and the panel ships:**

- "Go and try it." The app is in private testing.
- "Live" without "on testnet" attached.

The line does not move: private, not anonymous. The pool makes the public-chain claim true. It does not make Chit blind. Say both, in that order, every time.

---

## Part 5: Draft copy for the announcement

Founder voice. Edit freely, keep the boundaries in Part 4.

Thread opener:

> Last update I said the funding pool was half built and refused to give a date. It is on chain now.
>
> Deposit in, fleet funded out of the pool, buy executed by a fleet wallet, change credited back, withdrawal out. All of it on testnet, all of it with hashes.

The claim:

> Your main wallet never funds your fleet. The chain shows a deposit into Chit and fleets funded by Chit, and no transaction links the two.
>
> That sentence is why we pulled this stage forward instead of polishing the gas-only version. It is now the sentence on the front page, and it is the one the build is tested against.

The qualifier, in the same thread:

> We can still see it. The pool hides you from the public chain, not from us. That changes at Stage 3 and not before.
>
> Trades are public. Amounts are public. The pool is small, so timing is guessable. Private, not anonymous. Same as always.

What is left:

> The plumbing is done. What is missing is the panel on top: paste a contract, pick a wallet, set the size, send.
>
> That is what I am building now, and it is what opens the door.

The bug, if you want the credibility play:

> Also: one environment variable on the host held the wrong address, and the production service could not reach the pool from the day it shipped until today. Silently. Nobody was using it, so nobody lost anything, but it was broken and I am not going to pretend otherwise.

---

## Part 6: Post bank for the daily cadence

You need three or four a day. These are angles, not finished posts. Each one is true today and does not need my sign-off, as long as you keep Part 4. Rotate the categories so it does not read as one long advertisement.

**The mechanism, one idea per post:**
1. Why gas sponsorship alone never hid the trail, and why principal was always the bigger link.
2. Fixed deposit sizes, and why an unusual amount is a fingerprint.
3. Just-in-time principal: nothing sits in a funded wallet waiting to be matched.
4. The random one-to-fifteen-minute delay, and what clock-matching looks like without it.
5. The contract scan that fails the build if any function or event names a depositor and a fleet together.
6. The 24 hour self-serve exit, and why an exit in a contract beats an exit in a promise.
7. The caps, and why 0.5 / 0.2 / 5 ETH is the right size for something unaudited.
8. Close a fleet and the change goes back to your balance, not to your wallet, because a refund to your wallet would redraw the line.
9. What an observer actually sees, walked through step by step.
10. What the operator sees, walked through with equal honesty.

**Evidence posts, with a hash:**
11. The deposit.
12. The pooled buy.
13. The withdrawal.
14. The pool deploy.
15. The first Stage 1 sponsored buy from 6 Sep, as the before-and-after.

**Build-in-public posts:**
16. The multi-wallet bug: four wallets installed, only one owns the slot, the app was talking to the wrong one.
17. The environment variable that broke production silently for five days.
18. Why the deposit path now checks the network first, and the mainnet accident that would otherwise have been possible.
19. The trading panel, as it comes together.
20. Why the app is desktop only for now, and what a wallet round trip actually costs a user.

**Position posts:**
21. Private, not anonymous, as a product decision rather than a legal hedge.
22. Why we published a limit we found in our own live contracts instead of shipping around it.
23. Why an audit gates real money and nothing else does.
24. Why $CHIT is discounts and early access and never a gate, and why gating a privacy product on a token balance is self-defeating.
25. The three stages, and what specifically has to be true for Stage 3.

**Ecosystem posts, for the Robinhood Chain angle:**
26. What a funding layer gives other builders on the chain.
27. Why we built on testnet 46630 first and what we are waiting on.
28. The primitive itself: an unkeyed pool is reusable well beyond trading fleets.

**Rules for all of them:** no dates on unshipped work, no price talk, the qualifier travels with the claim, and every "live" carries "on testnet".

---

## Part 7: Notes for you, not for the post

- The link to share is chit.tools. It is a description page, not a sign-up. If someone expects to be able to use it, that expectation is wrong and correcting it early is cheaper than correcting it later.
- Do not attach a date to the trading panel. Not "soon", not "this week". When it ships we announce it with the transaction, the way we announced the first buy.
- If anyone asks whether Chit holds their money: yes, briefly, and that is exactly why the caps are small, why the exit lives in the contract, and why an audit comes before mainnet. Do not let that question get answered by silence.
- Everything is testnet, test tokens, no real money, no audit. Any post that could read as an invitation to deposit needs that line on it.
- $CHIT's position has not changed with this update. If anyone reads the pool as a reason to expect price movement, that is not a claim we make.
- When you are unsure whether a sentence clears Part 4, downgrade it and ask. A privacy product survives an understated claim and does not survive an overstated one.

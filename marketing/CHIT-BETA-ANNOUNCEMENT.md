# The mainnet beta: what we publish, and the one paragraph every surface carries

Drafted 2026-09-22 for T083, T084 and T085 of `specs/003-mainnet-beta`
(FR-006, FR-008, FR-020, FR-042). Nothing here is posted until the beta
opens; the day is the founder's. The figures are the runbook's
(`docs/runbooks/mainnet-beta.md`, agreed 2026-09-16) and are stated in
`specs/003-mainnet-beta/spec.md` FR-001 and nowhere else in that spec. The
holders threshold is an environment value (FR-003) and is filled in on the
day, in CHIT, not as a dollar figure.

## The published promise, one paragraph, verbatim on every surface

This replaces every sentence that said a professional audit comes before
mainnet or before real funds. It carries FR-006's three facts in words no
weaker than the specification's, and FR-020's privacy claim in Stage 2's
words, unchanged (`specs/002-private-funding-pool/spec.md` FR-015), stated
together as FR-020 requires.

> Chit opens a capped beta on Robinhood Chain mainnet before the firm audit,
> not after it: holders only, the pool is capped at 1 ETH (0.1 ETH per
> depositor, 0.05 ETH per draw), a guardian can pause it, and the caps stay
> until a professional audit is complete. The contracts have not been
> audited by a firm. Chit's operator key can move what is in the pool, up to
> that cap. The privacy claim is unchanged: the main wallet never funds the
> fleet; the chain shows a deposit into Chit and fleets funded by Chit with
> no transaction linking them; the operator can link them; amounts and
> timing may be guessed at while the pool is small.

Where it goes (FR-008 names these; T083 is the one commit that carries them,
published before the beta opens, never in the change that opens it):

| Surface | The sentence to replace |
|---|---|
| `README.md` § Status | "A professional security audit is a gate before real funds, not part of this build." |
| `ONBOARDING.md`, Stage 2 paragraph | "…and a professional security audit as a hard gate before any real funds." |
| `ONBOARDING.md`, "Before mainnet" bullet | "Before mainnet: a professional security audit. Non-negotiable…" |
| `marketing/CHIT-COMMUNITY-BRIEF.md` § Not done yet | "…required before real money, not yet done." |
| `marketing/CHIT-COMMUNITY-BRIEF.md` § 9.5 Explicit limitation | "…warrant a professional third-party audit before mainnet." |
| `marketing/CHIT-COMMUNITY-BRIEF.md` § 9.6 roadmap | "Before mainnet: Professional third-party security audit…" |
| `marketing/CHIT-COMMUNITY-BRIEF.md` FAQ "Is it audited?" | "…a professional third-party audit is still pending." (keep; add the beta sentence) |
| `marketing/CHIT-UPDATE-AND-TOKEN.md` Stage 2 bullet | "…a security audit before any real money…" |
| `marketing/CHIT-UPDATE-AND-TOKEN.md` rules | "Don't call the product audited…" (keep; add: say the cap, the guardian and the operator key's reach in the same breath) |
| `specs/002-private-funding-pool/spec.md` FR-016 | "…MUST present a professional audit as a gate before real funds." (append: superseded by 003 FR-006/FR-008 on this point) |
| `landing/public/index.html` | Carries no audit claim today ("Live on Robinhood Chain testnet. Test ETH only, no real funds."); on the day it gains the beta note FR-006 requires on every page, which the app's `page-shared.ts` already owns (T056). |

T084's check, done 2026-09-22: the privacy wording above is Stage 2's FR-015
word for word; no surface listed strengthens it, and none uses "anonymous",
"untraceable" or "no trail" without the qualification. The community brief's
"de-anonymized" (§ 8, § 9.6) describes the attack on other people's fleets,
not a claim about Chit, and stays.

## Telegram, the group post on the day (FR-042: holders only, said as enforced)

Posted from the bot with a banner; lowercase, no dashes, no disclaimer
paragraph: the facts are the post.

> 🟢 **the capped beta is open on robinhood chain mainnet.**
>
> holders only: a wallet with at least `<THRESHOLD>` $CHIT gets in, below that the page shows what you hold, what it takes, where to buy and where the free playground is. no error screen, no waitlist.
>
> the numbers, enforced by the contract, not by us:
> · pool cap **1 ETH**, all of it
> · **0.1 ETH** per depositor, in fixed sizes: 0.01, 0.05, 0.1
> · **0.05 ETH** per draw to a fleet
> · a **guardian key** that is not the operator's can pause the pool; a paused pool still lets you exit
>
> what you are trusting, said plainly: the contracts have not been audited by a firm. chit's operator key can move what is in the pool, up to that cap. the operator can link your deposit to your fleet; the public chain cannot. the caps stay until the audit report.
>
> what stays true: your main wallet never funds the fleet. the chain shows a deposit into chit and fleets funded by chit, and no transaction linking them.
>
> `<APP LINK>` · the playground stays free at `<TESTNET LINK>`

## X, the thread on the day

1. the capped beta is open on robinhood chain mainnet. holders only, 1 ETH pool cap, a guardian on the brake, and we say what you are trusting before you deposit. 🧵

2. who gets in: a wallet holding at least `<THRESHOLD>` $CHIT. below that, the page shows what you hold and where to get it, and the free playground stays open to everyone.

3. the caps, enforced by the contract: 1 ETH for the whole pool, 0.1 ETH per depositor in fixed sizes, 0.05 ETH per draw to a fleet. a size that would breach a cap is not offered, and the pool refuses it if it arrives anyway.

4. the brake: a guardian key that is not the operator's can pause the pool. the pool also pauses itself on a charge past its deadline or an exit that would fail. paused, you can still leave with your deposit.

5. what you are trusting, in our words: the contracts have not been audited by a firm. chit's operator key can move what is in the pool, up to that cap. the operator can link a deposit to a fleet; the public chain cannot. the caps stay until the audit report.

6. what is private, exactly: your main wallet never funds the fleet. the chain shows a deposit into chit and fleets funded by chit with no transaction linking them. amounts and timing may be guessed at while the pool is small. private, not anonymous.

7. `<APP LINK>`. holders first. the numbers are the product.

## Not in either announcement, on purpose

No "audited", no "safe", no "anonymous", no "no trail", no date for the
audit's report, no dollar figure for the threshold, no promise the caps will
rise. FR-042 is met when the post says the same access condition the page
enforces on the day: the holders gate with that threshold, and nothing
narrower or wider.

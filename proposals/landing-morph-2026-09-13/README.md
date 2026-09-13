# Landing proposal: the morph (2026-09-13)

An implementation of [`landing-brief.md`](../../landing-brief.md) with the
reference design's borrowed credibility and third-party assets removed.

**This is a proposal. It is not wired into chit.tools and nothing live changed.**

## View it

```bash
cd proposals/landing-morph-2026-09-13
python3 -m http.server 8777
# open http://localhost:8777
```

Desktop is the design. Wheel down, arrow down, space, or click the cue to morph
to screen B; wheel up, arrow up, or Escape to come back. Below 768px the two
screens stack and the page scrolls instead.

## What the brief asked for, and what it got

The brief is a build spec for a two-screen landing that never scrolls on
desktop: a hero whose right-hand column is a video panel, which on a gesture
un-clips to become the full stage behind three glass metric cards. That
mechanism is implemented as specified. The artboard-unit system, the clip-path
morph, the load-reveal ramp, the first-show entrance, the LED dot type, and the
card geometry all follow the brief's numbers.

What did not survive is the brief's *content*, because it was another company's.

### Removed: borrowed credibility

The reference design is for "Meridial", a wealth-advisory product. Its copy
claimed **"Managing $4.2B+ in tracked assets"** and its hero strip was labelled
**"Trusted by wealth advisors at"** above the logos of **Intel, Google, Sony,
Amazon and Adobe**. On a chit page that strip would assert five commercial
relationships that do not exist, and the figure would be false.

The strip is now labelled **"Runs on"** and carries text wordmarks for the
actual technical dependencies: ERC-4337 EntryPoint v0.7, the Uniswap v4
Universal Router, Robinhood Chain testnet 46630, viem, and Vercel. Underneath it
carries the same non-affiliation line the live landing already uses.

Every other string was rewritten to something true today:

| Brief (Meridial) | Here (Chit) |
|---|---|
| "Managing $4.2B+ in tracked assets" | "Stage 1 live on testnet 46630" |
| "Clarity, across every portfolio you manage" | "A private line for a public fleet" |
| "Real-time drift detection" | "Deposits carry no campaign key" |
| "Built for Intelligent Performance" | "Bounded by contract, not by promise" |
| "118 ms · 2.4 M · 16 K" | "15 min · 0.2 ETH · 24 h" |

The three numbers on screen B are the pool contract's own constants: the
maximum funding delay, the per-campaign draw cap, and the self-serve exit
delay. They are checkable against `contracts/fleet/FleetPool.sol`.

The privacy wording is the Stage 1 claim, not the Stage 2 one, because Stage 2
is not live: the hero says the operator pays your fleet's gas and that only the
funding relationship is withheld. "Private, not anonymous" appears in its
denied form, as the claims gate requires.

### Removed: hardcoded CloudFront URLs

The brief pinned one background video, three card videos and five logo PNGs to
two CloudFront distributions under someone else's user path. All are gone.

- **Background video** is now a CSS ambient field: layered radial gradients
  with a slow drift, greyscaled, under the same clip-path morph. It plays the
  same structural role (one element, shared by both screens, its clip is the
  morph's spine) without an external asset.
- **Card videos** are dropped entirely. They sat at `z-index:0` beneath the
  gradient stack, the grain layer and the SVG art, all of which are kept, so
  the cards still read as intended.
- **Logos** became text, as above.

The only external request left is Google Fonts, which the brief specifies and
which carries no borrowed-credibility problem.

## Deviations from the brief, in full

1. **Palette is the brief's, not chit's.** The metric cards are magenta,
   purple and orange per the brief's exact gradient stacks. Chit's brand truth
   is cream with `#FF5A3C`. These clash. I kept the brief faithfully because
   re-tuning a palette is a brand decision, not an implementation one. **This
   is the main thing to decide before this goes anywhere near production.**
2. **Brand mark** is a gradient-filled mark in the brief's 29×24 slot, shaped
   after chit's seam logo. It is not `brand/logo.svg`, which is a solid orange
   rounded square and does not take the white-to-grey gradient treatment.
3. **Marquee shift.** The brief hardcodes `--marquee-shift:-644.104u`, measured
   from its five logo PNGs. Text wordmarks are not those widths, so the track
   is duplicated and animates to `-50%`, which is width-independent.
4. **Glyph table** gained `c` and `o`. The brief's table covers its own copy
   ("Intelligent") and ours needs "contract". Construction is identical: 7 rows,
   5 columns, same lowercase baseline as `a`/`e`/`n`.
5. **Four files, not three.** The brief demands exactly `index.html`,
   `css/style.css`, `js/main.js`. This README is the fourth, because a proposal
   directory with no explanation of what it is would be worse.

## Acceptance checklist

The brief's section 12, answered honestly. **No browser automation is installed
in this repo, and adding one is a dependency decision that is not mine to make,
so nothing below marked "needs a human" has been seen rendered.**

| Check | Status |
|---|---|
| Desktop 1606×1161 pixel-aligned; nothing scrolls at any desktop size | needs a human |
| The video never restarts at the morph | n/a, there is no video; the CSS field is one element and only its clip changes |
| The masthead does not move across the morph | structurally guaranteed: it is outside both screens and has no morph transition |
| Wheel, keyboard and cue all work; triggers ignored mid-morph | implemented with a `morphing` latch and a 250ms cooldown; needs a human to confirm feel |
| Cards are 429/554 and inner elements scale with `--cu` | implemented; needs a human |
| The three numbers and the headline word are LED dots, not text | verified: all four strings resolve against the glyph table |
| Reduced motion: no entrances, instant swap, still readable | implemented; needs a human |
| Mobile 390px stacks and scrolls, no horizontal overflow | needs a human |
| Not one word of copy differs from the brief | **deliberately false.** Every string changed, for the reasons above |

Automated checks that did run: JS parses, HTML tags balance, CSS braces balance
(250 rules, 821 declarations), no CloudFront or third-party brand references
remain, and the only external hosts are the two Google Fonts domains.

## If this gets promoted

It is not a drop-in replacement for `landing/public/`. That directory has its
own test (`landing/test/landing.test.mjs`) which asserts the FR-015 claim copy
and forbids the overclaim vocabulary. This page would need to be run against
that gate, and the palette question settled, before it could ship.

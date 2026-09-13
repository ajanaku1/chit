# Landing proposal: the morph (2026-09-13)

An implementation of `landing-brief.md` with the reference design's borrowed
credibility and third-party assets removed.

> The brief itself is not in this repository. It is a third-party document that
> carries another company's brand and pins assets to someone else's CDN, so it
> stays local to the founder's machine. Everything it specified that matters to
> this build is restated below.

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

- **Background video** is now a CSS ambient field: layered radial gradients on
  a paper-to-ink ramp, desaturated and slowly drifting, under the same clip-path
  morph. It plays the same structural role (one element, shared by both screens,
  its clip is the morph's spine) without an external asset.
- **Card videos** are dropped entirely. They sat at `z-index:0` beneath the
  gradient stack, the grain layer and the SVG art, all of which are kept, so
  the cards still read as intended.
- **Logos** became text, as above.

The only external request left is Google Fonts, which the brief specifies and
which carries no borrowed-credibility problem.

## Deviations from the brief, in full

1. **Palette is chit's, not the brief's.** Every colour now comes from
   `brand/BRAND-TRUTH.md`: signal coral `#FF5A3C`, paper `#F5EFE5`, soft paper
   `#DED6CA`, ink `#171513`, muted ink `#6F6860`. This is the ink surface, which
   the brand truth explicitly supports ("works on paper and ink surfaces"), so
   paper carries the type and coral is the single accent.

   The brief's three cards were three different hues (magenta, lavender,
   orange). Brand truth says **one accent hue**, so all three are now coral at
   different depths: ember for the delay card, sand-to-coral for the draw cap,
   full coral for the exit card. The layer *structure* of each gradient stack
   is unchanged, so the light behaves as the brief designed it.

   Audited: 52 hex and 59 rgb() literals, zero saturated colours outside the
   coral/paper hue band.

2. **Resolved: the visual language may change; the branding and palette may not.**
   Decided 2026-09-13. The brief's gradient-and-glow treatment is accepted as a
   direction for the page, so nothing here is held back on that account.

   I had also read `BRAND-TRUTH.md`'s constraint list as governing the whole
   site, and flagged a conflict that did not exist. Re-reading it, that list is
   scoped to the **mark**: "Favicon-first vector mark; readable at 16px; one
   accent hue; works on paper and ink surfaces; no letters, coins, ... gradients,
   glow, or generic crypto imagery." Those are rules for the logo, not the page.
   The page was never in conflict. The masthead mark was, because I had drawn a
   gradient-filled stand-in.

3. **Brand mark is now chit's own.** `brand/logo.svg` inlined verbatim: the
   coral seam mark on ink, flat, no gradient, in a 26u square. It replaces the
   gradient approximation, which broke the one constraint that genuinely applied.

   Signal coral now also appears on screen A, where it previously did not show
   at all: the live-status pill and its dot, the reached steps on the funding
   timeline, and the balance delta. One accent hue, used where something is
   actually live or has actually happened.

4. **Marquee shift.** The brief hardcodes `--marquee-shift:-644.104u`, measured
   from its five logo PNGs. Text wordmarks are not those widths, so the track
   is duplicated and animates to `-50%`, which is width-independent.
5. **Glyph table** gained `c` and `o`. The brief's table covers its own copy
   ("Intelligent") and ours needs "contract". Construction is identical: 7 rows,
   5 columns, same lowercase baseline as `a`/`e`/`n`.
6. **More than three files.** The brief demands exactly `index.html`,
   `css/style.css`, `js/main.js`. Those three are the page. Alongside them sit
   this README, `shots.mjs` (the Playwright capture used to verify the
   acceptance checklist) and `evidence/`. A proposal with no explanation and no
   evidence would be worse than one that breaks the file count.
7. **Metric transforms and pill width** were retuned; the brief's values were
   measured against its own copy. See "Defects the capture found" below.

## Acceptance checklist

The brief's section 12, verified with Playwright against a real Chromium at six
viewports. Screenshots are in `evidence/`; regenerate them with:

```bash
python3 -m http.server 8777 &
node shots.mjs "$PWD/evidence"
```

| Check | Status |
|---|---|
| Nothing scrolls horizontally at any desktop size | **pass** — 0px overflow at 1606×1161, 1440×900, 1024×1180 |
| The background never restarts at the morph | **pass by construction** — one element, only its clip transitions |
| The masthead does not move across the morph | **pass** — identical position in the A and B captures |
| Wheel, keyboard and cue trigger the morph; ignored mid-morph | **pass** — a wheel event moves `data-screen` to `metrics`; latch plus 250ms cooldown implemented |
| Cards are 429/554 and inner elements scale with `--cu` | **pass** — cards hold ratio at every captured width |
| The three numbers and the headline word are LED dots, not text | **pass** — all four `[data-dots]` hosts contain a rendered `svg.dot-svg` |
| Reduced motion: no entrances, instant swap, still readable | **pass** — captured under `reducedMotion: reduce`, page fully legible |
| Mobile 390px stacks and scrolls, no horizontal overflow | **pass** — 0px overflow (was 5px; see below) |
| No console errors at any viewport | **pass** — none across all six |
| Not one word of copy differs from the brief | **deliberately false.** Every string changed, for the reasons above |

### Defects the capture found, and fixed

Four things were wrong that static checking could not see. All were caused by
the brief's numbers being tuned for its own copy, not ours.

1. **5px horizontal overflow at 390px.** `.panel__title` is `white-space:nowrap`
   in the brief; "Deposits carry no campaign key" is wider than a 390px
   viewport. It now wraps on mobile only.
2. **The metric numbers collided with their units.** The brief's per-card
   `translate`/`scale` on `.dot-svg` were tuned for "118" and "2.4"; with "15"
   and "0.2" the shifted dots ran into "min" and "ETH". The transforms are
   removed and `.metric` carries a `10cu` gap instead.
3. **The hero pill wrapped onto two lines and overlapped its note.** 152u fit
   the brief's "Rebalance needed"; "Caps enforced on chain" is six characters
   longer. Widened to 176u and pinned to one line.
4. **The shared field was washing out to grey.** `saturate(.35)` removed most of
   the paper warmth. Raised to `.62`.

One judgment call left as-is: coral appears on screen B but not on screen A,
where the field is paper-to-ink and the accent never shows. That reads as
deliberate restraint rather than a defect, but it is worth an opinion.

## If this gets promoted

It is not a drop-in replacement for `landing/public/`. That directory has its
own test (`landing/test/landing.test.mjs`) which asserts the FR-015 claim copy
and forbids the overclaim vocabulary. This page would need to be run against
that gate before it could ship.

The direction question is settled: the visual language may change, the branding
and palette stay. What remains is a straight product decision about whether this
replaces the current landing, and a copy pass once Stage 2 is live, since the
hero currently states the Stage 1 claim rather than the FR-015 one.

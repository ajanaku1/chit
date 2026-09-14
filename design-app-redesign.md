# Chit app redesign, step 1: the landing's look, tuned for an app (approved design)

Approved in dialogue on 2026-09-14. Covers the app pages only: Set up
(`app/fleet.html`), Control Room (`app/fleet-dashboard.html`), Balance
(`app/balance.html`) and Boundary (`app/fleet-privacy.html`). The landing at
chit.tools is the reference and is not changed. The journeys, screens and
states in `design.md` and `design-stage2.md` are unchanged; only the visual
language and component layer change. This supersedes the fleet pages'
current "Soft Receipt" styles (the header of `app/fleet.css`) and the earlier
"Public Docket" direction recorded at the top of `IMPLEMENTATION.md`. That
follows the founder's direction that the visual language may change while the
branding and palette stay.

## Why

The landing was rebuilt on 2026-09-13 as the two-screen morph: ink surfaces,
frosted glass cards, coral gradients, LED dot numerals and pill tags. The app
still wears the older card-and-coral look, so moving from chit.tools into the
app feels like two products.

## The three steps

1. **This spec.** The foundation and a restyle of all four pages: no new data
   and no new dependency.
2. **Live funding timeline, activity feed and transaction toasts.** Gets its
   own spec.
3. **One three.js scene of the pool.** Gets its own spec, and is gated on a
   dependency proposal recorded in `loop/memory/STATE.md` with measured size
   and approved before install.

A trading panel comes later as its own full-width page under the same top
bar, with its own spec. `design.md` excludes charts, P&L and selling from the
Stage 1 MVP, so that spec must revisit those exclusions explicitly.

## Settled decisions

1. Match the landing's look, tuned for an app. Glass and gradients go on the
   figures that matter; forms and lists sit on calm solid surfaces.
2. Dark-only, like the landing. The app's light theme and its toggle are
   removed.
3. Landing-style top bar and a centred column.
4. The nav reads **Balance · Set up · Control Room · Boundary**, matching the
   landing's own labels. **Activity** joins in step 2.
5. Page URLs, the ids the tests pin, and every claims test stay as they are.

## Visual system

- **Colour tokens, copied from `landing/public/style.css`:** `--coral #FF5A3C`,
  `--coral-lift #FF7A5C`, `--coral-deep #7A2415`, `--paper #F5EFE5`,
  `--soft-paper #DED6CA`, `--ink #171513`, `--muted-ink #6F6860`,
  `--surface-top #0D0C0B`, `--surface-bottom #171513`,
  `--text-muted rgba(245,239,229,.62)`, `--glass-line rgba(245,239,229,.36)`.
- **Coral means live or happened:** live dots, reached steps, and the
  balance change. That is the landing's "one accent hue doing one job" rule.
  Primary actions are paper buttons with ink text, like the landing's
  `.btn--solid`. Nothing decorative uses coral.
- **States:**
  - Confirmed states use coral and pending states use `--text-muted`.
  - Errors (cap reached, balance short, pool paused, service unreachable) get
    a `--coral-deep` panel with paper text and a written label, so an error
    never reads as "live".
  - Today's mint success tokens are removed.
- **Type:** the landing's system stacks (`--font-sans`, `--font-metric`,
  `--font-chip`) and tracking tokens. Nothing is loaded from third parties.
- **Surfaces:** glass (the landing's `.card-glass` recipe) for key figures and
  status; warm coral gradient for the three limits; solid ink for forms, wizard
  steps and lists.
- **Units:** sizing uses rem and container queries, not the landing's artboard
  units, because app screens are content-driven.

## Shell and navigation

- **Top bar:** the same masthead as the landing: the flat coral mark from
  `brand/logo.svg`, the contract-address row with Copy, the nav, and the wallet
  button (`#hdr-wallet`) styled as the landing's pill button. The wallet
  chooser from PR #1 becomes a glass dialog.
- **Status pill:** sits under the bar and reflects the pool's real state:
  live, or "Pool paused" when the operator has paused it. It never asserts
  "live" without having read it.
  - **Source:** the `pool.paused` field of the balance response
    (`src/fleet/pool-buy.ts`), taken from the shared cached `readBalance`
    (`app/src/fleet/balance-read.ts`). That means no new request and no extra
    signature.
  - **Hidden** when no balance read exists yet, for example before connecting
    or on the Boundary page.
  - **Lag:** it can trail an operator pause by up to the balance cache window
    (10 minutes). Any action the pool refuses while paused still shows its
    specific pool-paused error.
- **Phones:** the landing's menu button and nav sheet. Connect stays visible.
- **Footer:** the landing's non-affiliation line on every app page.

## Components

Each has one job and is shared by every page:

- **Cards:** `card-glass`, `card-warm` and `card-solid`.
- **LED figure** (`app/src/fleet/led.ts`): renders a value in the landing's
  7-row dot glyphs as SVG. The SVG is `aria-hidden`. The value sits beside it
  as real text in a visually hidden span, which screen readers read once and a
  copy of the figure picks up.
- **Pill tags:** the status pill, plus a chip for each campaign state (Draft,
  Awaiting backup confirmation, Ready to activate, Funding your fleet, Active,
  Paused, Depleted, Expired, Revoked, Closed). Only live states carry the coral
  dot.
- **Buttons:** solid (`.primary`, paper with ink text like the landing's
  `.btn--solid`) and ghost. A disabled button keeps its reason text.
- **Meters and gauge:** headroom meters against the 0.5 ETH balance cap and the
  0.2 ETH draw cap (restyled `.budget-meter`), and an arc gauge for the 1–15
  minute funding countdown.
- **Step rail:** the wizard's steps as a numbered rail like the landing's 01–05
  line, with coral on reached steps.
- **Fields:** amount and destination on solid cards, large mono text, inline
  validation.
- **Tiles and pickers:** summary tiles (`.summary`, `.summary.grid`) and the
  size picker (`.quickpick`), restyled with their classes kept.
- **Banners:** kept and restyled in the three tones above until step 2's toasts
  replace them.
- **Dialog:** glass, for the wallet chooser and for confirmations.
- **Loading placeholders:** shimmer blocks where pages now say "Loading…".

**CSS organisation:** `app/fleet.css` stays the single stylesheet every page
links. It imports three layered files (`tokens.css`, `components.css`, `pages.css`;
sources in `app/src/styles/`, served as `styles/`), declared with
`@layer tokens, components, pages`.
- **Build:** `app/build.mjs` copies static files from an explicit list, so it
  gains a `styles/` directory and three copy lines.
- **Migration:** while pages move over, today's rules sit in a lowest-priority
  `legacy` layer. Each task deletes the legacy rules it replaces, and the
  layer is gone when step 1 ends.

## Motion

- **Easing:** `--ease-out cubic-bezier(0.23, 1, 0.32, 1)` and
  `--ease-in-out cubic-bezier(0.77, 0, 0.175, 1)`, as on the landing. Interface
  changes take 150–400 ms and entry reveals 600–1000 ms.
- **Entry:** a once-only staggered reveal as sections enter the viewport
  (IntersectionObserver, then unobserve).
- **State changes:**
  - LED figures count to a new value, and the coral delta fades in.
  - Meters fill to their new level.
  - Wizard steps slide forward and back, and the rail's coral line extends.
  - Live dots pulse slowly.
  - The funding gauge advances in real time.
  - Dialogs fade and rise over a blurred backdrop.
  - Buttons press in slightly. Hover effects apply only under
    `(hover: hover) and (pointer: fine)`.
- **Banned, as on the landing:** `transition: all`, `scale(0)`, `ease-in`,
  and `scroll-behavior: smooth`. Only transform, opacity, clip-path and filter
  animate.
- **Reduced motion:** every animated piece has a still version. Values appear
  without counting, meters jump to level, and nothing pulses or shimmers.
- **Text:** motion is never the only signal. Every state change also changes
  text.
- **Helpers:** shared in `app/src/fleet/motion.ts`: the reveal observer, a
  count-up, and one reduced-motion check.

## Pages

- **Balance:**
  - **Hero:** a glass tile with the balance as an LED figure, the coral delta,
    headroom against 0.5 ETH, and the wallet's own ETH (`#wallet-eth`).
  - **Deposit:** fixed sizes as segmented pills (`#deposit-sizes`). A size
    that would breach a cap stays disabled with its reason.
  - **Withdraw:** a solid card (`#withdraw-form`) with the "paying to your main
    wallet recreates the link" warning made prominent.
  - **Exit:** a warm card (`#exit-card`) showing the 24-hour delay, posted
    spend, and the exact contract call.
  - The slot that step 3's pool scene will fill shows the three warm limit
    cards until then.
- **Set up:**
  - One question per screen on the step rail.
  - Connect uses the glass wallet chooser.
  - Backup gives the vault download the weight of a "don't skip this" step.
  - Launch shows a draw meter against 0.2 ETH beside the draw amount
    (`#a-draw`), then "Funding your fleet" on the gauge (`#funding-wait`).
- **Control Room:**
  - The balance strip (`#balance-strip`) becomes glass tiles.
  - Each fleet shows its state chip, draw/spent/remaining as LED figures with a
    meter, its accounts, and its actions.
  - Revoke (terminal) and Close confirm in a dialog.
  - With no fleet, an empty state points to Set up.
- **Boundary:** the landing's editorial section style. The FR-015 claim and
  every sentence the claims tests check are unchanged.

## What does not change

- **Tests:** every existing test stays green without edits. Editing a test is a
  stop-and-ask.
- **URLs and ids:**
  - All four page URLs.
  - `#hdr-wallet` and a Balance link on every page.
  - `#deposit-sizes`, `#deposit-submit`, `#withdraw-form`,
    `#withdraw-destination`, `#withdraw-submit`, `#exit-card`,
    `#balance-available`, `#wallet-eth`, `#balance-refresh`, `#balance-strip`,
    `#a-draw` and `#funding-wait`.
  - The launch step's link to the Balance page.
- **Claims:** the FR-015 claim and the banned words ("anonymous" only in its
  denied form, no "untraceable", no unqualified "no trail").
- **Wallet logic:** all behaviour from PR #1 is unchanged. Only its dialog is
  restyled.

## Testing

All test-first, with red→green order visible in the commits.

- **Ported from the landing, run against the app:**
  - the easing tokens and the reduced-motion media query are present
  - the hover guard is present
  - the banned motion patterns are absent
  - no third-party assets on any app page
  - WCAG contrast on the ink surface: body text and coral accent against
    `--surface-bottom`, at the same minimums the landing uses
  - every link on every app page reaches a page or element that exists
- **New:**
  - `led.ts` keeps the real value as text for any input it renders
  - the status pill is hidden when the pool state is unknown
  - the theme toggle is gone from every page
- **Visual check:** Playwright (already an approved dev dependency) renders
  every page at 1606×1161, 1440×900, 1024×1180, 390×844 and 320×640, plus
  1440×900 with reduced motion. Each render asserts no horizontal overflow and
  no console errors, and screenshots are kept as evidence, as with the landing.
- **Gates:** the `fleet-*` and `pool-*` gates in `verify.sh` stay green.

## Delivery

- **Commits:** at most 200 changed lines each, failing test first, on a branch
  with a PR. Rebase often, because `main` moves constantly.
- **Order:**
  1. tokens and the layered CSS
  2. shell and nav on all pages
  3. components and `led.ts` / `motion.ts`
  4. Balance
  5. Set up
  6. Control Room
  7. Boundary
  8. the Playwright visual check
- **Log:** an `IMPLEMENTATION.md` entry records the direction change.

## Out of scope for step 1

- New data sources (the activity feed and funding timeline are step 2).
- three.js and any other new dependency (step 3).
- The trading panel.
- Any change to the landing.

## Recorded for later steps

- **Step 2 privacy:** the activity feed must not create a new link between a
  deposit and a fleet. Its data comes from Chit's own signed API (the operator
  already holds that mapping) and from transactions the app itself sent. Never
  query a public or wallet RPC for both a depositor's deposits and a campaign's
  funding in one session, because that RPC then sees the two joined by the
  visitor's IP.
- **Step 3 performance:** the pool scene loads only where it is shown, pauses
  off-screen, is driven by real state (balance level, a draw's funding
  countdown), and shows a still image under reduced motion. Its dependency
  proposal lists the measured bundle size before anything is installed.

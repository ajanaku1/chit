# Chit App Redesign, Step 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the four Chit app pages to match the landing's look: ink surfaces, glass cards, LED numerals, pill tags and the landing's motion rules, adapted for an app. No new data and no new dependency.

**Architecture:**
- `app/fleet.css` becomes a manifest. It imports `styles/tokens.css`, `styles/components.css` and `styles/pages.css` as cascade layers above a lowest-priority `legacy` layer that holds today's rules.
- Each task adds rules to the new layers and deletes the legacy rules it replaces. Pages stay styled throughout, and every commit stays small.
- Two small shared modules, `led.ts` and `motion.ts`, plus a few pure view functions, drive the new figures.
- Design contracts are pinned by source-shape tests and pure-function tests.

**Tech Stack:** Static HTML, CSS cascade layers, TypeScript bundled by esbuild (`app/build.mjs`), `node --test` via tsx, and Playwright (already a root devDependency) for the visual check.

**Spec:** `design-app-redesign.md` (repo root). Read it before starting any task.

## Global Constraints

**Repo rules**
- Test-first. Commit each failing test on its own before the implementation that makes it pass, so the red→green order shows in the history.
- At most 200 changed lines per commit. Check with `git diff --cached --shortstat` before every commit, and split the commit if it is over.
- Never edit or delete an existing test. Only the new `app/test/app-*.test.ts` files that this plan creates may change. Never weaken a `verify.sh` predicate.
- No new dependencies. Playwright is already approved as a root devDependency. three.js is step 3 and is out of scope.
- No `Co-Authored-By`, `Claude-Session` or other Claude attribution lines in commit messages.

**Branch**
- Work on branch `feat/app-redesign`.
- Before each task, run `git fetch origin`. If `origin/main` moved, stash, run `git rebase origin/main`, then pop the stash.
- Never push and never open a PR without the user's explicit go.

**Markup the tests pin — keep these exactly**
- The four page URLs: `app/fleet.html`, `app/fleet-dashboard.html`, `app/balance.html`, `app/fleet-privacy.html`.
- `#hdr-wallet` on every page, and a `href="./balance.html"` link on every page.
- The ids `#deposit-sizes`, `#deposit-submit`, `#withdraw-form`, `#withdraw-destination`, `#withdraw-submit`, `#exit-card`, `#balance-available`, `#wallet-eth`, `#balance-refresh`, `#balance-strip`, `#a-draw`, `#funding-wait`, `#pool-claim`, and `data-wstep="launch"` with a Balance link inside it.
- These exact forms, which existing tests match by regex:
  - `id="deposit-sizes" class="quickpick"` (no extra classes)
  - `id="withdraw-submit" type="submit" class="primary"` (class exactly `primary`)
  - `id="deposit-submit" type="button" class="primary big" disabled`
  - `<dl class="summary grid">` whose first child is literally `<div><dt>Available`
  - `id="balance-strip"`, followed later on the page by `<dl class="summary`

**Claims**
- Never write "untraceable", "unlinkab…" or "no trail".
- "anonymous", "hidden trade" and "mainnet" may only appear on a line that also has a denial word (not, never, no, without, cannot…). The claims test checks line by line, so keep existing multi-line claim paragraphs exactly as they are.

**Look**
- No third-party assets: nothing loaded from `http(s)://`.
- Dark only.
- Coral (`var(--coral)`, `var(--coral-lift)`) is used only for things that are live or have happened. Primary buttons are paper with ink text. Errors use `--coral-deep` panels.

**Motion**
- Easing: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` and `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`.
- Never use `transition: all`, `scale(0)`, `ease-in`, or `scroll-behavior: smooth`.
- Every animation has a reduced-motion still version.
- Hover effects go only inside `@media (hover: hover) and (pointer: fine)`.

**Commands**
- App suite (typecheck, tests, build): `npm --prefix app run verify`.
- Just the new tests: `cd app && node --import tsx --test test/app-*.test.ts`.
- Gates: `./verify.sh fleet-acceptance`, `./verify.sh fleet-buy`, `./verify.sh pool-balance`, `./verify.sh pool-fund`.
- Local look: `npm run dev:local`, then open http://localhost:3000/app/balance.html. Restart the server after rebuilding, because it assembles `public/` at startup.

---

## File Structure

| Path | Responsibility |
|---|---|
| `app/fleet.css` (modify) | Layer manifest (`@layer … ; @import …`), plus the shrinking `@layer legacy { … }` block. The legacy block is gone in Task 14. |
| `app/styles/tokens.css` (create) | The landing's palette, type stacks, radii, easing and durations. `color-scheme: dark`. |
| `app/styles/components.css` (create) | Shared components: base, shell, type, buttons, fields, surfaces, tiles, banners, chips, meters, dialogs, LED, motion. |
| `app/styles/pages.css` (create) | Page-specific rules for Balance, the wizard, Control Room and Boundary. |
| `app/build.mjs` (modify) | Copy `styles/*.css` into the build output. |
| `app/src/fleet/led.ts` (create) | LED dot glyphs: `canLed`, `ledDots`, `renderLed`, `hydrateLed`. |
| `app/src/fleet/motion.ts` (create) | `prefersReducedMotion`, `easeOut`, `countTo`, `revealOnEnter`. |
| `app/src/fleet/page-shared.ts` (modify) | Remove the theme toggle. Add `initShell`, `initMenu`, `initContractCopy`, `initPoolStatus`, `confirmDialog`. |
| `app/src/fleet/balance.ts` (modify) | Add `poolStatus`, `TRADER_CAP`, `capShare`, `balanceDelta`, `drawShare`, `fundingProgress`. |
| `app/src/fleet/balance-read.ts` (modify) | Dispatch `chit-balance-read` after a live read. |
| `app/src/fleet/control-room.ts` (modify) | Add `confirmationFor` and `isLiveState`. |
| `app/src/balance-page.ts`, `fleet-page.ts`, `fleet-dashboard.ts`, `fleet-privacy.ts` (modify) | Call `initShell`, and wire the LED, meters, gauge and confirm dialog. |
| four `app/*.html` pages (modify) | Masthead, pill, footer line, and per-page markup. |
| `app/test/app-look.test.ts`, `app-figures.test.ts`, `app-led.test.ts`, `app-motion.test.ts` (create) | Design contracts and pure-function behaviour. |
| `scripts/app-shots.mjs` (create), `app/evidence/*.png` | Playwright render check and kept screenshots. |
| `IMPLEMENTATION.md` (modify) | Log entry for step 1. |

---

### Task 0: Commit the approved spec and the landing link fix

The working tree already holds three uncommitted changes from the design session: `design-app-redesign.md`, `landing/test/landing.test.mjs` (a new "every link lands somewhere" test), and `landing/public/index.html` (where "Read the boundary" now goes to `/app/fleet-privacy.html`).

**Files:**
- Commit: `landing/test/landing.test.mjs`, `landing/public/index.html`, `design-app-redesign.md`

- [ ] **Step 1: Commit the landing test on its own (red at this commit, because the committed `index.html` still links to `#boundary`)**

```bash
git add landing/test/landing.test.mjs
git commit -m "test(landing): every link lands somewhere; Read the boundary opens What's private"
```

- [ ] **Step 2: Confirm the working-tree fix makes it pass**

Run: `cd landing && npm run verify`
Expected: `# pass 10`, `# fail 0`

- [ ] **Step 3: Commit the fix, then the spec**

```bash
git add landing/public/index.html
git commit -m "fix(landing): point Read the boundary at the What's private page"
git add design-app-redesign.md
git commit -m "docs: approved design for the app redesign, step 1"
```

---

### Task 1: Layer manifest, tokens, dark base, build copies

**Files:**
- Create: `app/styles/tokens.css`, `app/styles/components.css`, `app/styles/pages.css`, `app/test/app-look.test.ts`
- Modify: `app/fleet.css` (lines 1–2 and the end of the file), `app/build.mjs` (the mkdir and the copy list)

**Interfaces:**
- Produces:
  - CSS custom properties: `--coral --coral-lift --coral-deep --paper --soft-paper --ink --muted-ink --surface-top --surface-bottom --text-muted --glass-line --glass-fill --hairline --font-sans --font-metric --font-mono --track-tight --track-snug --track-narrow --track-wide --radius-card --radius-control --radius-pill --ease-out --ease-in-out --dur-ui --dur-reveal`
  - Layers, lowest to highest: `legacy`, `tokens`, `components`, `pages`
  - Test helpers inside `app-look.test.ts` (`read`, `cssColor`, `contrast`, `rules`, `PAGES`, `NEW_STYLES`) that later tasks append tests to

- [ ] **Step 1: Write the failing tests** (create `app/test/app-look.test.ts`)

```ts
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Design contracts for the app redesign (design-app-redesign.md). The look is
 * judged on screen; these pin the rules a restyle could quietly break.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(appRoot);
const read = (path: string): Promise<string> => readFile(join(appRoot, path), "utf8");

const PAGES = ["fleet.html", "fleet-dashboard.html", "balance.html", "fleet-privacy.html"] as const;
const NEW_STYLES = ["styles/tokens.css", "styles/components.css", "styles/pages.css"] as const;

const cssColor = (css: string, name: string): string => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  assert.ok(match, `${name} is not a six-digit colour token`);
  return match[1]!.toLowerCase();
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Innermost `selector { body }` pairs, comments stripped; nested @media rules included. */
const rules = (css: string): Array<[string, string]> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);

test("the app's palette is the landing's, token for token", async () => {
  const [landing, tokens] = await Promise.all([
    readFile(join(repoRoot, "landing/public/style.css"), "utf8"),
    read("styles/tokens.css"),
  ]);
  for (const name of ["--coral", "--coral-lift", "--coral-deep", "--paper", "--soft-paper", "--ink", "--muted-ink", "--surface-top", "--surface-bottom"]) {
    assert.equal(cssColor(tokens, name), cssColor(landing, name), `${name} drifted from the landing`);
  }
});

test("fleet.css layers the new styles over the old ones", async () => {
  const css = await read("fleet.css");
  assert.match(css, /^@layer (?:legacy, )?tokens, components, pages;/, "the layer order is not declared first");
  for (const file of ["tokens", "components", "pages"]) {
    assert.match(css, new RegExp(`@import url\\("\\./styles/${file}\\.css"\\) layer\\(${file}\\);`), `styles/${file}.css is not imported`);
  }
});

test("the build ships the layered stylesheets", async () => {
  const build = await read("build.mjs");
  for (const file of ["tokens", "components", "pages"]) {
    assert.match(build, new RegExp(`"\\./styles/${file}\\.css"[\\s\\S]*?"styles/${file}\\.css"`), `styles/${file}.css is not copied`);
  }
});

test("text on the ink surface is readable", async () => {
  const tokens = await read("styles/tokens.css");
  const [paper, softPaper, ink, coral] = ["--paper", "--soft-paper", "--ink", "--coral"].map((name) => cssColor(tokens, name));
  assert.ok(contrast(paper!, ink!) >= 4.5, "body text on ink");
  assert.ok(contrast(softPaper!, ink!) >= 4.5, "secondary text on ink");
  assert.ok(contrast(coral!, ink!) >= 3, "coral accent on ink");
  assert.ok(contrast(ink!, paper!) >= 4.5, "ink label on a paper button");
});
```

Leave `access`, `PAGES`, `NEW_STYLES` and `rules` in place even though they're unused for now. Later tasks append tests that use them. If the typecheck rejects unused locals in test files, run `npx tsc --noEmit -p app` and follow the project setting; the existing tests show the allowed style.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd app && node --import tsx --test test/app-look.test.ts`
Expected: FAIL with `ENOENT … styles/tokens.css` and "the layer order is not declared first".

- [ ] **Step 3: Commit the red test**

```bash
git add app/test/app-look.test.ts
git commit -m "test(app): pin the landing palette, the style layers and ink contrast"
```

- [ ] **Step 4: Create `app/styles/tokens.css`**

```css
/* The landing's palette and motion, copied token for token (landing/public/style.css).
   Ink surface, paper type, one accent hue. */
:root {
  --coral: #FF5A3C;
  --coral-lift: #FF7A5C;
  --coral-deep: #7A2415;
  --paper: #F5EFE5;
  --soft-paper: #DED6CA;
  --ink: #171513;
  --muted-ink: #6F6860;
  --surface-top: #0D0C0B;
  --surface-bottom: #171513;
  --text-muted: rgba(245, 239, 229, 0.62);
  --glass-line: rgba(245, 239, 229, 0.36);
  --glass-fill: rgba(0, 0, 0, 0.325);
  --hairline: 1px;

  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-metric: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --track-tight: -0.04em;
  --track-snug: -0.03em;
  --track-narrow: -0.02em;
  --track-wide: 0.07em;

  --radius-card: 24px;
  --radius-control: 4px;
  --radius-pill: 999px;

  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --dur-ui: 240ms;
  --dur-reveal: 800ms;

  color-scheme: dark;
}
```

- [ ] **Step 5: Create `app/styles/components.css` (base only for now) and `app/styles/pages.css`**

`app/styles/components.css`:

```css
/* Components shared by every app page. The pages layer refines them; the
   legacy layer loses to both. */
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--surface-bottom); }
body.fleet-body {
  margin: 0;
  min-height: 100vh;
  background: linear-gradient(180deg, var(--surface-top), var(--surface-bottom) 60%);
  color: var(--paper);
  font-family: var(--font-sans);
  letter-spacing: var(--track-narrow);
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
:focus-visible { outline: 2px solid var(--paper); outline-offset: 3px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

`app/styles/pages.css`:

```css
/* Page-specific rules: Balance, the setup wizard, Control Room, Boundary. */
```

- [ ] **Step 6: Turn `app/fleet.css` into the manifest.** Insert these lines at the very top of the file, before the existing `/* Fleet pages — "Soft Receipt" …` comment:

```css
@layer legacy, tokens, components, pages;
@import url("./styles/tokens.css") layer(tokens);
@import url("./styles/components.css") layer(components);
@import url("./styles/pages.css") layer(pages);

/* Everything below is the pre-redesign stylesheet, kept at the lowest priority
   while the pages move onto the new layers. Each redesign task deletes the
   rules it replaces. */
@layer legacy {
```

Then append a single line `}` at the very end of the file, closing `@layer legacy {`. Don't re-indent the old rules. The diff should be only these added lines.

- [ ] **Step 7: Copy the styles in `app/build.mjs`.** After `await mkdir(output, { recursive: true });`, add:

```js
await mkdir(new URL("styles/", output), { recursive: true });
```

Inside the `Promise.all([` list, directly after the `fleet.css` copy line, add:

```js
  copyFile(new URL("./styles/tokens.css", import.meta.url), new URL("styles/tokens.css", output)),
  copyFile(new URL("./styles/components.css", import.meta.url), new URL("styles/components.css", output)),
  copyFile(new URL("./styles/pages.css", import.meta.url), new URL("styles/pages.css", output)),
```

- [ ] **Step 8: Run everything and confirm it passes**

Run: `npm --prefix app run verify`
Expected: typecheck clean, all tests pass (including the 4 new ones), build succeeds. Also run `ls app/dist/styles` and expect `components.css pages.css tokens.css`.

- [ ] **Step 9: Look at it.** Restart `npm run dev:local` and open http://localhost:3000/app/balance.html. The page background is now ink, and cards still carry the legacy look. That's expected mid-migration.

- [ ] **Step 10: Commit** (check `git diff --cached --shortstat` ≤ 200)

```bash
git add app/styles app/fleet.css app/build.mjs
git commit -m "feat(app): layer the landing's tokens over the old stylesheet"
```

---

### Task 2: Dark-only: remove the theme switch

**Files:**
- Modify:
  - the four `app/*.html` pages (the `theme-color` meta, and the `#theme-toggle` button in `fleet.html`, `fleet-dashboard.html` and `fleet-privacy.html`)
  - `app/src/fleet/page-shared.ts` (delete `THEME_KEY` and `initTheme`)
  - `app/src/fleet-page.ts`, `app/src/fleet-dashboard.ts`, `app/src/balance-page.ts` and `app/src/fleet-privacy.ts` (remove the `initTheme` import and call)
  - `app/fleet.css` (the legacy token blocks and the `.theme-toggle` rules)
- Test: `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `read` and `PAGES` from Task 1
- Produces: `page-shared.ts` no longer exports `initTheme`

- [ ] **Step 1: Append the failing test**

```ts
test("the app is dark-only: no theme switch, ink browser chrome", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    assert.doesNotMatch(html, /theme-toggle/, `${page} still offers a theme switch`);
    assert.match(html, /<meta name="theme-color" content="#171513" \/>/, `${page} paints light browser chrome`);
  }
  for (const script of ["src/fleet/page-shared.ts", "src/fleet-page.ts", "src/fleet-dashboard.ts", "src/balance-page.ts", "src/fleet-privacy.ts"]) {
    assert.doesNotMatch(await read(script), /initTheme/, `${script} still wires the theme switch`);
  }
  assert.doesNotMatch(await read("fleet.css"), /data-theme|prefers-color-scheme/, "the old stylesheet still switches themes");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd app && node --import tsx --test test/app-look.test.ts`. Expected: FAIL, "fleet.html still offers a theme switch".

- [ ] **Step 3: Commit the red test.** `git add app/test/app-look.test.ts && git commit -m "test(app): the app is dark-only"`

- [ ] **Step 4: Update the HTML.** In all four pages, replace `<meta name="theme-color" content="#f5efe5" />` with `<meta name="theme-color" content="#171513" />`. In `fleet.html`, `fleet-dashboard.html` and `fleet-privacy.html`, delete this line:

```html
    <button id="theme-toggle" type="button" class="theme-toggle" aria-label="Switch color theme" aria-pressed="false">☾</button>
```

- [ ] **Step 5: Update the scripts**
  - In `app/src/fleet/page-shared.ts`, delete everything from `const THEME_KEY = "chit-fleet-theme";` through the closing `};` of `export const initTheme`. That is the whole theme section, about 34 lines above `/** Robinhood Chain testnet …`.
  - In each page script, remove `initTheme` from the `./fleet/page-shared.js` import list and delete the `initTheme();` call. The calls are at `fleet-privacy.ts:15`, `fleet-dashboard.ts:243`, `balance-page.ts:33` and `fleet-page.ts:452`.

- [ ] **Step 6: Make the legacy layer dark-only.** In `app/fleet.css`, replace everything from the first `:root {` (just under the "Soft Receipt" comment) through the closing `}` of the `@media (prefers-color-scheme: dark) { … }` block (just before `*, *::before`) with this single merged block:

```css
:root {
  --bg: #121016;
  --surface: #151318;
  --dim-outer: #9b968e;
  --card: #1d1a20;
  --text: #f2efe9;
  --dim: #9b968e;
  --coral: #ff5a3c;
  --on-coral: #1c1a17;
  --coral-text: #ff7d64;
  --coral-soft: #35201c;
  --coral-note: #ffb3a3;
  --mint: #173226;
  --mint-text: #3ddc97;
  --line: #2b2830;
  --shadow: 0 2px 24px rgba(0, 0, 0, 0.35);
  --focus: #7db4f5;
  --r-card: 24px;
  --r-field: 16px;
  --r-btn: 16px;
}
```

Then delete every rule whose selector starts with `.theme-toggle`, starting at `.theme-toggle {`. Finally, confirm nothing theme-related is left: `grep -n "data-theme\|prefers-color-scheme" app/fleet.css` should print nothing.

- [ ] **Step 7: Run everything and confirm it passes.** Run: `npm --prefix app run verify`. Expected: all pass.

- [ ] **Step 8: Commit** (≤ 200 lines)

```bash
git add app/*.html app/src app/fleet.css
git commit -m "feat(app): dark-only, like the landing"
```

---

### Task 3: Masthead, nav and phone menu

**Files:**
- Modify:
  - the four `app/*.html` pages (replace `<header class="fleet-top">…</header>`)
  - `app/src/fleet/page-shared.ts` (add `initMenu` and `initShell`)
  - the four page scripts (call `initShell()`)
  - `app/styles/components.css` (append the shell rules)
  - `app/fleet.css` (delete the legacy shell rules)
- Test: `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `read`, `PAGES` and `access` from Task 1
- Produces:
  - `export const initMenu: () => void`
  - `export const initShell: () => void`, which each page calls once, right after `initHeaderWallet()`. Tasks 4, 8 and 9 add calls inside it.
  - Masthead markup ids and classes: `.masthead`, `.brand-lockup`, `#fleet-nav.nav`, `.burger`

- [ ] **Step 1: Append the failing tests**

```ts
const NAV: ReadonlyArray<readonly [string, string]> = [
  ["./balance.html", "Balance"],
  ["./fleet.html", "Set up"],
  ["./fleet-dashboard.html", "Control Room"],
  ["./fleet-privacy.html", "Boundary"],
];

test("every page wears the landing's masthead and the same nav", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    assert.match(html, /<header class="masthead">/, `${page} has no masthead`);
    assert.match(html, /<a class="brand-lockup" href="\/" aria-label="Chit home">/, `${page} brand does not lead to the landing`);
    const nav = /<nav class="nav" id="fleet-nav" aria-label="Fleet pages">([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(nav, `${page} has no fleet nav`);
    const links = [...nav[1]!.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)];
    assert.deepEqual(links.map((m) => [m[1], m[3]]), NAV.map(([href, label]) => [href, label]), `${page} nav differs from the landing's labels`);
    assert.deepEqual(links.filter((m) => m[2]).map((m) => m[1]), [`./${page}`], `${page} marks the wrong page as current`);
    assert.match(html, /<button class="burger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="fleet-nav">/, `${page} has no phone menu`);
    assert.doesNotMatch(html, /chain-mark|class="fleet-top"/, `${page} still carries the old header`);
  }
});

test("the phone menu opens and closes the nav it controls", async () => {
  const shared = await read("src/fleet/page-shared.ts");
  const menu = /export const initMenu[\s\S]*?\n\};/.exec(shared);
  assert.ok(menu, "no initMenu");
  assert.match(menu[0], /setAttribute\("aria-expanded", String\(open\)\)/);
  assert.match(menu[0], /dataset\["open"\] = String\(open\)/);
  assert.match(menu[0], /key === "Escape"/, "Escape does not close the menu");
});

// These two already pass; they guard the new markup.
test("no app page loads third-party assets", async () => {
  for (const page of PAGES) assert.doesNotMatch(await read(page), /<(?:script|link|img)[^>]+https?:\/\//i, page);
});

test("every link on every app page reaches a page or an element that exists", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    for (const [, target] of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
      if (target === "/") continue;
      if (target!.startsWith("#")) {
        assert.match(html, new RegExp(`id="${target!.slice(1)}"`), `${page}: ${target} points at nothing`);
        continue;
      }
      assert.match(target!, /^\.\/[a-z-]+\.html$/, `${page}: unexpected link ${target}`);
      await assert.doesNotReject(access(join(appRoot, target!)), `${page}: ${target} does not exist`);
    }
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Expected: FAIL, "fleet.html has no masthead".

- [ ] **Step 3: Commit the red tests.** `git add app/test/app-look.test.ts && git commit -m "test(app): one masthead and nav on every page"`

- [ ] **Step 4: Replace the header on each page.** Replace the whole `<header class="fleet-top"> … </header>` element, including the `chain-mark` span, with the block below. Put ` aria-current="page"` on the link to the page itself: Balance in `balance.html`, Set up in `fleet.html`, Control Room in `fleet-dashboard.html`, Boundary in `fleet-privacy.html`. The block below is written for `balance.html`.

```html
      <header class="masthead">
        <a class="brand-lockup" href="/" aria-label="Chit home">
          <img src="./logo.svg" alt="" width="28" height="28" />
          <span>Chit</span>
        </a>
        <nav class="nav" id="fleet-nav" aria-label="Fleet pages">
          <a href="./balance.html" aria-current="page">Balance</a>
          <a href="./fleet.html">Set up</a>
          <a href="./fleet-dashboard.html">Control Room</a>
          <a href="./fleet-privacy.html">Boundary</a>
        </nav>
        <button id="hdr-wallet" type="button" class="wallet-btn" data-state="disconnected" aria-label="Connect wallet">Connect</button>
        <button class="burger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="fleet-nav"><span></span><span></span><span></span></button>
      </header>
```

- [ ] **Step 5: Add `initMenu` and `initShell` to `app/src/fleet/page-shared.ts`** (append at the end of the file)

```ts
/** The phone menu: the burger opens the nav sheet it controls; Escape or a link closes it. */
export const initMenu = (): void => {
  const burger = document.querySelector<HTMLButtonElement>(".burger");
  const nav = document.getElementById("fleet-nav");
  if (!burger || !nav) return;
  const set = (open: boolean): void => {
    burger.setAttribute("aria-expanded", String(open));
    nav.dataset["open"] = String(open);
  };
  burger.addEventListener("click", () => set(burger.getAttribute("aria-expanded") !== "true"));
  nav.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("a")) set(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") set(false);
  });
};

/** Wires the shared page frame. */
export const initShell = (): void => {
  initMenu();
};
```

In each of the four page scripts, add `initShell` to the `./fleet/page-shared.js` import and call `initShell();` on the line right after `initHeaderWallet();`.

- [ ] **Step 6: Append the shell rules to `app/styles/components.css`**

```css
/* ---- Shell: page frame, masthead, nav, phone menu ---- */
.skip-link { position: absolute; left: 1rem; top: -3rem; z-index: 20; padding: 0.5rem 0.75rem; border-radius: var(--radius-control); background: var(--paper); color: var(--ink); }
.skip-link:focus { top: 1rem; }
.fleet-shell { max-width: 72rem; margin-inline: auto; padding-inline: clamp(1rem, 4vw, 2.25rem); padding-block-end: 3rem; }
.fleet-shell > main { width: 100%; margin-inline: auto; }
main.wizard, main.privacy-page { max-width: 46rem; }
main.dash { max-width: 60rem; }

.masthead {
  display: grid; grid-template-columns: auto 1fr auto;
  grid-template-areas: "brand nav action" "contract contract contract";
  align-items: center; gap: 0.75rem 1.5rem; padding-block: 1.25rem 1rem;
}
.brand-lockup { grid-area: brand; display: inline-flex; align-items: center; gap: 0.6rem; font-size: 1.25rem; letter-spacing: var(--track-snug); text-decoration: none; }
.brand-lockup img { width: 1.75rem; height: 1.75rem; }
.nav { grid-area: nav; display: flex; justify-content: center; gap: clamp(1rem, 3vw, 2.25rem); }
.nav a { padding-block: 0.4rem; border-bottom: 1px solid transparent; color: var(--text-muted); font-size: 0.95rem; text-decoration: none; }
.nav a[aria-current="page"] { color: var(--paper); border-bottom-color: var(--paper); }
.wallet-btn { grid-area: action; padding: 0.55rem 1rem; border: 0; border-radius: var(--radius-control); background: var(--paper); color: var(--ink); font: inherit; font-size: 0.9rem; white-space: nowrap; cursor: pointer; }
.wallet-btn[data-state="connected"] { border: 1px solid var(--glass-line); background: transparent; color: var(--paper); font-family: var(--font-mono); }
.wallet-btn[data-state="error"] { background: var(--coral-deep); color: var(--paper); }
.burger { display: none; }

@media (max-width: 720px) {
  .masthead { grid-template-columns: 1fr auto auto; grid-template-areas: "brand action burger" "nav nav nav" "contract contract contract"; }
  .burger { grid-area: burger; display: grid; place-content: center; gap: 5px; width: 2.5rem; height: 2.5rem; border: 1px solid var(--glass-line); border-radius: var(--radius-control); background: transparent; }
  .burger span { display: block; width: 18px; height: 1.5px; background: var(--paper); }
  .nav { display: none; flex-direction: column; gap: 0; }
  .nav[data-open="true"] { display: flex; }
  .nav a { padding-block: 0.8rem; border-bottom: 1px solid rgba(245, 239, 229, 0.08); }
}
```

- [ ] **Step 7: Run everything and confirm it passes.** Run: `npm --prefix app run verify`. Expected: all pass.

- [ ] **Step 8: Commit** (≤ 200 lines): `git add app/*.html app/src app/styles && git commit -m "feat(app): the landing's masthead, nav and phone menu on every page"`

- [ ] **Step 9: Delete the legacy shell rules.** In `app/fleet.css`, delete every legacy rule whose selector starts with any of these: `.skip-link`, `body.fleet-body`, `.fleet-shell`, `main.privacy-page`, `main.wizard`, `.fleet-top`, `.top-right`, `.chain-mark`, `.wallet-btn`. That covers everything from `.skip-link {` through the last `.wallet-btn[data-state="error"]` rule, except the `.wallet-chooser` rules in between, which Task 7 deletes. Run `npm --prefix app run verify`, expect all pass, then commit with `git commit -am "style(app): drop the old header and frame styles"`.

---

### Task 4: Contract row, footer line, status pill

**Files:**
- Modify:
  - the four `app/*.html` pages (the contract row inside the masthead, the pill after `</header>`, and a disclaimer in the footer)
  - `app/src/fleet/page-shared.ts` (add `initContractCopy` and `initPoolStatus`, and call them from `initShell`)
  - `app/src/fleet/balance.ts` (add `poolStatus`)
  - `app/src/fleet/balance-read.ts` (dispatch `chit-balance-read`)
  - `app/styles/components.css`
  - `app/fleet.css` (delete the legacy `.fleet-foot` rules)
- Test: `app/test/app-figures.test.ts` (create), `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `initShell` from Task 3; `loadCachedBalance(storage: Storage, wallet: string): CachedBalance | undefined` and `getConnectedWallet(): Hex | undefined` (both existing)
- Produces:
  - `export const poolStatus: (state: Pick<BalanceState, "pool"> | undefined) => { text: string; live: boolean } | undefined` in `balance.ts`
  - `export const initContractCopy: () => void` and `export const initPoolStatus: () => void` in `page-shared.ts`
  - The window event `chit-balance-read`, fired after every live balance read

- [ ] **Step 1: Write the failing tests.** Create `app/test/app-figures.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { poolStatus } from "../src/fleet/balance.js";

test("the status pill says nothing until the pool's state has been read", () => {
  assert.equal(poolStatus(undefined), undefined);
});

test("a paused pool is never shown as live", () => {
  assert.deepEqual(poolStatus({ pool: { paused: true } }), { text: "Pool paused by the operator", live: false });
});

test("a readable, unpaused pool is live on testnet 46630", () => {
  assert.deepEqual(poolStatus({ pool: { paused: false } }), { text: "Pool live · testnet 46630", live: true });
});
```

Append to `app/test/app-look.test.ts`:

```ts
test("every page carries the contract row, the status pill and the non-affiliation line", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    assert.match(html, /<code id="contract-address">0xD523A627030509021cC39B6d7C8543417D3E50D8<\/code>/, `${page} has no contract row`);
    assert.match(html, /<button id="copy-contract-address" type="button" aria-label="Copy contract address">Copy<\/button>/);
    assert.match(html, /<p id="pool-status" class="pill" role="status" hidden>/, `${page} has no hidden-by-default status pill`);
    assert.match(html, /not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap/, `${page} lacks the non-affiliation line`);
  }
});

test("the status pill reads the cached balance and never signs for one", async () => {
  const shared = await read("src/fleet/page-shared.ts");
  const pill = /export const initPoolStatus[\s\S]*?\n\};/.exec(shared);
  assert.ok(pill, "no initPoolStatus");
  assert.match(pill[0], /loadCachedBalance\(/);
  assert.doesNotMatch(pill[0], /readBalance|signedFleetApi/, "the pill must not cost a signature");
  assert.match(await read("src/fleet/balance-read.ts"), /dispatchEvent\(new CustomEvent\("chit-balance-read"/, "pages are never told a fresh balance arrived");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `cd app && node --import tsx --test test/app-figures.test.ts test/app-look.test.ts`. Expected: FAIL, `poolStatus` is not exported, and "fleet.html has no contract row".

- [ ] **Step 3: Commit the red tests.** `git add app/test && git commit -m "test(app): contract row, honest status pill, non-affiliation line"`

- [ ] **Step 4: Add `poolStatus` to `app/src/fleet/balance.ts`** (append):

```ts
/** What the header's status pill says: only what the last balance read showed, never a guess. */
export const poolStatus = (state: Pick<BalanceState, "pool"> | undefined): { text: string; live: boolean } | undefined =>
  state === undefined
    ? undefined
    : state.pool.paused
      ? { text: "Pool paused by the operator", live: false }
      : { text: "Pool live · testnet 46630", live: true };
```

- [ ] **Step 5: Announce live reads in `app/src/fleet/balance-read.ts`.** In `readBalance`, after `saveCachedBalance(sessionStorage, wallet, body, now);`, add:

```ts
  window.dispatchEvent(new CustomEvent("chit-balance-read", { detail: { wallet } }));
```

- [ ] **Step 6: Add the contract copy and the status pill to `app/src/fleet/page-shared.ts`.**

First run `grep -n "^import" app/src/fleet/balance.ts` and confirm that `balance.ts` does not import `page-shared`; otherwise there's an import cycle. Then add this import at the top:

```ts
import { loadCachedBalance, poolStatus } from "./balance.js";
```

Add these two functions above `initShell`:

```ts
/** The masthead's contract row, copied as on the landing. */
export const initContractCopy = (): void => {
  const address = document.getElementById("contract-address");
  const button = document.getElementById("copy-contract-address");
  const status = document.getElementById("copy-contract-status");
  if (!address || !button || !status) return;
  button.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(address.textContent ?? "")
      .then(() => {
        button.classList.remove("error");
        button.textContent = "Copied";
        status.textContent = "Contract address copied.";
      })
      .catch(() => {
        button.classList.add("error");
        button.textContent = "Copy failed. Try again.";
        status.textContent = "Copy failed. Try again.";
      })
      .finally(() => {
        window.setTimeout(() => {
          button.textContent = "Copy";
        }, 1600);
      });
  });
};

/** The status pill under the masthead: the pool's state as of the last balance read, hidden until there is one. */
export const initPoolStatus = (): void => {
  const pill = document.getElementById("pool-status");
  if (!pill) return;
  const render = (): void => {
    const wallet = getConnectedWallet();
    let status: ReturnType<typeof poolStatus>;
    try {
      status = poolStatus(wallet ? loadCachedBalance(sessionStorage, wallet) : undefined);
    } catch {
      status = undefined;
    }
    pill.hidden = status === undefined;
    if (!status) return;
    pill.dataset["live"] = String(status.live);
    const text = pill.querySelector(".pill__text");
    if (text) text.textContent = status.text;
  };
  window.addEventListener("chit-balance-read", render);
  window.addEventListener("chit-wallet-changed", render);
  render();
};
```

Then make `initShell`'s body call all three:

```ts
export const initShell = (): void => {
  initMenu();
  initContractCopy();
  initPoolStatus();
};
```

- [ ] **Step 7: Update the markup on all four pages**
  - Inside `<header class="masthead">`, after the `.burger` button, add:

```html
        <div class="contract-row">
          <span class="contract-row__label">CA</span>
          <code id="contract-address">0xD523A627030509021cC39B6d7C8543417D3E50D8</code>
          <button id="copy-contract-address" type="button" aria-label="Copy contract address">Copy</button>
          <span id="copy-contract-status" class="sr-only" role="status" aria-live="polite"></span>
        </div>
```

  - Right after `</header>`, add:

```html
      <p id="pool-status" class="pill" role="status" hidden><span class="pill__dot" aria-hidden="true"></span><span class="pill__text"></span></p>
```

  - Inside each `<footer class="fleet-foot">`, after the existing `<p>`, add:

```html
        <p class="disclaimer">Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.</p>
```

- [ ] **Step 8: Append to `app/styles/components.css`**

```css
/* ---- Contract row, status pill, footer ---- */
.contract-row { grid-area: contract; justify-self: start; display: inline-grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; max-width: 100%; color: var(--text-muted); font-size: 0.72rem; }
.contract-row__label { letter-spacing: var(--track-wide); }
.contract-row code { overflow: hidden; color: var(--soft-paper); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.contract-row button { padding: 0.15rem 0.45rem; border: 1px solid var(--glass-line); border-radius: var(--radius-control); background: transparent; color: var(--soft-paper); font: inherit; font-size: 0.65rem; letter-spacing: var(--track-wide); text-transform: uppercase; cursor: pointer; }
.contract-row button.error { border-color: var(--coral-deep); }

.pill { display: inline-flex; align-items: center; gap: 0.5rem; margin-block: 0.5rem 1.5rem; padding: 0.55rem 0.75rem; border: 1px solid rgba(222, 214, 202, 0.12); border-radius: var(--radius-control); background: linear-gradient(90deg, rgba(255, 90, 60, 0.1), rgba(255, 90, 60, 0.24) 45%, rgba(255, 90, 60, 0.1)); font-size: 0.72rem; letter-spacing: var(--track-wide); text-transform: uppercase; }
.pill[data-live="false"] { background: rgba(122, 36, 21, 0.45); }
.pill__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--coral); }
.pill[data-live="false"] .pill__dot { background: var(--soft-paper); }
.pill__text { white-space: nowrap; }

.fleet-foot { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid rgba(245, 239, 229, 0.1); color: var(--text-muted); font-size: 0.8rem; line-height: 1.5; }
.fleet-foot a { color: var(--soft-paper); }
.fleet-foot .disclaimer { font-size: 0.72rem; }
```

- [ ] **Step 9: Delete the legacy footer rules.** In `app/fleet.css`, delete both legacy `.fleet-foot` rules: the one near the top (`.fleet-foot {` after `main.privacy-page` in the old layout) and the one near the end, just before the `@media (max-width` blocks.

- [ ] **Step 10: Run everything and confirm it passes.** Run: `npm --prefix app run verify`. Expected: all pass. Then open the pages. The pill stays hidden until a wallet has read its balance, and after that it shows "Pool live · testnet 46630".

- [ ] **Step 11: Commit** (≤ 200 lines): `git add app && git commit -m "feat(app): contract row, pool status pill, non-affiliation footer"`

---

### Task 5: Type and buttons

**Files:**
- Modify: `app/styles/components.css`, and `app/fleet.css` (delete the legacy type and button rules)
- Test: `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `read`, `rules` and `NEW_STYLES` from Task 1
- Produces: the classes `.kicker .lead .fineprint .hint .mono-line .eligibility-line .promises .primary .ghost .back .linkbtn .big .wnav`, plus the coral-discipline and hover-guard tests that every later task must satisfy

- [ ] **Step 1: Append the failing tests**

```ts
const LIVE_OR_HAPPENED = /pill|data-live|data-done|aria-current="step"|data-tone="ok"|\.delta|meter__fill|gauge/;

test("coral marks only what is live or has happened", async () => {
  for (const file of NEW_STYLES) {
    for (const [selector, body] of rules(await read(file))) {
      if (!/var\(--coral(?:-lift)?\)/.test(body)) continue;
      assert.match(selector, LIVE_OR_HAPPENED, `${file}: "${selector}" uses coral for something neither live nor done`);
    }
  }
});

test("primary actions are paper, as on the landing", async () => {
  const primary = rules(await read("styles/components.css")).find(([selector]) => selector === ".primary");
  assert.ok(primary, "no .primary rule");
  assert.match(primary[1], /background:\s*var\(--paper\)/);
  assert.match(primary[1], /color:\s*var\(--ink\)/);
});

test("hover effects only apply where there is a real pointer", async () => {
  for (const file of NEW_STYLES) {
    const unguarded = (await read(file)).replace(/@media \(hover: hover\) and \(pointer: fine\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    assert.doesNotMatch(unguarded, /:hover/, `${file} has a hover effect outside the pointer guard`);
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Expected: FAIL, "no .primary rule".

- [ ] **Step 3: Commit the red tests.** `git add app/test/app-look.test.ts && git commit -m "test(app): coral only for live and done; paper primaries; pointer-only hover"`

- [ ] **Step 4: Append to `app/styles/components.css`**

```css
/* ---- Type ---- */
h1, h2, h3 { margin: 0 0 0.75rem; font-weight: 500; line-height: 1.05; letter-spacing: var(--track-tight); }
h1 { font-size: clamp(2rem, 5vw, 3.25rem); }
h2 { font-size: clamp(1.5rem, 3.5vw, 2.25rem); }
.kicker { margin: 0 0 0.75rem; color: var(--text-muted); font-size: 0.72rem; letter-spacing: var(--track-wide); text-transform: uppercase; }
.lead { margin: 0 0 1.25rem; color: var(--text-muted); font-size: 1.1rem; line-height: 1.45; }
.lead.small { font-size: 0.95rem; }
.fineprint, .hint { margin: 0.75rem 0 0; color: var(--text-muted); font-size: 0.82rem; line-height: 1.5; }
.fineprint a { color: var(--soft-paper); }
.mono-line { color: var(--soft-paper); font-family: var(--font-mono); font-size: 0.82rem; overflow-wrap: anywhere; }
.eligibility-line { color: var(--soft-paper); font-size: 0.9rem; }
.promises { display: grid; gap: 0.75rem; margin: 0 0 1.5rem; padding: 0; list-style: none; }
.promises li { padding: 1rem 1.25rem; border: 1px solid rgba(245, 239, 229, 0.08); border-radius: var(--radius-card); background: var(--glass-fill); color: var(--text-muted); line-height: 1.5; }
.promises strong { display: block; color: var(--paper); font-weight: 500; }

/* ---- Buttons ---- */
button, .linkbtn { font: inherit; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.45; }
.primary, .ghost, .back, .linkbtn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; min-height: 2.75rem; padding: 0.6rem 1.25rem; border-radius: var(--radius-control); letter-spacing: var(--track-narrow); text-decoration: none; }
.primary { border: 0; background: var(--paper); color: var(--ink); }
.ghost, .back { border: 1px solid rgba(245, 239, 229, 0.14); background: transparent; color: var(--paper); }
.big { min-height: 3.5rem; padding-inline: 1.75rem; font-size: 1.05rem; }
.wnav { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.75rem; margin-top: 1.5rem; }

@media (hover: hover) and (pointer: fine) {
  .primary:hover, .wallet-btn:hover { background: var(--soft-paper); }
  .ghost:hover, .back:hover { border-color: rgba(245, 239, 229, 0.38); }
}
@media (prefers-reduced-motion: no-preference) {
  .primary, .ghost, .back, .wallet-btn { transition: background-color var(--dur-ui) var(--ease-out), border-color var(--dur-ui) var(--ease-out), transform 120ms var(--ease-out); }
  .primary:active, .ghost:active, .back:active { transform: translateY(1px) scale(0.98); }
}
```

- [ ] **Step 5: Delete the legacy type and button rules.** In `app/fleet.css`, delete the legacy rules whose selectors are:
  - `.kicker`, `h1, h2, h3`, `h1`, `h2`, `.lead`, `.lead.small`
  - `.promises`, `.promises li`, `.promises strong`
  - `button, .linkbtn`, `.primary`, `.ghost`, `.big`, and the two bare `button` state rules after `.big`
  - the `@media (prefers-reduced-motion` block right after them
  - `.back`, `.wnav`, `.wnav .primary`
  - `.fineprint`, and `.fineprint a, .fleet-foot a` (delete the whole rule)
  - `.hint`, `.mono-line`, `.eligibility-line`

- [ ] **Step 6: Run everything and confirm it passes.** Run: `npm --prefix app run verify`. Expected: all pass. Check the diff is ≤ 200 lines. If it's over, commit step 4 first, then step 5.

- [ ] **Step 7: Commit.** `git add app && git commit -m "feat(app): the landing's type and paper buttons"`

---

### Task 6: Fields and pickers

**Files:**
- Modify: `app/styles/components.css`, and `app/fleet.css` (delete the legacy field and picker rules)
- Test: `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `rules` and `read` from Task 1
- Produces: styling for `.field .bigfield .unit .field-error .quickpick .advanced`. The pinned `.quickpick` class must stay exactly as it is.

- [ ] **Step 1: Append the failing test**

```ts
test("a chosen size reads as chosen without borrowing coral, and field errors are deep-coral panels", async () => {
  const css = rules(await read("styles/components.css"));
  const pressed = css.find(([selector]) => selector === '.quickpick button[aria-pressed="true"]');
  assert.ok(pressed && /background:\s*var\(--paper\)/.test(pressed[1]), "the chosen size is not paper");
  const error = css.find(([selector]) => selector === ".field-error");
  assert.ok(error && /background:\s*var\(--coral-deep\)/.test(error[1]), "field errors are not deep-coral panels");
});
```

- [ ] **Step 2: Run the test and confirm it fails; commit the red test.** Expected: FAIL. Then `git add app/test/app-look.test.ts && git commit -m "test(app): chosen sizes in paper, errors in deep coral"`

- [ ] **Step 3: Append to `app/styles/components.css`**

```css
/* ---- Fields and pickers ---- */
.field, .bigfield { display: grid; gap: 0.4rem; margin-block: 1rem; }
.field label, .bigfield label { color: var(--text-muted); font-size: 0.72rem; letter-spacing: var(--track-wide); text-transform: uppercase; }
.field input, .bigfield input, .bigfield select { width: 100%; padding: 0.8rem 1rem; border: 1px solid rgba(245, 239, 229, 0.14); border-radius: var(--radius-control); background: rgba(0, 0, 0, 0.35); color: var(--paper); font: inherit; font-family: var(--font-mono); }
.bigfield input, .bigfield select { font-size: 1.5rem; }
.bigfield .unit { color: var(--text-muted); font-size: 0.8rem; }
.field-error { margin: 0.5rem 0 0; padding: 0.6rem 0.9rem; border-radius: var(--radius-control); background: var(--coral-deep); color: var(--paper); font-size: 0.85rem; }
.quickpick { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-block: 0.75rem; }
.quickpick button { min-height: 2.5rem; padding: 0.5rem 1rem; border: 1px solid rgba(245, 239, 229, 0.14); border-radius: var(--radius-pill); background: transparent; color: var(--paper); font-family: var(--font-mono); }
.quickpick button[aria-pressed="true"] { border-color: var(--paper); background: var(--paper); color: var(--ink); }
.advanced { margin-block: 1rem; padding: 0.75rem 1rem; border: 1px solid rgba(245, 239, 229, 0.1); border-radius: var(--radius-control); }
.advanced summary { color: var(--soft-paper); cursor: pointer; }

@media (hover: hover) and (pointer: fine) {
  .quickpick button:hover { border-color: rgba(245, 239, 229, 0.38); }
}
```

- [ ] **Step 4: Delete the legacy field and picker rules.** In `app/fleet.css`, delete every legacy rule whose selector starts with `.bigfield`, `.quickpick`, `.advanced`, `.field` (including `.field-error`).

- [ ] **Step 5: Run everything, then commit** (≤ 200 lines). Run `npm --prefix app run verify` and expect all pass. Then `git add app && git commit -m "feat(app): fields and size pickers on ink"`

---

### Task 7: Surfaces, tiles, banners, chips, meters, dialogs, loading

**Files:**
- Modify: `app/styles/components.css`, and `app/fleet.css` (delete the legacy rules listed in step 5)
- Test: `app/test/app-look.test.ts` (append)

**Interfaces:**
- Produces:
  - the classes `.card-glass .card-warm .card-solid` (`.wstep` and `.dash-card` default to solid), `.cardlabel`, `.summary` tiles, `.status-banner[data-tone]`, `.warnbox`, `.state-chip[data-live]`, `.budget-meter`, `.meter`, `.meter__fill`
  - glass dialog styling for `.wallet-chooser` and `.confirm-dialog`
  - `[aria-busy="true"] .summary dd` shimmer

- [ ] **Step 1: Append the failing tests**

```ts
test("the three surfaces exist, and glass is real glass", async () => {
  const css = rules(await read("styles/components.css"));
  const glass = css.find(([selector]) => selector === ".card-glass");
  assert.ok(glass && /backdrop-filter:\s*blur\(/.test(glass[1]), ".card-glass has no blur");
  assert.ok(css.some(([selector]) => selector === ".card-warm"), "no .card-warm");
  assert.ok(css.some(([selector]) => /(^|,\s*)\.card-solid\b/.test(selector)), "no .card-solid");
});

test("errors are deep-coral panels, never the live accent", async () => {
  const error = rules(await read("styles/components.css")).find(([selector]) => selector === '.status-banner[data-tone="error"]');
  assert.ok(error && /background:\s*var\(--coral-deep\)/.test(error[1]));
});
```

- [ ] **Step 2: Run the tests and confirm they fail; commit the red tests.** `git add app/test/app-look.test.ts && git commit -m "test(app): glass, warm and solid surfaces; errors in deep coral"`

- [ ] **Step 3: Append to `app/styles/components.css`**

```css
/* ---- Surfaces ---- */
.card-glass, .card-warm, .card-solid, .wstep, .dash-card { position: relative; margin-block: 1.25rem; padding: clamp(1.25rem, 3vw, 2rem); border-radius: var(--radius-card); }
.card-solid, .wstep, .dash-card { border: 1px solid rgba(245, 239, 229, 0.08); background: rgba(245, 239, 229, 0.04); }
.card-glass { border: 1px solid rgba(222, 214, 202, 0.12); background: var(--glass-fill); backdrop-filter: blur(24px); }
.card-warm { border: 1px solid rgba(245, 239, 229, 0.22); background: linear-gradient(160deg, rgba(222, 214, 202, 0.55), rgba(255, 122, 92, 0.55) 55%, rgba(122, 36, 21, 0.75)); color: var(--paper); }
.cardlabel { margin: 0 0 0.75rem; color: var(--text-muted); font-size: 0.72rem; letter-spacing: var(--track-wide); text-transform: uppercase; }

/* ---- Figure tiles ---- */
.summary { display: grid; gap: 0.75rem; margin: 0; }
.summary.grid { grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
.summary div { padding: 1rem 1.1rem; border: 1px solid rgba(245, 239, 229, 0.08); border-radius: calc(var(--radius-card) - 8px); background: rgba(0, 0, 0, 0.28); }
.summary dt { margin: 0 0 0.35rem; color: var(--text-muted); font-size: 0.7rem; letter-spacing: var(--track-wide); text-transform: uppercase; }
.summary dd { margin: 0; font-family: var(--font-metric); font-size: 1.35rem; font-variant-numeric: tabular-nums; letter-spacing: var(--track-snug); }
.summary dd button { font-size: 0.85rem; }

/* ---- Banners and warnings ---- */
.status-banner { margin-block: 0 1rem; padding: 0.8rem 1rem; border: 1px solid rgba(245, 239, 229, 0.12); border-radius: var(--radius-control); background: var(--glass-fill); color: var(--soft-paper); font-size: 0.9rem; }
.status-banner[data-tone="error"] { border-color: transparent; background: var(--coral-deep); color: var(--paper); }
.status-banner[data-tone="ok"] { border-color: var(--coral); color: var(--paper); }
.warnbox { padding: 0.9rem 1.1rem; border-radius: var(--radius-control); background: var(--coral-deep); color: var(--paper); }

/* ---- State chips ---- */
.state-chip { display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.35rem 0.7rem; border: 1px solid rgba(245, 239, 229, 0.16); border-radius: var(--radius-pill); color: var(--soft-paper); font-size: 0.72rem; letter-spacing: var(--track-wide); text-transform: uppercase; }
.state-chip[data-live="true"]::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--coral); }

/* ---- Meters ---- */
.budget-meter, .meter { display: flex; height: 0.5rem; overflow: hidden; border-radius: var(--radius-pill); background: rgba(245, 239, 229, 0.1); }
.budget-meter .seg, .meter__fill { height: 100%; }
.meter__fill { width: 100%; transform: scaleX(var(--fill, 0)); transform-origin: left center; }
.budget-meter .spent, .meter__fill { background: var(--coral); }
.budget-meter .reserved { background: rgba(245, 239, 229, 0.35); }

/* ---- Dialogs ---- */
.wallet-chooser, .confirm-dialog { width: min(24rem, calc(100vw - 2rem)); padding: 1.5rem; border: 1px solid rgba(222, 214, 202, 0.14); border-radius: var(--radius-card); background: rgba(13, 12, 11, 0.72); backdrop-filter: blur(28px); color: var(--paper); }
.wallet-chooser::backdrop, .confirm-dialog::backdrop { background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(4px); }
.wallet-chooser h2, .confirm-dialog h2 { margin: 0 0 1rem; font-size: 1.15rem; }
.confirm-dialog p { margin: 0; color: var(--text-muted); line-height: 1.5; }
.wallet-chooser-list { display: grid; gap: 0.5rem; }
.wallet-chooser-list button { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; border: 1px solid rgba(245, 239, 229, 0.1); border-radius: var(--radius-control); background: rgba(245, 239, 229, 0.04); color: var(--paper); text-align: left; }
.wallet-chooser-list button:disabled { cursor: progress; opacity: 0.55; }
.wallet-chooser-list img { width: 28px; height: 28px; border-radius: 8px; }
.wallet-chooser-status { min-height: 1.25em; margin: 0.75rem 0 0; color: var(--soft-paper); font-size: 0.88rem; }
.wallet-chooser-cancel { margin-top: 0.75rem; padding: 0.25rem 0; border: 0; background: none; color: var(--text-muted); }

/* ---- Loading ---- */
[aria-busy="true"] .summary dd { border-radius: 6px; background: linear-gradient(90deg, rgba(245, 239, 229, 0.06), rgba(245, 239, 229, 0.14), rgba(245, 239, 229, 0.06)) 0 0 / 200% 100%; color: transparent; }
@keyframes shimmer { to { background-position: -200% 0; } }

@media (hover: hover) and (pointer: fine) {
  .wallet-chooser-list button:hover { border-color: rgba(245, 239, 229, 0.38); }
}
@media (prefers-reduced-motion: no-preference) {
  [aria-busy="true"] .summary dd { animation: shimmer 1.2s var(--ease-in-out) infinite; }
}
```

- [ ] **Step 4: Run the tests, then commit** (≤ 200 lines). Run `npm --prefix app run verify` and expect all pass. Then `git add app && git commit -m "feat(app): glass, warm and solid surfaces, tiles, chips, meters, dialogs"`

- [ ] **Step 5: Delete the legacy rules.** In `app/fleet.css`, delete every legacy rule whose selector starts with any of these:
  - `.wallet-chooser`, plus the `@media (prefers-reduced-motion` block directly after the chooser rules
  - `.wstep`
  - `.warnbox`
  - `.summary`
  - `.status-banner`
  - `.state-chip`
  - `.dash-card`, `.cardlabel`
  - `.budget-meter`, plus the `@media (prefers-reduced-motion` block inside the budget-meter group

  Run `npm --prefix app run verify` and expect all pass. Then `git commit -am "style(app): drop the old surfaces, tiles and chips"`

---

### Task 8: LED figures

**Files:**
- Create: `app/src/fleet/led.ts`, `app/test/app-led.test.ts`
- Modify: `app/src/fleet/page-shared.ts` (`initShell` calls `hydrateLed()`), `app/styles/components.css`

**Interfaces:**
- Produces:
  - `export type Dot = { cx: number; cy: number }`
  - `export const canLed: (text: string) => boolean`
  - `export const ledDots: (text: string) => { dots: Dot[]; width: number }`, which throws on an unknown character
  - `export const renderLed: (host: HTMLElement, value: string, unit?: string) => void`
  - `export const hydrateLed: (root?: ParentNode) => void`, which renders every `[data-led]` element from `data-led` and `data-unit`

- [ ] **Step 1: Write the failing tests.** Create `app/test/app-led.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canLed, ledDots } from "../src/fleet/led.js";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("every glyph is drawn dot for dot from the landing's bitmaps", () => {
  // "1" is 010/110/010/010/010/010/111: ten lit dots in a three-column glyph.
  assert.equal(ledDots("1").dots.length, 10);
  // "0" is 01110/10001/10011/10101/11001/10001/01110: nineteen lit dots.
  assert.equal(ledDots("0").dots.length, 19);
});

test("glyphs sit side by side with one blank column between them", () => {
  assert.equal(ledDots("1").width, 15);
  assert.equal(ledDots("0.05").width, 95);
});

test("only digits, the point and the colon become dots; anything else stays text", () => {
  assert.equal(canLed("0.0500"), true);
  assert.equal(canLed("12:40"), true);
  assert.equal(canLed("—"), false);
  assert.equal(canLed(""), false);
  assert.equal(canLed("1 ETH"), false);
});

test("an unknown character is refused, never silently skipped", () => {
  assert.throws(() => ledDots("1x"), /no glyph/);
});

test("the dots are decoration; the value stays readable text", async () => {
  const source = await readFile(join(appRoot, "src/fleet/led.ts"), "utf8");
  const render = /export const renderLed[\s\S]*?\n\};/.exec(source);
  assert.ok(render, "no renderLed");
  assert.match(render[0], /setAttribute\("aria-hidden", "true"\)/);
  assert.match(render[0], /className = "sr-only"/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail; commit the red tests.** Run: `cd app && node --import tsx --test test/app-led.test.ts`. Expected: FAIL, cannot find module `led.js`. Then `git add app/test/app-led.test.ts && git commit -m "test(app): LED figures drawn from the landing's glyphs"`

- [ ] **Step 3: Create `app/src/fleet/led.ts`**

```ts
/**
 * The landing's LED dot numerals (landing/public/main.js, "10. LED DOT TYPE"),
 * for the handful of headline figures. The SVG is decoration; the value sits
 * beside it as real text, so a screen reader reads it once and a copy picks
 * it up.
 */

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["010", "110", "010", "010", "010", "010", "111"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ".": ["0", "0", "0", "0", "0", "0", "1"],
  ":": ["0", "0", "1", "0", "1", "0", "0"],
};

const PITCH = 5;
const ROW = 4;
const RADIUS = 1.55;
const HEIGHT = 7 * ROW;
const SVG_NS = "http://www.w3.org/2000/svg";

export type Dot = { cx: number; cy: number };

export const canLed = (text: string): boolean => text.length > 0 && [...text].every((char) => char in GLYPHS);

export const ledDots = (text: string): { dots: Dot[]; width: number } => {
  const dots: Dot[] = [];
  let x = 0;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) throw new Error(`led: no glyph for ${JSON.stringify(char)}`);
    glyph.forEach((bits, row) => {
      [...bits].forEach((bit, col) => {
        if (bit === "1") dots.push({ cx: x + col * PITCH + RADIUS, cy: row * ROW + RADIUS });
      });
    });
    x += glyph[0]!.length * PITCH + PITCH;
  }
  return { dots, width: Math.max(x - PITCH, 1) };
};

/** Draws `value` into `host` as dots; anything the glyphs can't draw (like "—") stays plain text. */
export const renderLed = (host: HTMLElement, value: string, unit?: string): void => {
  host.replaceChildren();
  host.classList.add("led");
  if (canLed(value)) {
    const { dots, width } = ledDots(value);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "led__dots");
    svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const dot of dots) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(dot.cx));
      circle.setAttribute("cy", String(dot.cy));
      circle.setAttribute("r", String(RADIUS));
      svg.append(circle);
    }
    const text = document.createElement("span");
    text.className = "sr-only";
    text.textContent = value;
    host.append(svg, text);
  } else {
    const text = document.createElement("span");
    text.textContent = value;
    host.append(text);
  }
  if (unit) {
    const tag = document.createElement("span");
    tag.className = "led__unit";
    tag.textContent = unit;
    host.append(tag);
  }
};

/** Renders every `[data-led]` element under `root` from its data-led value and optional data-unit. */
export const hydrateLed = (root: ParentNode = document): void => {
  for (const host of Array.from(root.querySelectorAll<HTMLElement>("[data-led]"))) {
    renderLed(host, host.dataset["led"] ?? "", host.dataset["unit"]);
  }
};
```

- [ ] **Step 4: Wire it up and style it.** In `page-shared.ts`, add `import { hydrateLed } from "./led.js";` and a `hydrateLed();` call as the last line of `initShell`. Append to `components.css`:

```css
/* ---- LED figures ---- */
.led { display: inline-flex; align-items: baseline; gap: 0.35em; }
.led__dots { width: auto; height: 1.1em; overflow: visible; fill: currentColor; }
.led__unit { color: var(--text-muted); font-size: 0.55em; }
```

- [ ] **Step 5: Run everything, then commit** (≤ 200 lines). Run `npm --prefix app run verify` and expect all pass. Then `git add app && git commit -m "feat(app): LED dot figures from the landing's glyphs"`

---

### Task 9: Motion

**Files:**
- Create: `app/src/fleet/motion.ts`, `app/test/app-motion.test.ts`
- Modify: `app/src/fleet/page-shared.ts` (`initShell` calls `revealOnEnter()`), `app/styles/components.css`, `app/test/app-look.test.ts` (append)

**Interfaces:**
- Produces:
  - `export const prefersReducedMotion: () => boolean`
  - `export const easeOut: (t: number) => number`
  - `export const countTo: (render: (value: number) => void, from: number, to: number, durationMs?: number) => void`
  - `export const revealOnEnter: (root?: ParentNode) => void`, which adds `reveal-ready` to `<html>` and `is-revealed` to each `[data-reveal]` element once

- [ ] **Step 1: Write the failing tests.** Create `app/test/app-motion.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { countTo, easeOut } from "../src/fleet/motion.js";

test("easing starts at rest, lands exactly, and never goes backwards", () => {
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  let last = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const value = easeOut(t);
    assert.ok(value >= last);
    last = value;
  }
});

test("with reduced motion a figure goes straight to its value", () => {
  const seen: number[] = [];
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
  countTo((value) => seen.push(value), 0, 0.05);
  assert.deepEqual(seen, [0.05]);
});

test("a figure that has not changed is drawn once, not animated", () => {
  const seen: number[] = [];
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false });
  countTo((value) => seen.push(value), 0.05, 0.05);
  assert.deepEqual(seen, [0.05]);
});
```

Append to `app/test/app-look.test.ts`:

```ts
test("motion follows the landing's rules", async () => {
  const [tokens, components, pages, motion] = await Promise.all([read("styles/tokens.css"), read("styles/components.css"), read("styles/pages.css"), read("src/fleet/motion.ts")]);
  assert.match(tokens, /--ease-out:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/);
  assert.match(tokens, /--ease-in-out:\s*cubic-bezier\(0\.77,\s*0,\s*0\.175,\s*1\)/);
  const css = `${components}\n${pages}`;
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "no still version for reduced motion");
  assert.match(motion, /IntersectionObserver/);
  assert.match(motion, /unobserve/, "reveals must happen once");
  assert.doesNotMatch(`${css}\n${motion}`, /transition:\s*all|scale\(0\)|ease-in(?:[;, )]|$)|scroll-behavior:\s*smooth/im);
});
```

- [ ] **Step 2: Run the tests and confirm they fail; commit the red tests.** `git add app/test && git commit -m "test(app): motion has a still version and follows the landing's rules"`

- [ ] **Step 3: Create `app/src/fleet/motion.ts`**

```ts
/** Shared motion helpers. Every one of them has a still version for reduced motion. */

export const prefersReducedMotion = (): boolean =>
  typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Ease-out quart: quick start, gentle landing, the feel of --ease-out. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 4;

/** Counts a figure from `from` to `to`, calling `render` each frame. Under reduced motion, `render(to)` runs once. */
export const countTo = (render: (value: number) => void, from: number, to: number, durationMs = 600): void => {
  if (prefersReducedMotion() || from === to || typeof globalThis.requestAnimationFrame !== "function") {
    render(to);
    return;
  }
  const start = performance.now();
  const frame = (now: number): void => {
    const t = (now - start) / durationMs;
    render(t >= 1 ? to : from + (to - from) * easeOut(t));
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

/** Reveals each `[data-reveal]` once as it enters the viewport; all at once under reduced motion. */
export const revealOnEnter = (root: ParentNode = document): void => {
  const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (prefersReducedMotion() || typeof IntersectionObserver !== "function") {
    for (const target of targets) target.classList.add("is-revealed");
    return;
  }
  document.documentElement.classList.add("reveal-ready");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12 },
  );
  for (const target of targets) observer.observe(target);
};
```

- [ ] **Step 4: Wire it up and add the motion CSS.** In `page-shared.ts`, add `import { revealOnEnter } from "./motion.js";` and a `revealOnEnter();` call as the last line of `initShell`. Append to `components.css`:

```css
/* ---- Motion: once-only reveals, and a still version of everything ---- */
.reveal-ready [data-reveal]:not(.is-revealed) { opacity: 0; transform: translateY(12px); }
@keyframes live-pulse { 50% { opacity: 0.35; } }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: no-preference) {
  .reveal-ready [data-reveal] { transition: opacity var(--dur-reveal) var(--ease-out), transform var(--dur-reveal) var(--ease-out); transition-delay: var(--reveal-delay, 0ms); }
  .meter__fill { transition: transform 600ms var(--ease-out); }
  .pill[data-live="true"] .pill__dot, .state-chip[data-live="true"]::before { animation: live-pulse 2.4s var(--ease-in-out) infinite; }
  .wallet-chooser[open], .confirm-dialog[open] { animation: rise 280ms var(--ease-out); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
```

- [ ] **Step 5: Run everything, then commit** (≤ 200 lines). Run `npm --prefix app run verify` and expect all pass. Then `git add app && git commit -m "feat(app): once-only reveals and count-ups with a still version"`

---

### Task 10: The Balance page

**Files:**
- Modify: `app/balance.html`, `app/src/balance-page.ts`, `app/src/fleet/balance.ts`, `app/styles/pages.css`
- Test: `app/test/app-figures.test.ts`, `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `renderLed` from Task 8; `countTo` from Task 9; `DRAW_CAP` and `toEth` (existing)
- Produces:
  - `export const TRADER_CAP = "500000000000000000"`
  - `export const capShare: (remaining: string, cap: string) => number`, the share of the cap already taken (0..1)
  - `export const balanceDelta: (previous: string | undefined, next: string) => { up: boolean; eth: string } | undefined`

- [ ] **Step 1: Append the failing tests**

To `app/test/app-figures.test.ts`, change the import to `import { balanceDelta, capShare, poolStatus, TRADER_CAP } from "../src/fleet/balance.js";` and append:

```ts
test("the headroom meter shows how much of the 0.5 ETH limit is taken", () => {
  assert.equal(capShare(TRADER_CAP, TRADER_CAP), 0);
  assert.equal(capShare("450000000000000000", TRADER_CAP), 0.1);
  assert.equal(capShare("0", TRADER_CAP), 1);
});

test("the balance change is measured against what this page last showed", () => {
  assert.equal(balanceDelta(undefined, "50000000000000000"), undefined, "no history, no change");
  assert.equal(balanceDelta("50000000000000000", "50000000000000000"), undefined);
  assert.deepEqual(balanceDelta("0", "50000000000000000"), { up: true, eth: "0.05" });
  assert.deepEqual(balanceDelta("50000000000000000", "30000000000000000"), { up: false, eth: "0.02" });
});
```

To `app/test/app-look.test.ts`:

```ts
test("the Balance page leads with a glass hero, the headroom meter and the three limits", async () => {
  const html = await read("balance.html");
  const { DRAW_CAP, toEth } = await import("../src/fleet/balance.js");
  assert.match(html, /<section class="wstep card-glass" aria-labelledby="balance-h" data-reveal>/);
  assert.match(html, /id="headroom-meter" role="meter"/);
  assert.match(html, new RegExp(`data-led="${toEth(DRAW_CAP).replace(".", "\\.")}" data-unit="ETH"`), "the page's draw cap drifted from DRAW_CAP");
  assert.match(html, /data-led="15" data-unit="min"/);
  assert.match(html, /data-led="24" data-unit="h"/);
  assert.match(html, /<section id="exit-card" class="wstep card-warm"/);
  const script = await read("src/balance-page.ts");
  assert.match(script, /renderLed\(/, "the balance is not drawn as an LED figure");
  assert.match(script, /setAttribute\("aria-busy", "true"\)/, "the tiles never show they are loading");
});
```

- [ ] **Step 2: Run the tests and confirm they fail; commit the red tests.** `git add app/test && git commit -m "test(app): Balance hero, headroom meter, limits, balance change"`

- [ ] **Step 3: Add the figures to `app/src/fleet/balance.ts`** (append):

```ts
/** FleetPool's per-depositor cap: 0.5 ETH, refused on chain above it. */
export const TRADER_CAP = "500000000000000000";

/** How much of `cap` is taken, 0..1, from what the contract says remains. */
export const capShare = (remaining: string, cap: string): number => {
  const total = BigInt(cap);
  const left = BigInt(remaining);
  if (total <= 0n) return 0;
  const used = total > left ? total - left : 0n;
  return Number((used * 10_000n) / total) / 10_000;
};

/** The change since the figure this page last showed, for the arrow beside the balance. */
export const balanceDelta = (previous: string | undefined, next: string): { up: boolean; eth: string } | undefined => {
  if (previous === undefined || previous === next) return undefined;
  const before = BigInt(previous);
  const after = BigInt(next);
  return after > before ? { up: true, eth: toEth((after - before).toString()) } : { up: false, eth: toEth((before - after).toString()) };
};
```

- [ ] **Step 4: Update `app/balance.html`**
  - Change the hero section's opening tag to `<section class="wstep card-glass" aria-labelledby="balance-h" data-reveal>`.
  - Change the first tile to `<div><dt>Available at Chit</dt><dd id="balance-available">—</dd><dd id="balance-delta" class="delta" hidden></dd></div>`. Its start, `<div><dt>Available`, must not change.
  - Right after `</dl>` in the hero, add:

```html
          <div class="meter" id="headroom-meter" role="meter" aria-label="Balance against the 0.5 ETH limit" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><span class="meter__fill" id="headroom-fill"></span></div>
          <p id="headroom-note" class="fineprint"></p>
```

  - Right after the hero `</section>`, add:

```html
        <aside class="limits" aria-label="Limits the pool contract enforces" data-reveal>
          <div class="card-warm limit"><p class="cardlabel">Funding delay</p><p class="limit__figure"><span data-led="15" data-unit="min">15 min</span></p><p class="limit__note">The longest wait between activating a fleet and the pool funding it.</p></div>
          <div class="card-warm limit"><p class="cardlabel">Draw cap</p><p class="limit__figure"><span data-led="0.2" data-unit="ETH">0.2 ETH</span></p><p class="limit__note">The most one fleet may draw. Refused on chain above this.</p></div>
          <div class="card-warm limit"><p class="cardlabel">Self-serve exit</p><p class="limit__figure"><span data-led="24" data-unit="h">24 h</span></p><p class="limit__note">Recover your unspent deposit from the contract, with Chit offline.</p></div>
        </aside>
```

  - In the withdraw section, directly above `<form id="withdraw-form" …>`, add: `<p class="callout">Paying out to the wallet you deposited from joins the two again on chain. Send to a fresh address.</p>`
  - Change the exit section's opening tag to `<section id="exit-card" class="wstep card-warm" aria-labelledby="exit-h">`.
  - Add `data-reveal` to the deposit and withdraw section tags.

- [ ] **Step 5: Update `app/src/balance-page.ts`**
  - Import `renderLed` from `./fleet/led.js` and `countTo` from `./fleet/motion.js`. Add `balanceDelta`, `capShare` and `TRADER_CAP` to the `./fleet/balance.js` import.
  - Replace `renderFigures` with:

```ts
let shownAvailable: string | undefined;

const renderFigures = (view: BalanceState): void => {
  const host = el("balance-available");
  const to = Number(toEth(view.available));
  const from = shownAvailable === undefined ? to : Number(toEth(shownAvailable));
  countTo((value) => renderLed(host, value.toFixed(4), "ETH"), from, to);
  const delta = balanceDelta(shownAvailable, view.available);
  const deltaNode = el("balance-delta");
  deltaNode.hidden = delta === undefined;
  if (delta) {
    deltaNode.textContent = `${delta.up ? "▲" : "▼"} ${delta.eth}`;
    deltaNode.dataset["up"] = String(delta.up);
  }
  shownAvailable = view.available;

  const used = capShare(view.headroom.perTraderRemaining, TRADER_CAP);
  el("headroom-fill").style.setProperty("--fill", String(used));
  el("headroom-meter").setAttribute("aria-valuenow", String(used));
  el("headroom-note").textContent = `${toEth((BigInt(TRADER_CAP) - BigInt(view.headroom.perTraderRemaining)).toString())} of 0.5 ETH held`;

  el("balance-draws").textContent = `${toEth(view.openDraws)} ETH`;
  el("balance-deposited").textContent = `${toEth(view.deposited)} ETH`;
  el("balance-spent").textContent = `${toEth(view.spent)} ETH`;
};
```

  - The only `readBalance(` call is in `load` (around line 154). Replace `load` with this version, which marks `#balance` busy only while the read is in flight:

```ts
const load = async (force: boolean): Promise<void> => {
  if (!wallet) return;
  void renderWalletEth();
  el("balance").setAttribute("aria-busy", "true");
  try {
    state = await readBalance(wallet, { force });
  } finally {
    el("balance").removeAttribute("aria-busy");
  }
  poolAddress = (state.poolAddress as Hex | undefined) ?? poolAddress;
  render(state);
};
```

- [ ] **Step 6: Append to `app/styles/pages.css`**

```css
/* ---- Balance ---- */
#balance .summary.grid > div:first-child { grid-column: 1 / -1; }
#balance .summary.grid > div:first-child > dd:first-of-type { font-size: clamp(2.25rem, 7vw, 3.5rem); }
.delta { margin: 0.35rem 0 0; color: var(--text-muted); font-size: 0.85rem; }
.delta[data-up="true"] { color: var(--coral); }
@keyframes delta-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: no-preference) {
  .delta:not([hidden]) { animation: delta-in 400ms var(--ease-out); }
}
#headroom-meter { margin-top: 1.25rem; }
.limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; margin-block: 1.25rem; }
.limit { display: grid; align-content: space-between; gap: 0.5rem; min-height: 12rem; margin: 0; }
.limit__figure { margin: 0.5rem 0; font-size: 2.25rem; }
.limit__note { margin: 0; font-size: 0.85rem; line-height: 1.45; }
.callout { margin: 0 0 1rem; padding: 0.8rem 1rem; border: 1px solid rgba(245, 239, 229, 0.18); border-radius: var(--radius-control); background: rgba(122, 36, 21, 0.35); color: var(--paper); font-size: 0.9rem; line-height: 1.45; }
.withdraw-form { display: grid; gap: 0.25rem; }
```

- [ ] **Step 7: Run everything and look at it.** Run: `npm --prefix app run verify`. Expected: all pass, including the existing `fleet-balance.test.ts` pins. Restart `npm run dev:local`, open http://localhost:3000/app/balance.html, and connect MetaMask. The balance should draw in LED dots and count up.

- [ ] **Step 8: Commit** (≤ 200 lines; split HTML+CSS from TS if over). `git add app && git commit -m "feat(app): Balance page on the landing's look"`

---

### Task 11: The setup wizard

**Files:**
- Modify: `app/fleet.html`, `app/src/fleet-page.ts`, `app/src/fleet/balance.ts`, `app/styles/pages.css`, and `app/fleet.css` (delete the legacy `.dots` rules)
- Test: `app/test/app-figures.test.ts`, `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `prefersReducedMotion` from Task 9; `DRAW_CAP` and `parseEth` (existing)
- Produces:
  - `export const drawShare: (amount: string) => number`, the draw against `DRAW_CAP` (0..1, clamped)
  - `export const fundingProgress: (dueAt: string, now: Date, windowMs?: number) => number`, the share of the 15-minute funding window already elapsed (0..1)

- [ ] **Step 1: Append the failing tests**

To `app/test/app-figures.test.ts`, add `drawShare`, `fundingProgress` and `DRAW_CAP` to the `balance.js` import, then append:

```ts
test("the funding gauge measures the wait against its 15-minute ceiling", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  assert.equal(fundingProgress("2026-09-14T12:15:00Z", now), 0);
  assert.equal(fundingProgress("2026-09-14T12:07:30Z", now), 0.5);
  assert.equal(fundingProgress("2026-09-14T11:59:00Z", now), 1);
  assert.equal(fundingProgress("not a date", now), 0);
});

test("the draw meter fills against the 0.2 ETH cap and stops there", () => {
  assert.equal(drawShare("20000000000000000"), 0.1);
  assert.equal(drawShare(DRAW_CAP), 1);
  assert.equal(drawShare("300000000000000000"), 1);
});
```

To `app/test/app-look.test.ts`:

```ts
test("the wizard's progress is a labelled rail above the steps, with a draw meter and a funding gauge", async () => {
  const html = await read("fleet.html");
  const rail = html.indexOf('<ol class="dots" id="dots"');
  assert.ok(rail > 0 && rail < html.indexOf('data-wstep="welcome"'), "the rail sits below the steps");
  for (const label of ["Start", "Connect", "Size", "Backup", "Launch"]) assert.match(html, new RegExp(`<span>${label}</span>`));
  assert.match(html, /id="draw-meter" role="meter"/);
  assert.match(html, /id="funding-gauge"/);
  assert.doesNotMatch(html, /seam-card/, "the backup still uses the old seam card");
});
```

- [ ] **Step 2: Run the tests and confirm they fail; commit the red tests.** `git add app/test && git commit -m "test(app): wizard rail, draw meter, funding gauge"`

- [ ] **Step 3: Add the figures to `app/src/fleet/balance.ts`** (append):

```ts
/** How much of the per-fleet draw cap an amount uses, 0..1. */
export const drawShare = (amount: string): number => {
  const cap = BigInt(DRAW_CAP);
  const value = BigInt(amount);
  return value >= cap ? 1 : Number((value * 10_000n) / cap) / 10_000;
};

/** How far through the funding wait we are, 0..1, measured against its 15-minute ceiling. */
export const fundingProgress = (dueAt: string, now: Date, windowMs = 15 * 60_000): number => {
  const remaining = Date.parse(dueAt) - now.getTime();
  if (Number.isNaN(remaining)) return 0;
  return Math.min(1, Math.max(0, 1 - remaining / windowMs));
};
```

- [ ] **Step 4: Update `app/fleet.html`**
  - Move the whole `<ol class="dots" id="dots" aria-label="Setup progress"> … </ol>` from below the launch step to directly after `<div id="status-banner" …></div>`, and give each item a label:

```html
        <ol class="dots" id="dots" aria-label="Setup progress">
          <li data-dot="welcome" aria-current="step"><span>Start</span></li>
          <li data-dot="connect"><span>Connect</span></li>
          <li data-dot="size"><span>Size</span></li>
          <li data-dot="backup"><span>Backup</span></li>
          <li data-dot="launch"><span>Launch</span></li>
        </ol>
```

  - In the backup step, replace the wrapper `<div class="seam-card"><div class="seam-edge" aria-hidden="true"></div><div class="seam-inner"> … </div></div>` with `<div class="card-glass backup-card"> … </div>`. Keep everything inside it: the buttons, `#vault-line`, `#vault-warn` and `#confirm-line`.
  - In the launch step, directly after the `#a-draw` input, add:

```html
            <div class="meter" id="draw-meter" role="meter" aria-label="This draw against the 0.2 ETH cap" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><span class="meter__fill" id="draw-fill"></span></div>
```

  - Directly above `<p id="funding-wait" …>`, add:

```html
          <div class="gauge" id="funding-gauge" hidden aria-hidden="true">
            <svg viewBox="0 0 120 66"><path class="gauge__track" d="M10 60 A50 50 0 0 1 110 60" /><line class="gauge__needle" id="funding-needle" x1="60" y1="60" x2="60" y2="16" /></svg>
          </div>
```

- [ ] **Step 5: Update `app/src/fleet-page.ts`**
  - Add `drawShare` and `fundingProgress` to the `./fleet/balance.js` import, and add `import { prefersReducedMotion } from "./fleet/motion.js";`.
  - At the end of `#renderLaunch()`, after `note.textContent = state.note;`, add:

```ts
    let share = 0;
    try {
      share = drawShare(parseEth(input.value));
    } catch {
      share = 0;
    }
    el("draw-fill").style.setProperty("--fill", String(share));
    el("draw-meter").setAttribute("aria-valuenow", String(share));
```

  - Add this method to the wizard class. The needle turns in real time through the wait, using a transform-only transition that runs until the due time. Under reduced motion it just sits at the current point.

```ts
  #showFunding(dueAt: string | undefined): void {
    const gauge = el("funding-gauge");
    gauge.hidden = dueAt === undefined;
    if (!dueAt) return;
    const needle = el("funding-needle");
    const now = new Date();
    needle.style.transition = "none";
    needle.style.setProperty("--p", String(fundingProgress(dueAt, now)));
    if (prefersReducedMotion()) return;
    const remaining = Math.max(0, Date.parse(dueAt) - now.getTime());
    void needle.getBoundingClientRect();
    needle.style.transition = `transform ${remaining}ms linear`;
    needle.style.setProperty("--p", "1");
  }
```

  - Next to each line that sets `el("funding-wait").textContent = fundingWait(<due>, new Date()).message;` (there are two, around lines 351 and 388), add `this.#showFunding(<due>);`, passing the same due value. Next to `el("funding-wait").textContent = "Your fleet is funded and live.";`, add `this.#showFunding(undefined);`.

- [ ] **Step 6: Append to `app/styles/pages.css`**

```css
/* ---- Setup wizard ---- */
.dots { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.5rem; margin: 0 0 1.5rem; padding: 0; list-style: none; counter-reset: step; }
.dots li { padding-top: 0.6rem; border-top: 2px solid rgba(245, 239, 229, 0.16); color: var(--text-muted); counter-increment: step; font-size: 0.72rem; letter-spacing: var(--track-wide); text-transform: uppercase; }
.dots li::before { content: counter(step, decimal-leading-zero) " "; font-family: var(--font-mono); }
.dots li[data-done="true"], .dots li[aria-current="step"] { border-top-color: var(--coral); color: var(--paper); }
.backup-card { border-color: rgba(245, 239, 229, 0.28); }
#draw-meter { margin-top: 0.5rem; }
.gauge { width: min(14rem, 100%); margin: 1rem 0 0.5rem; }
.gauge svg { display: block; width: 100%; height: auto; }
.gauge__track { fill: none; stroke: rgba(245, 239, 229, 0.12); stroke-width: 6; stroke-linecap: round; }
.gauge__needle { stroke: var(--coral); stroke-width: 3; stroke-linecap: round; transform: rotate(calc(-90deg + var(--p, 0) * 180deg)); transform-box: view-box; transform-origin: 60px 60px; }
@keyframes step-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: no-preference) {
  #wizard .wstep:not([hidden]) { animation: step-in 360ms var(--ease-out); }
}
@media (max-width: 520px) {
  .dots li span { display: none; }
}
```

- [ ] **Step 7: Delete the legacy rules.** In `app/fleet.css`, delete every legacy rule whose selector starts with `.dots`.

- [ ] **Step 8: Run everything, then commit** (≤ 200 lines). Run `npm --prefix app run verify` and expect all pass, including `fleet-activate-draw` and the wiring pins. Then `git add app && git commit -m "feat(app): wizard rail, draw meter and live funding gauge"`

---

### Task 12: Control Room

**Files:**
- Modify: `app/src/fleet/control-room.ts`, `app/src/fleet/page-shared.ts` (add `confirmDialog`), `app/src/fleet-dashboard.ts`, `app/fleet-dashboard.html`, `app/styles/pages.css`, and `app/fleet.css` (delete the legacy dashboard rules)
- Test: `app/test/app-figures.test.ts`, `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `ControlAction` (existing, `control-room.ts:37`); `stateLabel` (existing, `balance.ts`)
- Produces:
  - `export const confirmationFor: (action: ControlAction) => { title: string; body: string; confirm: string } | undefined`
  - `export const isLiveState: (state: string) => boolean`
  - `export const confirmDialog: (copy: { title: string; body: string; confirm: string }) => Promise<boolean>`, which resolves true only on the confirm button; Escape and "Keep it" resolve false

- [ ] **Step 1: Append the failing tests**

In `app/test/app-figures.test.ts`, add `import { confirmationFor, isLiveState } from "../src/fleet/control-room.js";` and append:

```ts
test("only actions that cannot be undone ask for confirmation", () => {
  assert.ok(confirmationFor("revoke"));
  assert.ok(confirmationFor("close"));
  for (const action of ["pause", "resume", "topUp"] as const) assert.equal(confirmationFor(action), undefined);
  assert.match(confirmationFor("revoke")!.body, /cannot be resumed/);
});

test("only a running or funding fleet carries the live dot", () => {
  assert.equal(isLiveState("Active"), true);
  assert.equal(isLiveState("Activating"), true);
  for (const state of ["Paused", "Revoked", "Closed", "Depleted", "Expired", "Pending service"]) assert.equal(isLiveState(state), false);
});
```

In `app/test/app-look.test.ts`:

```ts
test("the Control Room asks before anything that cannot be undone", async () => {
  const script = await read("src/fleet-dashboard.ts");
  const control = /async #control\([\s\S]*?\n  \}/.exec(script);
  assert.ok(control, "no #control");
  assert.match(control[0], /confirmationFor\(action\)[\s\S]*?await confirmDialog\(/, "revoke and close run without asking");
  assert.ok(control[0].indexOf("confirmDialog(") < control[0].indexOf("signedFleetApi("), "it signs before asking");
  assert.match(script, /dataset\["live"\] = String\(isLiveState\(/, "the state chip never shows it is live");
  assert.match(script, /renderLed\(el\("draw-remaining"\)/, "the draw figures are not LED figures");
  assert.match(await read("fleet-dashboard.html"), /<section id="balance-strip" class="dash-card card-glass"/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail; commit the red tests.** `git add app/test && git commit -m "test(app): Control Room confirms revoke and close; live chips"`

- [ ] **Step 3: Add to `app/src/fleet/control-room.ts`** (append):

```ts
/** Actions that cannot be taken back ask first; the rest just happen. */
export const confirmationFor = (action: ControlAction): { title: string; body: string; confirm: string } | undefined =>
  action === "revoke"
    ? { title: "Stop this fleet for good?", body: "Sponsorship ends now and cannot be resumed. Close is the only action left afterwards.", confirm: "Stop for good" }
    : action === "close"
      ? { title: "Close this fleet?", body: "Whatever it did not spend goes back to your Chit balance.", confirm: "Close fleet" }
      : undefined;

/** States with something happening right now, which earn the live dot. */
export const isLiveState = (state: string): boolean => state === "Active" || state === "Activating";
```

- [ ] **Step 4: Add `confirmDialog` to `app/src/fleet/page-shared.ts`** (append):

```ts
/** A glass dialog for a decision that cannot be undone. Resolves true only on the explicit confirm button. */
export const confirmDialog = (copy: { title: string; body: string; confirm: string }): Promise<boolean> =>
  new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("aria-label", copy.title);
    const heading = document.createElement("h2");
    heading.textContent = copy.title;
    const body = document.createElement("p");
    body.textContent = copy.body;
    const actions = document.createElement("div");
    actions.className = "wnav";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "ghost";
    keep.textContent = "Keep it";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary";
    confirm.textContent = copy.confirm;
    let answered = false;
    const finish = (yes: boolean): void => {
      if (answered) return;
      answered = true;
      dialog.close();
      dialog.remove();
      resolve(yes);
    };
    keep.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("close", () => finish(false));
    actions.append(keep, confirm);
    dialog.append(heading, body, actions);
    document.body.append(dialog);
    dialog.showModal();
    keep.focus();
  });
```

- [ ] **Step 5: Update `app/src/fleet-dashboard.ts`**
  - Add `confirmationFor` and `isLiveState` to the `./fleet/control-room.js` import, add `confirmDialog` to the `./fleet/page-shared.js` import, and import `stateLabel` from `./fleet/balance.js`.
  - In `async #control(action)`, directly after `if (action === "topUp") return this.#topUp();`, add:

```ts
    const question = confirmationFor(action);
    if (question && !(await confirmDialog(question))) return;
```

  - In `#render()`, replace `chip.textContent = this.#snapshot.state;` with:

```ts
    chip.textContent = stateLabel(this.#snapshot.state);
    chip.dataset["live"] = String(isLiveState(this.#snapshot.state));
```

  - Add `import { renderLed } from "./fleet/led.js";`. In `#render()`, replace the four `el("bal-available")` / `el("draw-amount")` / `el("draw-spent")` / `el("draw-remaining")` `.textContent = …` lines inside `if (this.#draw) { … }` with:

```ts
      renderLed(el("bal-available"), toEth(this.#available), "ETH");
      renderLed(el("draw-amount"), toEth(this.#draw.amount), "ETH");
      renderLed(el("draw-spent"), toEth(this.#draw.spent), "ETH");
      renderLed(el("draw-remaining"), toEth(this.#draw.remaining), "ETH");
```

- [ ] **Step 6: Update `app/fleet-dashboard.html`.** Change the strip's opening tag to `<section id="balance-strip" class="dash-card card-glass" aria-label="Your Chit balance and this fleet's draw" hidden>` (the `<dl class="summary grid">` inside it stays). Add `class="wstep empty-state"` to `#no-fleet`, replacing `class="wstep"`. Add `data-reveal` to the three `.dash-card` blocks inside `#fleet-view`.

- [ ] **Step 7: Append to `app/styles/pages.css`**

```css
/* ---- Control Room ---- */
#fleet-view { display: grid; gap: 0.25rem; }
.dash-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
.dash-head h1 { margin: 0; }
.state-note { margin: 0.25rem 0 0; color: var(--text-muted); }
.empty-state { text-align: center; }
.budget-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin: 1rem 0 0; }
.budget-grid dt { color: var(--text-muted); font-size: 0.7rem; letter-spacing: var(--track-wide); text-transform: uppercase; }
.budget-grid dd { margin: 0.25rem 0 0; font-family: var(--font-metric); font-size: 1.15rem; }
.returned { margin: 0.75rem 0 0; color: var(--soft-paper); }
.control-list { display: grid; gap: 0.5rem; }
.control-list button { display: grid; gap: 0.2rem; padding: 0.9rem 1rem; border: 1px solid rgba(245, 239, 229, 0.1); border-radius: var(--radius-control); background: rgba(0, 0, 0, 0.25); color: var(--paper); text-align: left; }
.control-list button span { color: var(--text-muted); font-size: 0.85rem; }
.control-list button[data-action="revoke"] { border-color: rgba(122, 36, 21, 0.9); }
.account-list { display: grid; gap: 0.4rem; margin: 0.75rem 0 1rem; padding: 0; list-style: none; }
.account-list li { overflow: hidden; padding: 0.6rem 0.8rem; border-radius: var(--radius-control); background: rgba(0, 0, 0, 0.25); font-family: var(--font-mono); font-size: 0.82rem; text-overflow: ellipsis; }
.buy-report { width: 100%; margin-top: 1rem; border-collapse: collapse; font-size: 0.85rem; }
.buy-report th, .buy-report td { padding: 0.5rem 0.4rem; border-bottom: 1px solid rgba(245, 239, 229, 0.08); text-align: left; }
.buy-report th { color: var(--text-muted); font-weight: 500; }
@media (hover: hover) and (pointer: fine) {
  .control-list button:not(:disabled):hover { border-color: rgba(245, 239, 229, 0.32); }
}
```

- [ ] **Step 8: Delete the legacy rules.** In `app/fleet.css`, delete every legacy rule whose selector starts with `#fleet-view`, `.dash-head`, `.state-note`, `.budget-grid`, `.returned`, `.control-list`, `.account-list`, `.buy-report`.

- [ ] **Step 9: Run everything, then commit** (≤ 200 lines; split TS from CSS if over). Run `npm --prefix app run verify` and expect all pass. Then `git add app && git commit -m "feat(app): Control Room on the landing's look; revoke and close confirm first"`

---

### Task 13: The Boundary page

**Files:**
- Modify: `app/fleet-privacy.html`, `app/styles/pages.css`, and `app/fleet.css` (delete the legacy privacy and seam rules)
- Test: `app/test/app-look.test.ts` (append)

**Interfaces:**
- Consumes: `.card-glass` and `.card-solid` from Task 7. Keeps the ids `public-facts`, `private-fact`, `privacy-claim`, `pool-claim` and `exclusions`, which `fleet-privacy.ts` fills.

- [ ] **Step 1: Append the failing test**

```ts
test("the Boundary page sets its four blocks as glass and solid cards", async () => {
  const html = await read("fleet-privacy.html");
  assert.doesNotMatch(html, /seam-card|seam-edge|seam-inner/, "the old seam motif is still here");
  assert.match(html, /<section class="card-glass boundary-block held"[^>]*>\s*<h2>Kept off the chain<\/h2>/);
  for (const id of ["public-facts", "private-fact", "privacy-claim", "pool-claim", "exclusions"]) assert.match(html, new RegExp(`id="${id}"`));
});
```

- [ ] **Step 2: Run the test and confirm it fails; commit the red test.** `git add app/test/app-look.test.ts && git commit -m "test(app): Boundary blocks as glass and solid cards"`

- [ ] **Step 3: Update `app/fleet-privacy.html`.** Replace the whole `<div class="seam-card wide"> … </div>` block with the block below. Copy the four lines of the pool-claim `<p class="fineprint">` exactly, line breaks included, because the claims test checks each line separately.

```html
        <div class="boundary-grid">
          <section class="card-solid boundary-block" data-reveal>
            <h2>Everyone can see</h2>
            <ul id="public-facts"></ul>
          </section>
          <section class="card-glass boundary-block held" data-reveal>
            <h2>Kept off the chain</h2>
            <p id="private-fact"></p>
          </section>
          <section class="card-solid boundary-block" data-reveal>
            <h2>The fine print, said plainly</h2>
            <p id="privacy-claim"></p>
          </section>
          <section class="card-glass boundary-block" data-reveal>
            <h2>Once your fleet runs on the shared pool</h2>
            <p id="pool-claim"></p>
            <p class="fineprint">
              Private, not anonymous. We are not a mixer and we do not try to make you disappear.
              The public cannot join your wallet to your fleet; Chit's operator can, and we say so
              rather than hide it. The direction we are building toward is a key you hold, so you
              decide who gets to see what.
            </p>
          </section>
        </div>
```

- [ ] **Step 4: Append to `app/styles/pages.css`**

```css
/* ---- Boundary ---- */
main.privacy-page h1 { font-size: clamp(2.25rem, 6vw, 3.75rem); }
.boundary-grid { display: grid; gap: 1rem; margin-block: 1.5rem 2.5rem; }
.boundary-block { margin: 0; }
.boundary-block h2 { font-size: 1.25rem; }
.boundary-block ul { display: grid; gap: 0.5rem; margin: 0; padding-left: 1.1rem; color: var(--text-muted); line-height: 1.5; }
.boundary-block p { margin: 0 0 0.75rem; color: var(--text-muted); line-height: 1.55; }
.boundary-block.held p { color: var(--paper); font-size: 1.1rem; }
.ex-h { margin-top: 2.5rem; }
.exclusions { color: var(--text-muted); line-height: 1.6; }
@media (min-width: 760px) {
  .boundary-grid { grid-template-columns: 1fr 1fr; }
}
```

- [ ] **Step 5: Delete the legacy rules.** In `app/fleet.css`, delete every legacy rule whose selector starts with `.privacy-page`, `main.privacy-page`, `.seam-card`, `.seam-edge`, `.seam-inner`, `.boundary-`, `.ex-h`, `.exclusions`.

- [ ] **Step 6: Run everything, then commit** (≤ 200 lines). Run `npm --prefix app run verify` and expect all pass, including `fleet-claims.test.ts`. Then `git add app && git commit -m "feat(app): Boundary page in glass and solid cards"`

---

### Task 14: Retire the legacy layer

**Files:**
- Modify: `app/fleet.css`, and `app/styles/*.css` or the page markup (for any class the coverage test flags)
- Test: `app/test/app-look.test.ts` (append)

**Interfaces:**
- Produces: `fleet.css` becomes only `@layer tokens, components, pages;` and the three imports.

- [ ] **Step 1: Append the failing test**

```ts
test("the old stylesheet is gone and every class the pages use is styled", async () => {
  const manifest = await read("fleet.css");
  assert.doesNotMatch(manifest, /@layer legacy\s*\{/, "the legacy layer still holds rules");
  const styled = (await Promise.all(NEW_STYLES.map(read))).join("\n");
  const used = new Set<string>(["wallet-chooser", "wallet-chooser-list", "wallet-chooser-status", "wallet-chooser-cancel", "confirm-dialog", "led", "led__dots", "led__unit", "reveal-ready"]);
  for (const page of PAGES) {
    for (const [, list] of (await read(page)).matchAll(/class="([^"]+)"/g)) for (const name of list!.split(/\s+/)) used.add(name);
  }
  const unstyled = [...used].filter((name) => !new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(styled));
  assert.deepEqual(unstyled, [], "classes with no rule in the new layers");
});
```

- [ ] **Step 2: Run the test and confirm it fails; commit the red test.** Expected: FAIL, "the legacy layer still holds rules". Then `git add app/test/app-look.test.ts && git commit -m "test(app): the old stylesheet is retired and nothing is left unstyled"`

- [ ] **Step 3: Delete the legacy layer.**
  - Change the first line of `app/fleet.css` to `@layer tokens, components, pages;`.
  - Delete the migration comment, the `@layer legacy {` line, everything left inside it (the remaining `:root` tokens, `*, *::before`, and the two `@media (max-width` blocks), and its closing `}`.
  - Before deleting the `@media (max-width: 640px)` and `(max-width: 480px)` blocks, read them. If any rule in them still matters for a new-layer class, port it into `components.css` or `pages.css`. Otherwise drop it.
  - If this commit is over 200 lines, delete the block in two commits, running `npm --prefix app run verify` after each.

- [ ] **Step 4: Fix anything the coverage test lists.** For each class it reports, either add a rule for it in `components.css`/`pages.css`, or remove the class from the markup if it no longer does anything.

- [ ] **Step 5: Run everything, then commit.** Run `npm --prefix app run verify` and expect all pass. Then `git add app && git commit -m "style(app): retire the pre-redesign stylesheet"`

---

### Task 15: Visual check and log

**Files:**
- Create: `scripts/app-shots.mjs`, `app/evidence/*.png` (committed subset)
- Modify: `package.json` (add the `app:shots` script), `.gitignore`, `IMPLEMENTATION.md`

**Interfaces:**
- Consumes: the running local server at `http://localhost:3000`, and the Playwright root devDependency

- [ ] **Step 1: Install the prerequisites.** Run `npm ci` at the repo root, since Playwright arrived on `main` after the first install. Then run `npx playwright install chromium`, which downloads the browser into `~/Library/Caches/ms-playwright`, outside the repo.

- [ ] **Step 2: Create `scripts/app-shots.mjs`**

```js
// Renders every app page at the redesign's viewports and fails on horizontal
// overflow or console errors. Needs the local server (npm run dev:local) and
// Playwright's Chromium (npx playwright install chromium).
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3000/app/";
const OUT = new URL("../app/evidence/", import.meta.url);
const PAGES = ["balance", "fleet", "fleet-dashboard", "fleet-privacy"];
const VIEWPORTS = [
  { name: "1606", width: 1606, height: 1161 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 1180 },
  { name: "390", width: 390, height: 844 },
  { name: "320", width: 320, height: 640 },
  { name: "1440-reduced", width: 1440, height: 900, reducedMotion: "reduce" },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const failures = [];
for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: viewport.reducedMotion ?? "no-preference",
  });
  for (const page of PAGES) {
    const tab = await context.newPage();
    const errors = [];
    tab.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`${BASE}${page}.html`, { waitUntil: "networkidle" });
    await tab.waitForTimeout(1200);
    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await tab.screenshot({ path: new URL(`${page}-${viewport.name}.png`, OUT).pathname, fullPage: true });
    if (overflow > 0) failures.push(`${page} @ ${viewport.name}: ${overflow}px of horizontal overflow`);
    for (const error of errors) failures.push(`${page} @ ${viewport.name}: console error: ${error}`);
    await tab.close();
  }
  await context.close();
}
await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: ${PAGES.length} pages x ${VIEWPORTS.length} viewports, no overflow, no console errors`);
```

Add `"app:shots": "node scripts/app-shots.mjs"` to the root `package.json` `scripts`. Append these lines to `.gitignore`:

```
app/evidence/*
!app/evidence/*-1440.png
!app/evidence/*-390.png
```

- [ ] **Step 3: Run it.** Start `npm run dev:local` in one terminal. In another, run `npm run app:shots`. Expected: `ok: 4 pages x 6 viewports, no overflow, no console errors`. Fix any overflow or console error it reports at its cause, never by relaxing the script, then run it again. Open a few screenshots and compare them with the landing (`landing/evidence/desktop-1440.png`).

- [ ] **Step 4: Log it in `IMPLEMENTATION.md`.** Append:

```markdown
## App redesign, step 1: the landing's look, tuned for an app (2026-09-14)

The four app pages now wear the landing's look: ink surfaces, glass cards,
LED dot figures, pill tags, the landing's masthead and its motion rules. Design:
`design-app-redesign.md`; plan: `docs/superpowers/plans/2026-09-14-app-redesign-step1.md`.
This replaces the fleet pages' "Soft Receipt" styles and the older "Public Docket"
direction; journeys and screens from `design.md`/`design-stage2.md` are unchanged.

The old stylesheet was wrapped in a lowest-priority `legacy` cascade layer and
shrunk task by task as new `tokens`/`components`/`pages` layers replaced it, so
no page was ever unstyled and no commit passed 200 lines; it is now gone. The
app is dark-only like the landing. Coral marks only what is live or has
happened, and primary buttons are paper, as the landing's are: a test enforces
the coral rule. The status pill shows the pool's state only from the cached
balance read, so it never costs a signature and never asserts "live" unread.
Revoke and Close now confirm in a dialog first.

Evidence: `npm run app:shots` renders every page at 1606x1161, 1440x900,
1024x1180, 390x844, 320x640 and 1440x900 reduced-motion with no overflow and no
console errors; the 1440 and 390 shots are kept in `app/evidence/`. They show
the pages without a connected wallet; connected states were checked by hand.
```

- [ ] **Step 5: Run the gates.** Run each of these: `npm --prefix app run verify`, `(cd landing && npm run verify)`, `./verify.sh fleet-acceptance`, `./verify.sh fleet-buy`, `./verify.sh pool-balance`, `./verify.sh pool-fund`. Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/app-shots.mjs package.json .gitignore app/evidence IMPLEMENTATION.md
git commit -m "chore(app): render check at six viewports, evidence, and the log entry"
```

- [ ] **Step 7: Stop and report.** Summarise the branch for the user: commits, gate results, and where the screenshots are. **Do not push or open a PR** until the user says so.

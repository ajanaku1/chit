# STATE

Standing proposals and blockers that need a human decision. One entry per item.
`CLAUDE.md` requires a dependency to be proposed here and the work to stop until
the answer comes back. Nothing in this file has been acted on.

---

## OPEN — Dependency proposal: `playwright` (dev only)

**Raised** 2026-09-13 · **Status** awaiting decision · **Nothing installed**

### What it is

A browser that a script drives: it launches a real Chromium, Firefox or WebKit,
loads a URL, clicks, types, and captures screenshots or video. Apache-2.0,
maintained by Microsoft, `git+https://github.com/microsoft/playwright.git`.

### Why it is being asked for

Design work cannot currently be verified, only asserted. The landing proposal in
`proposals/landing-morph-2026-09-13/` has nine acceptance checks from its brief;
five of them say **"needs a human"** because there is no way to see the page
render. The same gap applies to `landing/` and to the Fleet app's responsive
behaviour.

What can be checked today: that CSS parses, that HTML tags balance, that JS
has no syntax error, that colour literals sit in the brand hue band. What
cannot: whether the layout is pixel-aligned at 1606×1161, whether anything
overflows at 390px, whether the morph reads correctly, whether reduced-motion
leaves the page readable.

This also unblocks the `e2e-runner` agent definition, which already names
Playwright as its preferred tool and currently has nothing to run.

### Exact ask

```
npm i -D playwright@1.63.0          # root devDependencies
npx playwright install chromium     # browsers, once, per machine
```

`playwright` only. **Not** `@playwright/test`. The repo already tests with
`node --test`; adding a second test runner would duplicate that infrastructure
for no gain. The screenshot API does not need the runner.

### Footprint, measured from the registry

| Package | Version | Unpacked | Dependencies |
|---|---|---|---|
| `playwright` | 1.63.0 | 5.09 MB | `playwright-core` only |
| `playwright-core` | 1.63.0 | 13.45 MB | **none** |

Two packages, 18.5 MB, **zero third-party transitive dependencies**. For
comparison, the repo's current root tree is 6 runtime and 7 dev dependencies.
`engines.node >= 20`; this repo is on Node 22, so it is compatible.

Browser binaries (~150 MB for Chromium) download separately into
`~/Library/Caches/ms-playwright`, outside the repo. They are not committed and
do not enter `node_modules`.

### The cost I want to flag

`vercel.json` runs `npm ci && npm --prefix app ci`, which installs
devDependencies. Left alone, **every production build would download ~150 MB of
browsers it never uses.** If this is accepted, it needs
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` set in the Vercel project environment at
the same time. That is a production env change, which `plan.md` also makes a
stop-and-ask, so the two decisions travel together.

It also adds entries to `package-lock.json`, which may push that commit past the
200-line limit. Say if you want the lockfile change committed separately.

### Alternatives considered

| Option | Verdict |
|---|---|
| **Do nothing; review by eye** | Free and immediate. Not reproducible, not repeatable per change, and every design claim stays unverified. Legitimate if design review stays a human-only step. |
| **A separate `package.json` under a tools directory** | Keeps it entirely out of the Vercel install path, so no env var needed. Costs a second lockfile to maintain. Viable if the env change is unwelcome. |
| **Global install, not in the repo** | No repo change at all, and no Vercel impact. Not pinned, not reproducible for the new developer, invisible to anyone cloning. |
| **Puppeteer** | Similar size, Chrome only, and it puts a browser download inside `node_modules` by default. Strictly worse here. |
| **`playwright-core` alone** | Drops the 5 MB wrapper but requires supplying browser binaries manually. Not worth the operational cost. |
| **The video toolkit's copy** | Checked: `~/.agents/toolkits/claude-code-video-toolkit` has no Playwright installed, and neither does the Python environment. |

### What it would be used for, concretely

1. Screenshot `proposals/landing-morph-2026-09-13/` at 1606×1161, 1180×1024,
   and 390×844, before and after the morph, and attach them to that proposal.
2. Close the five "needs a human" rows in its acceptance table, or report them
   failing with evidence.
3. Re-capture `landing/evidence/*.png`, which were taken by hand on 2026-08-31
   and predate several landing changes.
4. Give `verify.sh` the option of a real rendering check, if that is ever wanted.

It is a development tool only. It ships nothing to visitors and runs in no
request path.

### Rollback

`npm rm playwright`, delete `~/Library/Caches/ms-playwright`, unset the Vercel
env var. No source depends on it, so nothing else changes.

### Decision needed

Approve as proposed (root devDependency plus the Vercel env var), approve in the
separate-package-json form, or decline and keep design review manual.

---

## Note on this file's path

`CLAUDE.md` names `loop/memory/STATE.md` as where dependency proposals go. That
path did not exist in this repository, which uses `IMPLEMENTATION.md` as its
running log and the four build-contract files at the root. The path was created
rather than the proposal being filed somewhere else, because the law names it
specifically. Logged in `IMPLEMENTATION.md` under the same date.

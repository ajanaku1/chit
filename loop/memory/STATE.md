# STATE

Standing proposals and blockers that need a human decision. One entry per item.
`CLAUDE.md` requires a dependency to be proposed here and the work to stop until
the answer comes back. Each entry records its own status; nothing marked OPEN
has been acted on.

---

## ACCEPTED — Dependency: `playwright` (dev only)

**Raised** 2026-09-13 · **Approved** 2026-09-13 · **Installed** `playwright@^1.63.0`, root devDependencies

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

### The cost I flagged, and the correction

**The warning was wrong and no Vercel change is needed.** I said every
production build would pull ~150 MB of browsers, because `@playwright/test` and
older `playwright` releases carried a browser-downloading postinstall. Checked
after installing: at 1.63.0 both `playwright` and `playwright-core` declare
`"scripts": {}`. Nothing runs on install. Browsers arrive only from an explicit
`npx playwright install`, and land in `~/Library/Caches/ms-playwright`.

So the Vercel cost is 18.5 MB of extra install, not 150 MB of browsers, and
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is unnecessary. `vercel.json` is untouched.

It does add entries to `package-lock.json`, committed separately from the source
change.

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

`npm rm playwright` and delete `~/Library/Caches/ms-playwright`. No shipped
source imports it; only `proposals/landing-morph-2026-09-13/shots.mjs` uses it,
and that is a capture tool, not part of any build or test path.

### Outcome

Approved and installed. Chromium 153.0.8010.12 (94.3 MiB) fetched to the local
cache. First use found four layout defects in the landing proposal that static
checking could not see, including a 5px mobile overflow the brief forbids; all
four are fixed and the capture is committed as evidence.

---

## OPEN — Connect GitHub autodeploy once the app is complete

**Raised** 2026-09-13 · **Status** deliberately deferred · **Owner** founder

The `chit-tools` Vercel project is not connected to GitHub. Every release is a
deliberate `npx vercel --prod` from the repo root, and production deploys stay a
stop-and-ask under `plan.md`.

That is on purpose while only the landing page is public-facing. The Fleet app
under `/app` ships from the same repo and the same build output, so autodeploy
today would push half-finished app work to chit.tools on any commit to `main`.

**Do this when the whole app is complete:** `vercel git connect`, or connect the
repository from the Vercel dashboard, so pushes to the private repo's `main`
deploy on their own. Revisit the stop-and-ask in `plan.md` at the same time,
since it would no longer describe how releases happen.

Known side effect of the current arrangement: a live deployment has no git commit
behind it, so a rollback is redeploying an earlier deployment from the dashboard
rather than reverting here.

---

## Note on this file's path

`CLAUDE.md` names `loop/memory/STATE.md` as where dependency proposals go. That
path did not exist in this repository, which uses `IMPLEMENTATION.md` as its
running log and the four build-contract files at the root. The path was created
rather than the proposal being filed somewhere else, because the law names it
specifically. Logged in `IMPLEMENTATION.md` under the same date.

---

## 2026-09-16 — Chit Bot merged; dependencies that arrived with it

`feat/chit-bot` (13 commits, 238 tests green) and `fix/buyback-explorer-link`
were merged into `main` on request and pushed to `private`. The bot branch
brings two dependencies that were not proposed here first, because they came
in on the collaborator's branch rather than being added in this tree:

- `@resvg/resvg-js` (runtime) — renders the share card PNG in `src/fleet/bot-share.ts`.
- `@electric-sql/pglite` (dev) — the poll runner's on-disk store (`BOT_PGLITE_DIR`).

Filed here for the record; removing either means removing the feature it serves.

Still open before the bot is live on chit.tools: the five `BOT_*`/`TELEGRAM_*`
production env vars (none set yet; `DATABASE_URL` is), then
`scripts/bot-set-webhook.mjs` once, then `/setprivacy` disable in BotFather.

Buyback keeper: `buyback-keeper.yml` is on an hourly cron (`7 * * * *`), but
GitHub ran no scheduled instance between the 10:04 dispatch and 14:54 UTC, then
ran buy 2. That is GitHub's scheduler skipping slots on a fresh workflow, not
the script. A Vercel cron hitting a keeper route would be the reliable fix; it
needs `BUYBACK_KEEPER_KEY` in the Vercel environment, so it is proposed, not done.

---

## 2026-10-05 — Proposal: WalletConnect for phone browsers (not added)

The app connects only through an injected provider (EIP-6963, else
`window.ethereum`). Safari and Chrome on a phone have none, so the only way in
from a phone was to know to open app.chit.tools inside the wallet's own
browser. `feat/mobile-wallet` closes the dead end without a dependency: on a
phone, "no wallet" now opens a sheet of the wallet apps' universal links
(MetaMask, Coinbase Wallet, Trust Wallet, Phantom), each carrying the current
page, so the trader lands back on it inside the wallet's browser.

The full fix is WalletConnect, which lets a phone browser pair with any wallet
app directly and keeps the session across the app switch. It needs:

- `@reown/appkit` + `@reown/appkit-adapter-ethers` or the bare
  `@walletconnect/ethereum-provider` (smaller; it exposes an EIP-1193 provider
  that would slot into `walletProvider()` as one more `InstalledWallet`).
- A Reown Cloud project id (free), set as a public build-time constant.
- The Robinhood chain registered in the provider's chain list, as in
  `ensureRobinhoodTestnet`.

Proposed, not done: it is a new runtime dependency and a new external account.
If approved, the bare provider is the smaller change and keeps the chooser as it
is, with "WalletConnect" as one more row that shows a QR on desktop and opens
the wallet picker on a phone.

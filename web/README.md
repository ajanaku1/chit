# web: the site and the app, in Next.js

The landing (`/`, `/bot`, `/burn`) and the app (`/app/balance`, `/app/fleet`, `/app/trade`,
`/app/fleet-dashboard`, `/app/fleet-privacy`, `/app/sessions`) in one Next.js project.

The app's logic is not rewritten here: every app page imports its script from `../app/src`
(wallet, deposits, fleets, orders, sessions), the same code `app/test` covers. The pages'
markup comes from `../app/*.html` through `scripts/app-pages.mjs`, so every id the logic
looks up is where it expects it. After changing an app page's HTML, run it again:

    node scripts/app-pages.mjs

## Run it

    cd web
    npm install
    npm run dev        # http://localhost:3000

`FLEET_CHAIN_ID` (46630 or 4663) and the other `FLEET_*` variables pick the chain exactly as
`app/build.mjs` does (`app/chain-target.mjs`). `/api/fleet/*` and `/api/bot/*` are proxied to
`FLEET_API_ORIGIN` (https://chit.tools by default) until this project is deployed beside them.

## What the page says about its chain

`next.config.mjs` reads the chain from `app/chain-target.mjs` at build time and `components/chain.tsx`
renders it into the HTML: on the beta, the FR-006 strip before the masthead of every app page, the
statement beside the deposit amount and the gate's sentence; on every chain, its own draw cap. As
with `app/build.mjs`, none of it waits on a fetch.

## Tests

    npm test

builds both chains (`.next-test-4663`, `.next-test-46630`) and checks what each would serve: the
strip on every page on the beta and on none on testnet, the deposit notes, the caps, the two hosts
kept apart (as `app/test/two-hosts.test.ts` does for the old build), and every id `app/src` reads
on the page it was on in `app/*.html`. CI runs it in `verify`.

## Deploying

Not wired yet. To serve chit.tools from here, a Vercel project with root directory `web`
(it reads `../app`, so "include files outside the root directory" stays on), and the
`/api/*` functions kept where they are or moved in.

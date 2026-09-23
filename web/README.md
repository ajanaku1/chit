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

## Deploying

Not wired yet. To serve chit.tools from here, a Vercel project with root directory `web`
(it reads `../app`, so "include files outside the root directory" stays on), and the
`/api/*` functions kept where they are or moved in.

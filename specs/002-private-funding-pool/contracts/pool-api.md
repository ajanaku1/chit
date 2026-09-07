# Pool Service Interface Contract

Extends the Stage 1 Fleet API (`specs/001-fleet-mission/contracts/fleet-api.md`): same envelope, challenge, idempotency, redaction, and error table. New and changed actions:

| Route | Action | Signed | Request | Success | Errors |
|---|---|---|---|---|---|
| `POST /api/fleet/balance` | `balance` | yes | `{}` | `{ available, deposited, spent, openDraws, headroom: { sizes[], perTraderRemaining, poolRemaining }, exit: { requestedAt?, amount?, availableAt? }, pool: { paused } }` | 401, 503 |
| `POST /api/fleet/balance` | `withdraw` | yes | `{ amount, destination }` | `{ payoutTx, queuedSpendTx, available }` | 401, 409, 422 `budget_exceeded`, 503 |
| `POST /api/fleet/campaign` | `activate` | yes | `{ campaign, draw }` | `{ ...campaign, draw: { amount, dueAt, state: "Pending" } }`; state `Funding your fleet` | 401, 409, 422 `budget_exceeded` |
| `POST /api/fleet/campaign` | `topUp` | yes | `{ campaign, amount }` | `{ ...campaign, draw }` | 401, 409, 422 |
| `POST /api/fleet/buy` | `buy` | yes | as Stage 1 | per-account results with `principal`, `gas`, `draw` | as Stage 1 |
| `POST /api/fleet/control` | `close` | yes | `{ campaign }` | `{ ...campaign, creditedToBalance }` | as Stage 1 |
| `POST /api/fleet/sweep` | `sweep` | no (Vercel cron header or opportunistic internal call) | `{}` | `{ funded: [campaign...], posted: [id...] }` | 503 |

Rules: `withdraw` refuses `amount > available` and warns (not refuses) when `destination` equals the primary wallet via `warning: "destination_is_primary"`. `activate` refuses when the pool is paused (`409 state_invalid: pool_paused`). Every state-changing action performs a sweep of due draws first. Responses never include `ownerRef` or any depositor address other than the caller's.

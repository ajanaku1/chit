# Incidents

One file per pause, `incidents/<yyyy-mm-dd>-<trigger>.md`, written before the
admin unpauses. `scripts/fleet-resume-check.ts` reads the newest one and the
pool and refuses to say "resume" until every line below is true (FR-035):

```
trigger: charge-expired | exit-failed | depositor-loss
cause: what happened, in one paragraph
fixedIn: <commit>
test: <the name of the test that now covers it>
publishedAt: <where depositors were told: the group post, the page>
madeWholeBy: <the donate() transaction, when the pool was short>
```

The check also reads the pool: the identity must hold and the pool must
hold what it owes (`src/fleet/pool-solvency.ts`). Then, and only then, the
admin sends `setPaused(false)`.

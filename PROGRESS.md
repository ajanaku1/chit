# PROGRESS.md — how "how far along is Chit" is computed

The landing's **Launch app** and **Open the app** buttons open a sheet that says
how much of Chit is built. That sheet is not written by a person. It is
generated from the repo, on every push to `main`, by the rule on this page.
If you work on Chit, this is the one rule about progress you need to know:

> **Progress is read, never typed.** The only way to move the number is to
> move a fact the script reads.

## What counts

| Fact | Where it is read from | What it becomes |
|---|---|---|
| A task is done | `- [x] Txxx …` in `specs/*/tasks.md` | one of `tasks.done` |
| A task is open | `- [ ] Txxx …` in `specs/*/tasks.md` | one of `tasks.total`, listed under `specs[].open` |
| A phase | `## Phase N: …` headings in `tasks.md` | `specs[].phases[]` with its own done/total |
| A stage's status | the **Stages** table in `README.md` | `stages[]`, status text verbatim |
| The last change | `git log -1`, `git rev-list --count` | `commit`, `committedAt`, `commits` |

Nothing else counts. Not commits, not lines, not a test count, not a summary.

## Why the task list is trusted

The workspace laws say **done = the check passed**: a task's box is ticked only
when its `verify.sh` phase is green, never from someone's own assessment. So a
ticked box is already the strongest fact the repo has, and the sheet inherits
that discipline without adding a second bookkeeping system.

A stage with no spec yet (Stage 3) contributes no tasks. The percentage is of
the specced work, and the sheet says so.

## The chain

```
specs/*/tasks.md + README.md ──▶ scripts/progress.mjs ──▶ landing/public/progress.json
                                        │
        the Vercel build runs it (scripts/assemble-site.mjs), so the
        deployed file is computed from the deployed task lists
                                        │
        .github/workflows/verify.yml runs --check on every push and
        pull request, so the committed copy cannot lag the lists
                                        │
        api/progress.js serves the public mirror's copy from chit.tools
        (5 min edge cache) so no visitor's browser talks to GitHub
                                        │
        landing/public/main.js renders the sheet; falls back to the
        deploy's own progress.json when the API is unreachable
```

## Working with it

- Tick a task in `tasks.md` when its gate passes, then `npm run progress` and
  commit the file with the tick; `verify.yml` fails the push if you forget.
- Changed a task list and want to see it locally? `node scripts/progress.mjs`,
  then open the landing.
- `node scripts/progress.mjs --check` exits 1 if `progress.json` no longer
  matches the facts (timestamp and commit fields are ignored). The landing's
  test suite runs the same check.
- Never edit `landing/public/progress.json` by hand. The next build overwrites
  it, and the change it carried was not a fact.
- Adding a new spec under `specs/NNN-…/` with a `tasks.md` in the standard
  shape is picked up automatically. A new stage row in the README table is
  too.

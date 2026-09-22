#!/usr/bin/env bash
# Sync the public mirror (ajanaku1/chit-app) from the private build repo
# (Chit-org/chit-fleet), stripping everything that is not shippable.
#
# Run this after pushing to private. It re-filters the whole history, replays
# the mirror-only docs patch, and pushes.
#
# Why a re-filter is safe: git filter-branch is deterministic. A commit's SHA
# comes from its tree, parents, message and author/committer dates, and the
# filter preserves all of them. Commits processed on a previous run come out
# byte-identical, so only genuinely new commits are new. The contribution
# graph keeps its real dates.
#
# Usage:   ./mirror/sync-public.sh          # filter, verify, push
#          ./mirror/sync-public.sh --dry    # filter and verify, do not push

set -euo pipefail

# Overridable so the GitHub workflow can clone and push with its own tokens;
# by hand, the defaults use whatever credentials git already has.
PRIVATE_URL="${MIRROR_PRIVATE_URL:-https://github.com/Chit-org/chit-fleet.git}"
PUBLIC_URL="${MIRROR_PUBLIC_URL:-https://github.com/ajanaku1/chit-app.git}"
PUBLIC_DISPLAY="https://github.com/ajanaku1/chit-app.git"
BRANCH="main"

HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$HERE/0001-public-docs.patch"
WORK="$(mktemp -d)"
DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Paths that must never reach the public mirror. Keep this list in sync with
# the reasoning in the repo split: code ships, strategy and the build contract
# do not. `mirror` is here so this script does not publish itself.
# .github is stripped deliberately. The announce workflows run `on: push` to
# main and read TELEGRAM_* from repo secrets. Mirrored, they would fire on the
# public repo, which has no such secrets, and leave a failed red Action after
# every sync. They also describe internal comms, which is not public business.
#
# The mainnet-blockers reproductions are stripped for a different reason. Each
# one states, with file and line, a way the money path loses a trader's ETH
# before it is fixed. They belong in the private repo where CI runs them; they
# do not belong in a public one until the behaviour they describe is gone.
STRIP="marketing proposals specs .specify .agents .github loop reports submission mirror Goal.md plan.md prompt.md GO-LIVE.md feedback.md design.md design-stage2.md design-mainnet-beta.md design-app-redesign.md verify.sh \
test/fleet/mainnet-blockers.test.ts test/fleet/mainnet-blockers-m4c.test.ts \
test/fleet/FleetPoolMainnetBlockers.t.sol"

echo "==> cloning private"
git clone -q --single-branch --branch "$BRANCH" "$PRIVATE_URL" "$WORK/m"
cd "$WORK/m"
git remote remove origin

echo "==> filtering history"
# --msg-filter strips AI attribution from commit messages. It has to happen
# here rather than as a failed check later: a private commit that carries a
# Co-Authored-By line AND touches shipped code would otherwise block every
# future sync. sed is deterministic, so SHAs stay stable.
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --prune-empty \
  --index-filter "git rm -r --cached --ignore-unmatch -q $STRIP" \
  --msg-filter "sed -E '/^[[:space:]]*[Cc]o-[Aa]uthored-[Bb]y:.*([Cc]laude|[Aa]nthropic)/d; /^[[:space:]]*[Gg]enerated with \[?[Cc]laude/d'" \
  -- --all >/dev/null 2>&1

rm -rf .git/refs/original
git reflog expire --expire=now --all
git gc --prune=now -q

echo "==> replaying mirror docs patch"
# --committer-date-is-author-date keeps the replayed commit's SHA stable across
# runs. Without it git am stamps "now" as the committer date, so the tip commit
# would get a new SHA on every sync and churn the history for no reason.
git config user.name "$(git log -1 --format=%an)" >/dev/null
git config user.email "$(git log -1 --format=%ae)" >/dev/null
if ! git am -3 --quiet --committer-date-is-author-date "$PATCH"; then
  git am --abort 2>/dev/null || true
  echo "ERROR: the docs patch no longer applies. README.md or ONBOARDING.md"
  echo "       changed upstream in a way that conflicts. Re-create the patch:"
  echo "         1. fix the docs by hand in this tree: $WORK/m"
  echo "         2. git format-patch -1 HEAD --stdout > $PATCH"
  echo "       Nothing was pushed."
  exit 1
fi

echo "==> verifying no stripped path survived"
LEAK="$(git log --pretty=format: --name-only | sort -u | grep -vE '^$' \
  | grep -E '^(marketing|proposals|specs|\.specify|\.agents|loop|reports|submission|mirror)/|^(Goal|plan|prompt|GO-LIVE|feedback|design|design-stage2|design-mainnet-beta|design-app-redesign)\.md$|^verify\.sh$' || true)"
if [ -n "$LEAK" ]; then
  echo "ERROR: stripped paths present in filtered history:"
  echo "$LEAK"
  echo "Nothing was pushed."
  exit 1
fi

echo "==> verifying no key-shaped secrets"
SECRETS="$(git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(rest)' 2>/dev/null \
  | awk '$1=="blob"{print $2}' | git cat-file --batch 2>/dev/null \
  | grep -aoE 'sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}' \
  | sort -u || true)"
if [ -n "$SECRETS" ]; then
  echo "ERROR: key-shaped strings found in history:"
  echo "$SECRETS"
  echo "Nothing was pushed."
  exit 1
fi

echo "==> verifying the replayed commit is authored as the repo identity"
# GitHub builds the contributor list from commit emails. Replaying the patch
# under any other address silently adds a stranger to the public repo's
# contributors, which is how Yonkoo11 turned up once.
PATCH_AUTHOR="$(git log -1 --format='%ae')"
if [ "$PATCH_AUTHOR" != "mykdahunsi@gmail.com" ]; then
  echo "ERROR: replayed commit is authored by '$PATCH_AUTHOR', not mykdahunsi@gmail.com."
  echo "       Fix the 'From:' line in $PATCH. Nothing was pushed."
  exit 1
fi

echo "==> verifying no AI attribution in commit messages"
TRACES="$(git log --format='%H %s%n%b' \
  | grep -inE 'Co-Authored-By:.*(Claude|Anthropic)|Generated with Claude|Claude Code' || true)"
if [ -n "$TRACES" ]; then
  echo "ERROR: attribution traces in commit messages:"
  echo "$TRACES"
  echo "Nothing was pushed."
  exit 1
fi

echo "==> $(git rev-list --count HEAD) commits, $(git ls-tree -r --name-only HEAD | wc -l | tr -d ' ') files"

if [ "$DRY" = "1" ]; then
  echo "==> dry run, not pushing. Tree is at $WORK/m (removed on exit)."
  exit 0
fi

echo "==> pushing"
git remote add public "$PUBLIC_URL"
git push --force public "$BRANCH"
echo "==> done: $PUBLIC_DISPLAY"

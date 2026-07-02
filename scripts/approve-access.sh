#!/usr/bin/env bash
#
# Approve a keyring access-request PR (reviewer step). Given the PR number, this
# checks out its branch, re-encrypts the shared secrets to include the new
# recipient (`qar rekey`), pushes, and merges — the atomic "add a teammate" flow
# from CLAUDE.md, done in one command instead of five.
#
# You must ALREADY be a keyring recipient: rekey decrypts the existing secrets
# with YOUR identity before re-encrypting to everyone. A brand-new member can't
# approve their own request.
#
#   scripts/approve-access.sh 10
#   scripts/approve-access.sh 10 --no-merge      # rekey + push, but leave merging to you
#
# Honors QAR_REPO_DIR (the packaged app's clone) and QAR_BIN (the bundled engine);
# falls back to this checkout + `pnpm qar` for dev.
set -euo pipefail

PR=""
MERGE=1
for arg in "$@"; do
    case "$arg" in
        --no-merge) MERGE=0 ;;
        *) PR="$arg" ;;
    esac
done

if [[ -z "$PR" || ! "$PR" =~ ^[0-9]+$ ]]; then
    echo "usage: approve-access.sh <pr-number> [--no-merge]  (e.g. approve-access.sh 10)" >&2
    exit 1
fi

# Resolve repo root without hard-depending on BASH_SOURCE (unset under zsh).
if [[ -n "${BASH_SOURCE:-}" ]]; then
    SELF="${BASH_SOURCE[0]}"
else
    SELF="${0:-}"
fi
CHECKOUT="$(cd "$(dirname "$SELF")/.." && pwd)"

# The clone to operate on: the app's user-writable clone if set, else this checkout.
REPO="${QAR_REPO_DIR:-$CHECKOUT}"
# How to run the engine: the bundled node+bundle if the app exported it, else pnpm.
QAR="${QAR_BIN:-pnpm qar}"

cd "$REPO"

# Sanity-check we're in the qa-review repo (a keyring). Guards against running in
# the wrong dir — e.g. the dev checkout when you meant the app's clone (set
# QAR_REPO_DIR="$HOME/Library/Application Support/qa-runner/repo").
if [[ ! -f "config/keyring.json" ]]; then
    echo "error: $REPO doesn't look like the qa-review repo (no config/keyring.json)." >&2
    echo "       Set QAR_REPO_DIR to the clone that holds your identity." >&2
    exit 1
fi

# Refuse to clobber uncommitted work — rekey rewrites config/settings.secrets.json.
if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: working tree is dirty in $REPO — commit or discard changes first." >&2
    git status --short >&2
    exit 1
fi

BRANCH="$(gh pr view "$PR" --json headRefName --jq .headRefName)"
if [[ -z "$BRANCH" ]]; then
    echo "error: could not resolve the branch for PR #$PR (is gh authed?)." >&2
    exit 1
fi

echo "==> Approving PR #$PR (branch: $BRANCH) in $REPO" >&2
STARTING_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

git fetch origin --quiet
# The PR's remote branch is authoritative — check it out and hard-reset the local
# branch to match. A plain `pull --ff-only` aborts if a stale local branch of the
# same name has diverged (e.g. left over from an earlier request-access attempt).
git checkout -B "$BRANCH" "origin/$BRANCH" --quiet

# Re-encrypt every secret to the keyring on this branch (now including the new
# recipient) and refresh keyring.lock. QAR may be "pnpm qar" (two words), so it
# must stay unquoted for word-splitting.
echo "==> Rekeying secrets to the updated keyring..." >&2
QAR_REPO_DIR="$REPO" $QAR rekey 1>&2

if git diff --quiet; then
    echo "==> Nothing to rekey (secrets already encrypted to this keyring)." >&2
else
    git commit -am "Rekey secrets for new recipient (approve #$PR)" --quiet
    git push --quiet
fi

if [[ "$MERGE" == "1" ]]; then
    echo "==> Merging PR #${PR}..." >&2
    gh pr merge "$PR" --squash --delete-branch 1>&2
    # Land on a real branch and pull the merge so the local clone reflects it.
    git checkout main --quiet 2>/dev/null || git checkout "$STARTING_BRANCH" --quiet
    git pull --ff-only --quiet 2>/dev/null || true
    echo "Approved and merged PR #$PR." >&2
else
    echo "Rekeyed and pushed branch $BRANCH. Merge PR #$PR when ready." >&2
fi

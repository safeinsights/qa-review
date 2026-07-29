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
# Honors QAR_REPO_DIR (the packaged app's clone), falling back to this checkout. How
# to RUN the engine is delegated to the `bin/qar` shim rather than decided here.
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
# How to run the engine is the shim's problem, not ours: it already picks between
# $QAR_BIN, `pnpm qar`, and an installed .app's bundle, and it knows the cases where
# `pnpm qar` looks available but cannot work. Duplicating a "${QAR_BIN:-pnpm qar}"
# guess here is what made this script fail in the packaged app's own clone.
QAR="$CHECKOUT/bin/qar"

cd "$REPO"

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
git checkout "$BRANCH" --quiet
git pull --ff-only --quiet

# Re-encrypt every secret to the keyring on this branch (now including the new
# recipient) and refresh keyring.lock. QAR is a single executable path, so it is
# QUOTED, not eval'd: this repo's own path contains spaces ("…/Application Support/…"),
# and the eval this line used to need — for a multi-token "${QAR_BIN:-pnpm qar}" —
# would now split that path apart. Scoped to a subshell so the exported QAR_REPO_DIR
# doesn't leak into the rest of the script; the shim defers to it.
echo "==> Rekeying secrets to the updated keyring..." >&2
(
    export QAR_REPO_DIR="$REPO"
    "$QAR" rekey
) 1>&2

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

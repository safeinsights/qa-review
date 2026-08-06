#!/usr/bin/env bash
#
# Approve a keyring access-request PR (reviewer step). Given the PR number, this
# checks out its branch, re-encrypts the shared secrets to include the new
# recipient (`qar rekey`), pushes, approves, and merges — the atomic "add a
# teammate" flow from CLAUDE.md, done in one command instead of five.
#
# You must ALREADY be a keyring recipient: rekey decrypts the existing secrets
# with YOUR identity before re-encrypting to everyone. A brand-new member can't
# approve their own request.
#
# The approval is required by the org's `require-pr` ruleset (1 approving review on
# the default branch) and cannot be bypassed with admin rights. Since GitHub forbids
# self-approval, running this on a PR YOU opened still needs a second reviewer.
#
#   scripts/approve-access.sh 10
#   scripts/approve-access.sh 10 --no-merge      # rekey + push, but leave merging to you
#
# Honors QAR_REPO_DIR (the packaged app's clone), falling back to this checkout.
# The engine is invoked as a bare `qar`, letting bin/qar dispatch to the bundle or
# `pnpm qar` — so this script needs no knowledge of which one is in play.
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
# Run the engine through this checkout's shim, which resolves the bundle (packaged)
# or `pnpm qar` (dev) itself. Absolute, since this script cd's to $REPO below and
# that clone may predate the shim.
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
# recipient) and refresh keyring.lock.
echo "==> Rekeying secrets to the updated keyring..." >&2
QAR_REPO_DIR="$REPO" "$QAR" rekey 1>&2

if git diff --quiet; then
    echo "==> Nothing to rekey (secrets already encrypted to this keyring)." >&2
else
    git commit -am "Rekey secrets for new recipient (approve #$PR)" --quiet
    git push --quiet
fi

if [[ "$MERGE" == "1" ]]; then
    # The org-level `require-pr` ruleset requires 1 approving review on the default
    # branch, so a merge without one is refused ("base branch policy prohibits the
    # merge"). Approve first — but never let that abort the run (set -e is on):
    # GitHub REFUSES self-approval, so this legitimately fails when the reviewer is
    # also the requester. The merge below is the real gate; let IT report the problem.
    if [[ "$(gh pr view "$PR" --json reviewDecision --jq .reviewDecision)" == "APPROVED" ]]; then
        echo "==> PR #${PR} is already approved." >&2
    else
        echo "==> Approving PR #${PR}..." >&2
        gh pr review "$PR" --approve 1>&2 ||
            echo "warning: could not approve #$PR (GitHub forbids self-approval) — another reviewer must approve it." >&2
    fi

    echo "==> Merging PR #${PR}..." >&2
    gh pr merge "$PR" --squash --delete-branch 1>&2
    # Land on a real branch and pull the merge so the local clone reflects it.
    git checkout main --quiet 2>/dev/null || git checkout "$STARTING_BRANCH" --quiet
    git pull --ff-only --quiet 2>/dev/null || true
    echo "Approved and merged PR #$PR." >&2
else
    echo "Rekeyed and pushed branch $BRANCH. Merge PR #$PR when ready." >&2
fi

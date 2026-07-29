#!/usr/bin/env bash
#
# Revoke a user's keyring access. Given their name, this removes them from
# config/keyring.json, re-encrypts every secret to the REMAINING recipients
# (`qar rekey`), and opens a PR — the manual "revocation" flow from CLAUDE.md,
# done in one command instead of five.
#
# You must ALREADY be a keyring recipient: rekey decrypts the existing secrets
# with YOUR identity before re-encrypting to the survivors.
#
#   scripts/revoke-access.sh "Greg Fitch"
#   scripts/revoke-access.sh "Greg Fitch" --no-pr    # commit locally, don't push/PR
#   scripts/revoke-access.sh "Greg Fitch" --yes      # skip the confirmation prompt
#
# IMPORTANT — this is not retroactive. A revoked user keeps any secrets they
# already pulled, and old commits remain encrypted to their key. If the access
# was genuinely sensitive, ROTATE the credentials themselves (change the account
# passwords / MFA seeds, then `qar set-secret` each new value). Removing someone
# from the keyring alone is not containment.
#
# Honors QAR_REPO_DIR (the packaged app's clone), falling back to this checkout.
# The engine is invoked as a bare `qar` via bin/qar, which dispatches to the
# bundle (packaged) or `pnpm qar` (dev).
set -euo pipefail

NAME=""
OPEN_PR=1
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --no-pr) OPEN_PR=0 ;;
        --yes | -y) ASSUME_YES=1 ;;
        *) NAME="$arg" ;;
    esac
done

if [[ -z "$NAME" ]]; then
    echo 'usage: revoke-access.sh <name> [--no-pr] [--yes]  (e.g. revoke-access.sh "Greg Fitch")' >&2
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
# or `pnpm qar` (dev) itself. Absolute, since we cd to $REPO below and that clone
# may predate the shim.
QAR="$CHECKOUT/bin/qar"

cd "$REPO"

# Refuse to clobber uncommitted work — rekey rewrites config/settings.secrets.json.
if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: working tree is dirty in $REPO — commit or discard changes first." >&2
    git status --short >&2
    exit 1
fi

KEYRING="config/keyring.json"
[[ -f "$KEYRING" ]] || { echo "error: $KEYRING not found in $REPO" >&2; exit 1; }

# Start from an up-to-date main so we never revoke against a stale keyring (and so
# the PR branch doesn't carry unrelated drift).
git fetch origin --quiet
git checkout main --quiet
git pull --ff-only --quiet

# Preview the removal. Matching is case-insensitive on name, but the REMOVAL is by
# public key: a user with several entries (re-running request-access with different
# --name spellings appends duplicates rather than replacing) would otherwise keep
# working keys behind after "their" row was deleted.
PLAN="$(node -e '
const fs = require("fs")
const [file, name] = [process.argv[1], process.argv[2]]
const members = JSON.parse(fs.readFileSync(file, "utf8"))
const want = name.trim().toLowerCase()
const matched = members.filter(m => (m.name || "").trim().toLowerCase() === want)
const keys = new Set(matched.map(m => m.publicKey))
const removing = members.filter(m => keys.has(m.publicKey))
const keeping = members.filter(m => !keys.has(m.publicKey))
console.log(JSON.stringify({
    removing: removing.map(m => ({ name: m.name, email: m.email, publicKey: m.publicKey })),
    keeping: keeping.map(m => m.name),
    names: [...new Set(members.map(m => m.name))],
}))
' "$KEYRING" "$NAME")"

REMOVING_COUNT="$(node -e 'console.log(JSON.parse(process.argv[1]).removing.length)' "$PLAN")"

if [[ "$REMOVING_COUNT" == "0" ]]; then
    echo "error: no keyring entry named \"$NAME\"." >&2
    echo "Known names:" >&2
    node -e 'JSON.parse(process.argv[1]).names.forEach(n => console.error("  - " + n))' "$PLAN"
    exit 1
fi

# Revoking everyone would leave secrets encrypted to nobody — unrecoverable, since
# rekey needs a recipient to encrypt TO and an identity to decrypt WITH.
KEEPING_COUNT="$(node -e 'console.log(JSON.parse(process.argv[1]).keeping.length)' "$PLAN")"
if [[ "$KEEPING_COUNT" == "0" ]]; then
    echo "error: that would remove every recipient, leaving the secrets unrecoverable." >&2
    exit 1
fi

echo "==> Revoking from the keyring in $REPO:" >&2
node -e '
const p = JSON.parse(process.argv[1])
p.removing.forEach(m => console.error(`  - ${m.name} <${m.email}>  ${m.publicKey.slice(0, 20)}…`))
if (p.removing.length > 1) console.error(`  (${p.removing.length} entries share this key)`)
console.error(`  keeping ${p.keeping.length}: ${p.keeping.join(", ")}`)
' "$PLAN"

if [[ "$ASSUME_YES" != "1" ]]; then
    read -r -p "Proceed? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted." >&2; exit 1; }
fi

SLUG="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
BRANCH="revoke/$SLUG"
git checkout -b "$BRANCH" --quiet

# Write the keyring without the revoked entries, preserving the 2-space format the
# engine and Go GUI both write (a format change would show up as spurious diff noise).
node -e '
const fs = require("fs")
const [file, plan] = [process.argv[1], JSON.parse(process.argv[2])]
const drop = new Set(plan.removing.map(m => m.publicKey))
const members = JSON.parse(fs.readFileSync(file, "utf8")).filter(m => !drop.has(m.publicKey))
fs.writeFileSync(file, JSON.stringify(members, null, 2) + "\n")
' "$KEYRING" "$PLAN"

# Re-encrypt every secret to the remaining recipients and refresh keyring.lock.
echo "==> Rekeying secrets to the remaining recipients..." >&2
QAR_REPO_DIR="$REPO" "$QAR" rekey 1>&2

git commit -am "Revoke $NAME from the keyring" --quiet

if [[ "$OPEN_PR" != "1" ]]; then
    echo "Committed on $BRANCH (not pushed). Push and open a PR when ready." >&2
    exit 0
fi

git push -u origin "$BRANCH" --quiet
gh pr create --base main --title "Revoke $NAME from the keyring" --body "Removes $NAME from \`config/keyring.json\` and re-encrypts every secret to the remaining recipients.

**This is not retroactive.** $NAME keeps any secrets they already pulled, and old commits remain encrypted to their key. If this access was sensitive, rotate the credentials themselves (change the account passwords / MFA seeds, then \`qar set-secret\` each new value) — this PR alone is not containment.

After merging, everyone else runs \`qar sync\`; until they do, their \`keyring.lock\` shows drift." 1>&2

echo "Opened a revocation PR for $NAME. Merge it, then tell the team to run \`qar sync\`." >&2

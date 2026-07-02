#!/usr/bin/env bash
#
# Release build hook. Invoked by the external release tool with a single arg: the
# semver tag (e.g. "v1.2.10"). Builds the signed + notarized macOS .dmg and
# prints ONLY the path(s) to the artifact(s) to include in the release — one per
# line on stdout. All build progress/noise goes to stderr so stdout stays clean.
#
#   scripts/release.sh v1.2.10
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    echo "usage: release.sh <version>  (e.g. v1.2.10)" >&2
    exit 1
fi
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: version must look like v1.2.10, got: $VERSION" >&2
    exit 1
fi

# Resolve repo root without hard-depending on BASH_SOURCE — the array is unset
# under zsh, where `set -u` makes even indexing it fatal. Use it only when it
# exists (bash); otherwise fall back to $0.
if [[ -n "${BASH_SOURCE:-}" ]]; then
    SELF="${BASH_SOURCE[0]}"
else
    SELF="${0:-}"
fi
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
# The build emits the user-facing "SI QA Review.dmg"; the release artifact keeps a
# space-free, versioned name for a clean download URL.
DMG_SRC="$ROOT/gui/build/SI QA Review.dmg"
DMG_OUT="$ROOT/gui/build/SI-QA-Review-$VERSION.dmg"

# Build the signed + notarized .dmg. Redirect the whole pipeline to stderr so the
# only thing on stdout is the artifact path the release tool consumes.
make -C "$ROOT" dmg >&2

if [[ ! -f "$DMG_SRC" ]]; then
    echo "error: expected DMG not found: $DMG_SRC" >&2
    exit 1
fi

mv "$DMG_SRC" "$DMG_OUT"

# The artifact(s) to include in the release.
echo "$DMG_OUT"

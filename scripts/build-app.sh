#!/usr/bin/env bash
#
# Build a standalone, Developer-ID-signed, notarized macOS .dmg of the QA Runner.
#
# Pipeline: esbuild engine -> stage Resources (node + engine bundle + Playwright)
# -> wails build -> codesign (hardened runtime) -> notarize + staple -> .dmg.
#
# Prerequisites on the build host: pnpm, Go, wails, Xcode CLT (codesign,
# notarytool, stapler), and (for signing) a Developer ID Application cert in the
# keychain + a notarytool credential profile.
#
# Signing vars are loaded from .env at the repo root (gitignored).
# Add DEVELOPER_ID and NOTARY_PROFILE there, or export them in your shell.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- Load .env (signing + optional overrides) -----------------------------
ENV_FILE="$ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck source=/dev/null
    set -o allexport; source "$ENV_FILE"; set +o allexport
fi

# ---- Config ----------------------------------------------------------------
NODE_VERSION="${NODE_VERSION:-22.14.0}"          # pinned bundled node (LTS)
NODE_ARCH="${NODE_ARCH:-arm64}"                  # darwin-arm64 build
APP_NAME="qa-runner"                             # wails build output basename + executable
DISPLAY_NAME="SI QA Review"                      # user-facing name: the .app, .dmg, and volume

# SIGNING — set in .env or export before running:
#   DEVELOPER_ID:    "Developer ID Application: Your Org (TEAMID)"
#   NOTARY_PROFILE:  a notarytool keychain profile name created via
#                    `xcrun notarytool store-credentials`
DEVELOPER_ID="${DEVELOPER_ID:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
SIGN="${SIGN:-1}"                                 # set SIGN=0 to skip sign+notarize

if [[ "$SIGN" == "1" ]]; then
    [[ -n "$DEVELOPER_ID" ]]   || { echo "error: DEVELOPER_ID is not set (add it to .env)"; exit 1; }
    [[ -n "$NOTARY_PROFILE" ]] || { echo "error: NOTARY_PROFILE is not set (add it to .env)"; exit 1; }
fi

# ---- Paths -----------------------------------------------------------------
GUI="$ROOT/gui"
ENGINE_OUT="$GUI/build/engine"
STAGE="$GUI/build/stage"                          # Resources payload staged here
# wails build emits <outputfilename>.app; we rename it to the user-facing
# DISPLAY_NAME after building so the bundle, DMG, and /Applications entry all
# read "SI QA Review" (the executable inside stays $APP_NAME).
BUILT_APP="$GUI/build/bin/$APP_NAME.app"
APP="$GUI/build/bin/$DISPLAY_NAME.app"
RES="$APP/Contents/Resources"
ENTITLEMENTS="$GUI/build/darwin/entitlements.plist"
DMG="$GUI/build/$DISPLAY_NAME.dmg"
# Downloaded node binaries are cached here so repeat builds don't re-download.
NODE_CACHE="$GUI/build/node-cache"

echo "==> 1/7 install deps"
cd "$ROOT"
pnpm install --frozen-lockfile

echo "==> 2/7 bundle engine (esbuild)"
node "$ROOT/esbuild.config.mjs"

echo "==> 3/7 stage Resources payload"
rm -rf "$STAGE"
mkdir -p "$STAGE/runtime" "$STAGE/engine"
# 3a. engine bundle (the browser MCP config is generated per-session at runtime
#     by writeSessionMcpConfig, so nothing static to ship here).
cp "$ENGINE_OUT/qar.bundle.mjs" "$STAGE/engine/qar.bundle.mjs"
# 3b. pinned node runtime — cached in gui/build/node-cache to avoid re-downloading
#     on every build. Delete the cache entry to force a fresh download.
NODE_PKG="node-v$NODE_VERSION-darwin-$NODE_ARCH"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_PKG.tar.gz"
NODE_CACHED="$NODE_CACHE/$NODE_PKG/bin/node"
if [[ -x "$NODE_CACHED" ]]; then
    echo "    using cached node $NODE_VERSION ($NODE_CACHED)"
else
    echo "    downloading $NODE_URL"
    mkdir -p "$NODE_CACHE"
    TMP_NODE="$(mktemp -d)"
    curl -fsSL "$NODE_URL" -o "$TMP_NODE/node.tar.gz"
    tar -xzf "$TMP_NODE/node.tar.gz" -C "$NODE_CACHE"
    rm -rf "$TMP_NODE"
fi
cp "$NODE_CACHED" "$STAGE/runtime/node"
chmod +x "$STAGE/runtime/node"
TMP="$(mktemp -d)"
# 3c. Playwright node_modules (NON-symlinked, self-contained). pnpm's store is
#     symlinked, so do a throwaway npm install of just the pinned versions into a
#     temp dir and copy the resolved tree. channel:'chrome' needs the driver, not
#     the bundled browsers, so skip the browser download.
PW_VERSION="$(node -e "console.log(require('@playwright/test/package.json').version)")"
# tsx ships alongside Playwright so the packaged node can `--import tsx` and load
# the clone's .ts suites directly (no compile step). Suites load as raw .ts at
# runtime (not bundled), so their non-relative imports — @faker-js/faker — must be
# resolvable from this shipped node_modules via NODE_PATH too.
TSX_VERSION="$(node -e "console.log(require('tsx/package.json').version)")"
FAKER_VERSION="$(node -e "console.log(require('@faker-js/faker/package.json').version)")"
echo "    staging @playwright/test@$PW_VERSION + tsx@$TSX_VERSION + @faker-js/faker@$FAKER_VERSION (no browser download)"
mkdir -p "$TMP/pw" && cd "$TMP/pw"
npm init -y >/dev/null 2>&1
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund \
    "@playwright/test@$PW_VERSION" "tsx@$TSX_VERSION" "@faker-js/faker@$FAKER_VERSION" >/dev/null 2>&1
mkdir -p "$STAGE/engine/node_modules"
cp -R "$TMP/pw/node_modules/." "$STAGE/engine/node_modules/"
cd "$ROOT"
rm -rf "$TMP"

echo "==> 4/7 wails build"
cd "$GUI"
wails build -platform "darwin/$NODE_ARCH" -clean
# Rename the built bundle to the user-facing display name before staging/signing,
# so every downstream path ($APP/$RES) — payload copy, codesign, DMG — uses it.
rm -rf "$APP"
mv "$BUILT_APP" "$APP"
# Copy the staged payload into the freshly built .app.
mkdir -p "$RES/runtime" "$RES/engine"
cp -R "$STAGE/." "$RES/"

if [ "$SIGN" != "1" ]; then
    echo "==> SIGN=0 — leaving $APP unsigned (dev build). Done."
    exit 0
fi

echo "==> 5/7 codesign (inside-out, hardened runtime)"
# Sign nested Mach-O executables first (node + any Playwright .node/helpers),
# then the .app last. --options runtime enables the hardened runtime.
sign() { codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" --sign "$DEVELOPER_ID" "$1"; }

# Every nested Mach-O (node, *.node native addons, Playwright's node/ffmpeg).
while IFS= read -r f; do
    if file "$f" | grep -q "Mach-O"; then sign "$f"; fi
done < <(find "$RES" -type f \( -perm -u+x -o -name '*.node' \))
sign "$APP"

echo "==> 6/7 notarize + staple"
ZIP="$GUI/build/$DISPLAY_NAME.zip"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
rm -f "$ZIP"

echo "==> 7/7 build + sign + notarize .dmg"
rm -f "$DMG"
# create-dmg (brew install create-dmg) gives a /Applications symlink + layout.
if command -v create-dmg >/dev/null 2>&1; then
    create-dmg --volname "$DISPLAY_NAME" --app-drop-link 480 160 "$DMG" "$APP" || true
else
    /usr/bin/hdiutil create -volname "$DISPLAY_NAME" -srcfolder "$APP" -ov -format UDZO "$DMG"
fi
codesign --force --timestamp --sign "$DEVELOPER_ID" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"

echo "==> Done: $DMG"
echo "    Verify: spctl -a -vvv \"$APP\"  &&  stapler validate \"$DMG\""

# QA Runner build targets.
.PHONY: engine dmg dmg-unsigned test

# Bundle the TS engine to a single .mjs the packaged app runs (no tsx needed).
engine:
	node esbuild.config.mjs

# Build the standalone, signed, notarized macOS .dmg for staff download.
# Requires DEVELOPER_ID + NOTARY_PROFILE (see scripts/build-app.sh).
dmg:
	./scripts/build-app.sh

# Same pipeline but skip signing/notarization (local smoke test of the bundle).
dmg-unsigned:
	SIGN=0 ./scripts/build-app.sh

test:
	pnpm test && pnpm typecheck && cd gui && go test ./...

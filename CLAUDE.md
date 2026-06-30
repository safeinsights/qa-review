# otto — project notes

(Formerly `qatest`; the CLI command and package are now `otto`. The repo
directory is still named `qatest`.)

A QA runner for SafeInsights. A TypeScript engine uses Playwright to drive
Chromium through the suites (plain TS objects, not Playwright test files); a
Wails (Go + React/Vite) desktop GUI wraps it for "pick suite, press Run" use.

## Architecture (one-liners)

- `src/engine/` — the run engine. `runEngine()` is the entry; `env.ts` resolves
  envs; `suite-registry.ts` lists/loads suites.
- `src/suites/` — the actual suites (`signin`, `create-study`, plus discovered ones).
- `config/environments.ts` — declares STABLE envs (`qa`, `staging`) and derives PR
  preview URLs. **A PR run is identical to a QA run except for the base URL** —
  same accounts, same MFA. There is NO code that gates a suite to PR-only or
  QA-only. If a suite "runs on a PR but not on QA," the cause is environmental
  (data/secrets/org state), not suite selection.
- `src/engine/settings.ts` — the layered settings loader (replaces `.env`). See
  "Settings / configuration" below.
- `bin/otto.ts` — CLI: `run | login | cleanup | codegen | list | migrate`.
- `gui/` — Wails app. `gui/app.go` `RunProcess()` spawns `pnpm otto run ...`
  and streams JSON step lines back to the React UI. `gui/settings.go` reads/writes
  the settings files and holds the session age passphrase.

## Settings / configuration

Config no longer comes from `.env`. `src/engine/settings.ts` `loadSettings()`
merges three files under `config/` (lowest precedence first), then `process.env`
(so CI env vars still override anything):

1. `config/settings.json` — committed, plaintext. Non-secret values (base URLs).
2. `config/settings.secrets.json` — committed, but each secret value is an
   **age-encrypted** (passphrase/scrypt) armored blob. Holds the shared accounts'
   passwords + per-account MFA codes. Decrypted at load with `AGE_PASSPHRASE`.
3. `config/settings.local.json` — **gitignored** per-user overrides (plaintext).

Var names: base URLs (`QA_BASE_URL`, …) and, **per account**, `<ROLE>_EMAIL`,
`<ROLE>_PASSWORD`, `<ROLE>_MFA_CODE` (each account has its OWN second-factor code).
The engine reads a flat map via `resolveEnv()`. Secret var names (the `*_PASSWORD`s
and `*_MFA_CODE`s) are derived from `config/environments.ts` in `secretVarNames()`.

- **Unlock key**: secrets are decrypted with `AGE_PASSPHRASE`. The GUI Settings
  panel prompts for it once per session (`SetPassphrase`) and passes it to spawned
  runs via the child env. Standalone CLI reads `AGE_PASSPHRASE` from the
  environment.
- **Editing**: the GUI **Settings** tab edits any field and saves it as either
  "Project" (committed; secrets go encrypted into `settings.secrets.json`) or
  "Local" (gitignored override). Go does the encryption (`gui/settings.go`,
  `filippo.io/age`); the engine decrypts (`age-encryption` npm). The two interop —
  see `tests/engine/age-interop.test.ts`.
- **Migration**: `pnpm otto migrate` reads a legacy `.env` into
  `settings.local.json` (plaintext) so existing setups keep working.

## Running the GUI app in a browser (for debugging / driving headlessly)

The GUI is a native Wails desktop app, but `wails dev` also serves it over HTTP
so you can drive it in Chrome via the chrome-devtools MCP tools.

1. **Start it (sandbox MUST be disabled)** — `wails dev` runs `go mod tidy`,
   which writes to `~/Library/Caches/go-build`. Under the sandbox that fails with
   `operation not permitted`. Launch with the sandbox off, in the background:
   ```
   cd gui && nohup wails dev > "$TMPDIR/wails-dev.log" 2>&1 &
   ```
2. **Wait for ready** — poll `$TMPDIR/wails-dev.log` for `Using DevServer URL:
   http://localhost:34115`. The Vite frontend is on `:1420`; the
   browser-accessible app (Vite proxy + Go bridge) is on **`:34115`**. Verify:
   `lsof -nP -iTCP:34115 -sTCP:LISTEN` and `curl -s -o /dev/null -w '%{http_code}' http://localhost:34115/`.
3. **Drive it** — `mcp__chrome-devtools__new_page` → `http://localhost:34115/`,
   then `take_snapshot` / `take_screenshot` / `click`.
   - Mantine `<Select>` options render in a portal and often DON'T get a11y uids
     in the snapshot. To pick an option reliably, use `evaluate_script`:
     ```js
     () => { const el = [...document.querySelectorAll('[role="option"]')]
       .find(o => o.textContent.trim() === 'create-study'); el && el.click(); }
     ```
   - Selecting a suite auto-pins ROLE to the suite's declared role (label becomes
     "ROLE (FROM SUITE)") and locks it.
   - The harmless `runtime:ready -> Unknown message from front end` lines in the
     log are expected when running in Chrome (not the native webview); ignore them.

## Debugging "the run does nothing / no steps appear"

The GUI shows "No steps yet — press Run" and "No live session" even after Run,
and `gui/app.go` folds the engine's stderr into stdout where **stray
(non-JSON-step) lines are ignored by the parser** — so a fast engine crash is
SILENT in the UI. To find the real error, run the same command on the CLI:

```
pnpm otto run --suite <suite> --role <role> --env qa
```

The most common cause: **a required value is missing from the settings files.**
`src/engine/env.ts` `read()` throws `Missing required secret: <VAR>` for any
empty/missing var. The full required set is `QA_BASE_URL`, `STAGING_BASE_URL`,
`*_EMAIL`, `*_PASSWORD`, `MFA_CODE` (see "Settings / configuration" above for
where each lives). Two settings-specific failure modes:
- `Cannot decrypt <VAR>: set AGE_PASSPHRASE` — the committed secrets file has an
  encrypted value but no/blank passphrase. Export `AGE_PASSPHRASE` (CLI) or set it
  in the Settings panel (GUI).
- `Cannot decrypt <VAR>: wrong AGE_PASSPHRASE?` — passphrase doesn't match the one
  the secrets were encrypted with.

## Useful commands

- `pnpm test` (vitest), `pnpm typecheck`
- `pnpm otto list` — list suites and their roles
- `pnpm otto run --suite create-study --role researcher --env qa`
- `pnpm otto run --suite <s> --pr <n>` — run against PR preview `prN.qa.safeinsights.org`
- `pnpm otto migrate` — one-time: import a legacy `.env` into `config/settings.local.json`

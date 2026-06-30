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
- `bin/otto.ts` — CLI: `run | login | cleanup | codegen | list | migrate |
  request-access | rekey | set-secret | sync`.
- `gui/` — Wails app. `gui/app.go` `RunProcess()` spawns `pnpm otto run ...`
  and streams JSON step lines back to the React UI. `gui/settings.go` reads/writes
  the settings files and encrypts secrets to the keyring (`gui/app.go` also exposes
  `Sync`/`RequestAccess`/`Rekey`/`ResetAndSync`/`IsInDrift` to the React UI).
- `src/engine/keyring.ts` / `src/engine/identity.ts` — the multi-user encryption
  core: the committed recipient list (`config/keyring.json`) and the local age
  identity (`config/age-identity.txt`, gitignored). See "Settings" below.

## Settings / configuration

Config no longer comes from `.env`. `src/engine/settings.ts` `loadSettings()`
merges three files under `config/` (lowest precedence first), then `process.env`
(so CI env vars still override anything):

1. `config/settings.json` — committed, plaintext. Non-secret values (base URLs).
2. `config/settings.secrets.json` — committed, but each secret value is an
   **age-encrypted** armored blob, encrypted to **every recipient in the keyring**
   (X25519, not a passphrase). Holds the shared accounts' passwords + per-account
   MFA codes. Decrypted at load with the user's local identity.
3. `config/settings.local.json` — **gitignored** per-user overrides (plaintext).

Var names: base URLs (`QA_BASE_URL`, …) and, **per account**, `<ROLE>_EMAIL`,
`<ROLE>_PASSWORD`, `<ROLE>_MFA_CODE` (each account has its OWN second-factor code).
The engine reads a flat map via `resolveEnv()`. Secret var names (the `*_PASSWORD`s
and `*_MFA_CODE`s) are derived from `config/environments.ts` in `secretVarNames()`.

### Multi-user encryption (keyring)

Each secret is age-encrypted to **X25519 recipients**, one per QA user — no shared
passphrase. The pieces:

- **`config/keyring.json`** — committed list of `{ name, publicKey, email,
  addedDate }`. This is "who can decrypt".
- **`config/age-identity.txt`** — each user's local age secret key, **gitignored**,
  never leaves the machine. `loadSettings()` decrypts with it. If it's **absent**,
  `loadSettings()` SKIPS encrypted values (no error) so **CI runs keyless** — CI
  supplies `*_PASSWORD`/`*_MFA_CODE` as env vars, which override the file tiers.
- **`config/keyring.lock`** — committed sha256 fingerprint of the recipient set the
  secrets were last encrypted to. If it doesn't match `keyring.json`, the app shows
  a "rekey needed" (drift) banner. The fingerprint is byte-identical across the TS
  engine (`src/engine/keyring.ts`) and the Go GUI (`gui/settings.go writeLock`).

Onboarding & operations (CLI; the GUI Settings tab shells out to these):

- `pnpm otto request-access --name "Your Name"` — generates the local identity,
  adds your public key to `keyring.json`, branches, and opens a PR via `gh`. A
  reviewer runs `otto rekey` on that branch before merging (atomic — no drift gap).
- `pnpm otto rekey` — re-encrypts all secrets to the current keyring and updates
  `keyring.lock`. Used by the reviewer when adding a recipient, and after revoking.
- `pnpm otto set-secret --key <VAR> --value <v>` — encrypts one secret to all
  recipients (the GUI Settings "save secret" path).
- `pnpm otto sync` — fast-forward-only `git pull` (distributes suites + keyring +
  secrets). Skips when the working copy is dirty or diverged; the GUI's "Reset to
  clean & sync" discards only **uncommitted** edits (keeps local commits).
- **Revocation** is manual: remove the entry from `keyring.json`, run `otto rekey`,
  land via PR. A revoked user can still read OLD secrets they already pulled —
  rotate the actual password/MFA seed (and `set-secret` it) if truly sensitive.

Trust is enforced by **GitHub** (who can merge keyring PRs), not by the app.

Go encrypts (`gui/settings.go`, `filippo.io/age`); the engine decrypts
(`age-encryption` npm). X25519 interop is covered by `tests/engine/age-interop.test.ts`.

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
where each lives). Settings-specific failure modes:
- `Cannot decrypt <VAR>: your key may not be a recipient yet — ask a teammate to
  rekey` — you have a local identity, but the secrets aren't encrypted to your key.
  A teammate runs `otto rekey` after your `keyring.json` PR merges.
- No identity at all (`config/age-identity.txt` missing): encrypted secrets are
  silently SKIPPED, so a run fails later with `Missing required secret: <VAR>`.
  Run `pnpm otto request-access --name "..."` (or the GUI's Request access button),
  or supply the value via env / `settings.local.json`. (This skip-when-keyless
  behavior is what lets CI run without a key.)

## Useful commands

- `pnpm test` (vitest), `pnpm typecheck`
- `pnpm otto list` — list suites and their roles
- `pnpm otto run --suite create-study --role researcher --env qa`
- `pnpm otto run --suite <s> --pr <n>` — run against PR preview `prN.qa.safeinsights.org`
- `pnpm otto migrate` — one-time: import a legacy `.env` into `config/settings.local.json`
- `pnpm otto request-access --name "..."` — generate your identity + open a keyring PR
- `pnpm otto rekey` — re-encrypt all secrets to the current keyring (reviewer step)
- `pnpm otto sync` — fast-forward pull (suites + keyring + secrets)
- `cd gui && go test ./...` — Go GUI tests (encryption, settings routing, interop)

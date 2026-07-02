# qa-review — project notes

(The package is `qa-review`; the CLI command is `qar`. Formerly `qatest`, and
briefly `otto`. The repo directory is still named `qatest`.)

A QA runner for SafeInsights. A TypeScript engine uses Playwright to drive
Chromium through the suites (plain TS objects, not Playwright test files); a
Wails (Go + React/Vite) desktop GUI wraps it for "pick suite, press Run" use.

## Code rules

(Portable subset of the SafeInsights management-app conventions, adapted to this
repo. Formatting + linting are enforced by **Biome** (`biome.json`, rules ported
from tinycld: 4-space, single quotes, no semicolons, 100-col). Don't hand-format
— run `pnpm lint:fix`. `pnpm lint` is the CI gate.)

### React / TypeScript

- Keep JSX minimal: no complex ternaries, `map`, or calculations inside the
  `return`. Move state, event handling, and data processing into custom hooks
  (`useFeatureName`) or helper functions outside the component.
- Co-locate, don't embed: if logic is used only by one component, define it just
  above the JSX — keep the JSX clean of declarations and other logic.
- Extract: if a sub-section of a function or JSX is complex, break it into
  smaller parts.
- Conditional visibility: instead of hiding/showing large blocks with
  `{condition && <Component />}`, give the component an `isVisible` prop and
  return `null` when it shouldn't render.
- Comments explain "why", not "what". No trivial comments (`// delete users`
  before `deleteFrom('user')`). If the code is self-explanatory, add nothing.

### Testing

- Write tests for new features (vitest for TS, `go test` for the GUI). Test
  critical behavior (state changes, decrypt/encrypt round-trips), not the
  appearance of every UI element.
- Don't mock our own components/actions or the real data path — assert on real
  outputs.
- **E2E flakiness: ZERO tolerance.** A suite that only passes on retry is a bug —
  fix the root cause (await the right signal, use web-first `expect`
  assertions/`toPass`, isolate per-run data), never mask it with a retry, an
  inline timeout, or a bare `waitForTimeout`. Don't set inline Playwright
  timeouts; configure them globally.

### Stop conditions

- Stop if unit tests, `pnpm typecheck`, or lint fail — fix before proceeding.
- Ask before committing work.
- Don't commit planning/scratch files unless explicitly told to.

## Architecture (one-liners)

- `src/engine/` — the run engine. `runEngine()` is the entry; `env.ts` resolves
  envs; `suite-registry.ts` lists/loads suites.
- `src/suites/` — the actual suites (`signin`, `create-study`, plus discovered ones).
  A `Suite` is a plain object with an ordered **`steps: Step[]`** array (each
  `{ name, run(ctx) }`), so step names are statically enumerable — the GUI shows a
  suite's steps before running it. Shared state between steps threads through
  `ctx.state`. (There is no `suite.run()`; the engine loops over `steps`.) The
  registry (`suite-registry.ts`) discovers suites by globbing `src/suites/*.ts` and
  importing each directly — the engine runs under **tsx** (both `pnpm qar` and the
  packaged app run node with `--import tsx`), so the `.ts` IS the runtime artifact:
  there is NO compile step and no `suites-compiled/` dir. **Suites must use RELATIVE
  imports** (`./types`, `../engine/paths`), not the `@/` alias — the alias is not
  resolved at suite-load time.
- `config/environments.ts` — declares STABLE envs (`qa`, `staging`) and derives PR
  preview URLs. **A PR run is identical to a QA run except for the base URL** —
  same accounts, same MFA. There is NO code that gates a suite to PR-only or
  QA-only. If a suite "runs on a PR but not on QA," the cause is environmental
  (data/secrets/org state), not suite selection.
- `src/engine/settings.ts` — the layered settings loader (replaces `.env`). See
  "Settings / configuration" below.
- `bin/qar.ts` — CLI: `run | login | cleanup | codegen | list | migrate |
  request-access | rekey | set-secret | sync | session`.
- `gui/` — Wails app. `gui/app.go` `RunEngine()` spawns the bundled engine
  (`<Resources>/runtime/node <Resources>/engine/qar.bundle.mjs run ...`, or
  `pnpm qar run ...` under `wails dev`) and streams JSON step lines to the React UI.
  `gui/paths.go` is the packaging core: `repoDir()` (single source of truth for the
  cloned-repo location), `engineCmd()`, first-launch clone bootstrap, and preflight.
  `gui/settings.go` reads/writes the settings files and encrypts secrets to the
  keyring (`gui/app.go` also exposes `Sync`/`RequestAccess`/`Rekey`/`ResetAndSync`/
  `IsInDrift`/`Setup`/`Preflight`/`IsRepoReady` to the React UI).
- `src/engine/paths.ts` — single source of truth for where the repo lives:
  `repoDir()` reads `QAR_REPO_DIR` (set by the packaged app to the user-writable
  clone) and falls back to this checkout for `pnpm qar`. `configDir`/`resultsRoot`/
  `suitesSrcDir` all derive from it. The Go `repoDir()` reads the SAME var.
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

- `pnpm qar request-access --name "Your Name"` — generates the local identity,
  adds your public key to `keyring.json`, branches, and opens a PR via `gh`. A
  reviewer runs `qar rekey` on that branch before merging (atomic — no drift gap).
- `pnpm qar rekey` — re-encrypts all secrets to the current keyring and updates
  `keyring.lock`. Used by the reviewer when adding a recipient, and after revoking.
- `pnpm qar set-secret --key <VAR> --value <v>` — encrypts one secret to all
  recipients (the GUI Settings "save secret" path).
- `pnpm qar sync` — fast-forward-only `git pull` (distributes suites + keyring +
  secrets). Skips when the working copy is dirty or diverged; the GUI's "Reset to
  clean & sync" discards only **uncommitted** edits (keeps local commits).
- **Revocation** is manual: remove the entry from `keyring.json`, run `qar rekey`,
  land via PR. A revoked user can still read OLD secrets they already pulled —
  rotate the actual password/MFA seed (and `set-secret` it) if truly sensitive.

Trust is enforced by **GitHub** (who can merge keyring PRs), not by the app.

Go encrypts (`gui/settings.go`, `filippo.io/age`); the engine decrypts
(`age-encryption` npm). X25519 interop is covered by `tests/engine/age-interop.test.ts`.

- **Migration**: `pnpm qar migrate` reads a legacy `.env` into
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
pnpm qar run --suite <suite> --role <role> --env qa
```

The most common cause: **a required value is missing from the settings files.**
`src/engine/env.ts` `read()` throws `Missing required secret: <VAR>` for any
empty/missing var. The full required set is `QA_BASE_URL`, `STAGING_BASE_URL`,
`*_EMAIL`, `*_PASSWORD`, `MFA_CODE` (see "Settings / configuration" above for
where each lives). Settings-specific failure modes:
- `Cannot decrypt <VAR>: your key may not be a recipient yet — ask a teammate to
  rekey` — you have a local identity, but the secrets aren't encrypted to your key.
  A teammate runs `qar rekey` after your `keyring.json` PR merges.
- No identity at all (`config/age-identity.txt` missing): encrypted secrets are
  silently SKIPPED, so a run fails later with `Missing required secret: <VAR>`.
  Run `pnpm qar request-access --name "..."` (or the GUI's Request access button),
  or supply the value via env / `settings.local.json`. (This skip-when-keyless
  behavior is what lets CI run without a key.)

## Packaging a standalone Mac app (`.dmg` for staff)

The desktop app ships as a self-contained, Developer-ID-notarized `.app`/`.dmg` so
staff can download and run it with **no Node/pnpm/checkout**. How it works:

- **The engine is bundled.** `esbuild.config.mjs` bundles `bin/qar.ts` →
  `gui/build/engine/qar.bundle.mjs`. The `.app` ships a pinned `node` +
  `qar.bundle.mjs` + a self-contained Playwright + **tsx** `node_modules` in
  `Contents/Resources/`. `gui/app.go` `RunEngine()`/`engineCmd()` runs
  `<Resources>/runtime/node --import tsx <Resources>/engine/qar.bundle.mjs ...`;
  under `wails dev` (no Resources) it falls back to `pnpm qar` (which is `tsx bin/qar.ts`).
- **The app clones the repo on first launch.** `SetupGate` (React) prompts for a
  location and shells `gh repo clone <qaReviewSlug>` (set in `gui/paths.go`) into a
  user-writable dir, persisted in `~/Library/Application Support/qa-runner/repo-location.txt`.
  Suites + `config/` live in that clone. `repoDir()` is the single source of truth,
  shared by Go and the engine via the **`QAR_REPO_DIR`** env var.
- **Suites are `.ts` and load directly.** The bundle runs under `--import tsx`, so
  the registry imports `<repo>/src/suites/*.ts` straight from the clone — no compile
  step, no `suites-compiled/` dir. This is why suites must use RELATIVE imports (the
  `@/` alias isn't resolved at suite-load time). Editing a suite and re-running picks
  up the change immediately (the retry path cache-busts the `.ts` import), so there
  is no stale-artifact class of bug.
- **Required tools** (Chrome, git, gh, claude) are used from the user's machine.
  `Preflight()` checks them and shows a blocking banner if any are missing. Playwright
  launches the user's Chrome via `channel:'chrome'` (no bundled Chromium).

Build it:

- `make engine` — just bundle the engine (`node esbuild.config.mjs`).
- `make dmg-unsigned` — full pipeline minus signing (`SIGN=0`); good for a local smoke
  test of the bundled `.app`.
- `make dmg` — signed + notarized `.dmg`. Fill in `DEVELOPER_ID` + `NOTARY_PROFILE`
  and `qaReviewSlug` first (see `scripts/build-app.sh` + `gui/paths.go`).

**`qa-explore` skill note:** in the packaged app there is no `pnpm qar`; the engine
ships as a bundle. `engineCmd` exports **`QAR_BIN`** (= `"<node> <bundle>"`) for the
Exploratory tab's `claude` run. The `qa-explore` skill must invoke `$QAR_BIN <args>`
rather than `pnpm qar <args>`.

## Useful commands

- `pnpm test` (vitest), `pnpm typecheck`
- `pnpm lint` (biome check — CI gate), `pnpm lint:fix` (auto-fix + format)
- `pnpm qar list` — list suites and their roles
- `pnpm qar run --suite create-study --role researcher --env qa`
- `pnpm qar run --suite <s> --pr <n>` — run against PR preview `prN.qa.safeinsights.org`
- `pnpm qar migrate` — one-time: import a legacy `.env` into `config/settings.local.json`
- `pnpm qar request-access --name "..."` — generate your identity + open a keyring PR
- `pnpm qar rekey` — re-encrypt all secrets to the current keyring (reviewer step)
- `scripts/approve-access.sh <pr#>` — reviewer one-shot: check out an access PR's
  branch, `qar rekey`, push, and merge (honors `QAR_REPO_DIR`/`QAR_BIN`)
- `pnpm qar sync` — fast-forward pull (suites + keyring + secrets)
- `make dmg` — build the signed/notarized standalone Mac app (see Packaging above)
- `cd gui && go test ./...` — Go GUI tests (encryption, settings routing, interop)

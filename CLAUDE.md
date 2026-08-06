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
- **Wait on page elements, not URLs.** After a click/navigation, wait for a
  distinctive element on the DESTINATION page (`getByRole(...).waitFor()`,
  web-first `expect`), NOT `page.waitForURL()`. A URL can change before the page
  is interactive (or a click can land before the SPA router is ready), so
  URL-waits race and time out while the real signal — the target UI — is what you
  actually depend on. If you genuinely need a value FROM the URL (e.g. a
  record id in the path), still wait for a destination element first, THEN read
  `page.url()` once the page has rendered.

### Stop conditions

- Stop if unit tests, `pnpm typecheck`, or lint fail — fix before proceeding.
- Ask before committing work.
- Don't commit planning/scratch files unless explicitly told to.
- **Session scratch goes in `.tmp/`** (gitignored). Every skill — qa-explore,
  qa-validate, qa-run-companion, pr-review — writes screenshots, draft Jira comment
  bodies, and review payloads there. Before this, each session picked its own
  directory (`.qa-validation-shots/`, `/tmp/claude/`), so output either polluted
  `git status` or went to a path that didn't exist.

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
  request-access | rekey | set-secret | sync | session | jira-comment |
  jira-delete-comment`.
- `src/engine/jira.ts` — Jira Cloud REST client used to post validation findings.
  See "Posting Jira comments with inline screenshots" below for why this exists
  instead of the `jira-atlassian` MCP's `jira_add_comment`.
- `gui/` — Wails app. `gui/app.go` `RunEngine()` spawns the bundled engine
  (`<Resources>/runtime/node <Resources>/engine/qar.bundle.mjs run ...`, or
  `pnpm qar run ...` under `wails dev`) and streams JSON step lines to the React UI.
  `gui/paths.go` is the packaging core: `repoDir()` (single source of truth for the
  cloned-repo location), `engineCmd()`, first-launch clone bootstrap, and preflight.
  `gui/settings.go` reads/writes the settings files and encrypts secrets to the
  keyring (`gui/app.go` also exposes `Sync`/`RequestAccess`/`Rekey`/`ResetAndSync`/
  `IsInDrift`/`Setup`/`Preflight`/`IsRepoReady` to the React UI).
- `gui/prompts/*.md` + `gui/prompts.go` — the opening message submitted to each
  Claude session (authoring / validation / run companion), as editable markdown
  rather than Go string concatenation. `prompts.go` `go:embed`s them (so they
  compile into the binary — nothing extra to ship, and **an edit needs a rebuild**,
  unlike the skills in `.claude/skills/`, which are read from the clone at runtime)
  and substitutes `{{placeholder}}` vars. Each file's trailing newline is trimmed —
  the prompt is submitted as ONE PTY message and a stray newline would send it early.
  `validation.md` is used when the Jira card is known; `validation-by-pr.md` when
  only a PR is (see "Validating by PR number" below).
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

- `pnpm qar request-access [--name "Your Name"]` — generates the local identity,
  adds your public key to `keyring.json`, branches, and opens a PR via `gh`. A
  reviewer runs `qar rekey` on that branch before merging (atomic — no drift gap).
  `--name` is optional: it defaults to `git config user.name` (an EMPTY `--name ""`
  is treated as absent, not as an explicit name — the GUI sends one). Re-running is
  safe and idempotent: the same key reuses its keyring entry and its branch, and an
  already-open PR is reported rather than duplicated.
  A failing `git commit` is **fatal** instead of being swallowed as "already
  committed": the old catch read every commit failure as a no-op, so a commit git
  refused pushed a branch with NOTHING on it and `gh pr create` died with `No
  commits between main and access/<name>`, which `open-access-pr` could not repair
  (it only retries the create). `git diff --cached --quiet` now decides which case
  it is (nothing staged = genuinely already committed), and an identity-shaped
  failure gets the exact `git config` commands appended (`commitFailureMessage`).
  There is deliberately NO up-front `git config` gate — unset config alone doesn't
  stop git (it auto-detects `<username>@<hostname>` and commits with a warning), so
  a pre-check would lock out users whose commits work fine.
- `pnpm qar access-status` — report where your access request stands, as JSON:
  `no-identity`, `no-branch`, `branch-no-pr`, `pr-open`, `pr-closed`,
  `merged-awaiting-rekey`, `ready`. Keyed on the local age **public key** (stored
  with `# name:`/`# branch:` in `config/age-identity.txt`), NOT on a typed-in name —
  which is what makes a repeat request incapable of opening a second PR. A GitHub or
  local-file failure degrades to the best local answer with a `note` and never
  reports "no request"; that downgrade is what used to restart the duplicate loop.
  Identity files predating this feature have no `# name:`/`# branch:` lines; those
  fields come back empty and the branch falls back to `git config user.name`.
- `pnpm qar open-access-pr` — open (or report) the PR for an already-pushed access
  branch. This is the retry path for the real state where the branch push succeeded
  but PR creation didn't, which nothing could previously re-drive. It special-cases
  GitHub's `No commits between …` rejection — the one create failure retrying can
  never fix — and tells the user to set their git identity and re-run
  `request-access` instead of relaying the raw GraphQL error. That check runs only
  AFTER the "is a PR already open?" lookup, so a healthy already-open PR still wins.
- `pnpm qar rekey` — re-encrypts all secrets to the current keyring and updates
  `keyring.lock`. Used by the reviewer when adding a recipient, and after revoking.
- `pnpm qar set-secret --key <VAR> --value <v>` — encrypts one secret to all
  recipients (the GUI Settings "save secret" path).
- `pnpm qar sync` — fast-forward-only `git pull` (distributes suites + keyring +
  secrets). Skips when the working copy is dirty or diverged; the GUI's "Reset to
  clean & sync" discards only **uncommitted** edits (keeps local commits).
- **Revocation**: `scripts/revoke-access.sh "<name>"` — removes them from
  `keyring.json`, rekeys to the survivors, and opens a PR. It removes by **public
  key**, not by row, so a user with duplicate entries (`addMember` dedupes on name
  only, so re-running `request-access` with different `--name` spellings appends
  rather than replaces) doesn't keep a working key behind. Refuses to remove the
  last recipient, which would leave the secrets unrecoverable.
  A revoked user can still read OLD secrets they already pulled — rotate the actual
  password/MFA seed (and `set-secret` it) if truly sensitive.

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

## The diagnostic log (first stop for any silent failure)

This app's characteristic failure is an ABSENCE: no steps appear, an MCP tool is
missing, a button does nothing. `logDiag()` (`gui/paths.go`) appends to
`~/Library/Application Support/qa-runner/diagnostics.log` (rotates at 2 MB to
`.log.1`), tagged by area — `mcp`, `engine`, `spawn`, `pty`, `path`, `git`, `tool`.
**`ReportIssue` embeds its tail automatically**, so a bug report carries the
evidence without the user knowing the path. Read it before theorizing.

What it captures that is otherwise unrecoverable:
- **`mcp`** — MCP servers are spawned by `claude`, so we never see their stderr, and
  a server that fails to start just leaves the session without its `mcp__*` tools.
  `probeMcpServers()` therefore STARTS the real command once per session and records
  why it died. It also probes the CDP endpoint separately, because "dead MCP server"
  and "dead browser" look identical from inside a session and have different fixes.
  The server version is **pinned** in `chromeDevtoolsMcpPkg` (`gui/paths.go`), NOT
  `@latest` — `@latest` re-resolves on every cold start, so an upstream release could
  break every session with no local change. Both session configs and the probe read
  that one constant, so the probe always tests what the sessions actually run. To bump
  it: change the constant, start a session, confirm the probe logs "stayed up past".
  Two things the probe must keep doing, both found by getting them wrong first:
  it holds **stdin open** (an stdio server sees EOF on a closed stdin and exits 0
  immediately, so the probe would report every healthy server as a failure), and it
  kills by **process group** — `npx` spawns three levels (`npm exec` → server →
  telemetry watchdog), so killing only the wrapper orphans the real server while it
  still holds a CDP connection. Orphans from dead sessions were observed accumulating
  on a real machine (18 of them, one pinned to a long-gone port), which is itself a
  plausible contributor to "the MCP server didn't come up".

**App quit reaps synchronously.** `teardownSession()`/`pty.stop()` only SIGTERM and
defer the SIGKILL to goroutines that fire 2–3s later. That's fine for a session
switch, but at quit the process exits before those goroutines run — so anything
ignoring SIGTERM is orphaned. `shutdown()` therefore captures the session PIDs
BEFORE teardown (which nils `sessionCmd` and closes the PTY immediately, so app
state is useless a moment later) and calls `killGroupsNow()`, which SIGKILLs each
process GROUP inline. Don't "simplify" that back to relying on the deferred kills.
- **`engine`** — the non-JSON lines the run parser discards (below), which is where a
  crash-before-first-step says why.
- **`pty`** — a `claude` that exits non-zero or suspiciously fast, plus its last output.
- **`path`** — a tool `guiResolve()` could not find, and the PATH searched. A
  Finder-launched app only searches `guiPathDirs`, so nvm/asdf/Volta installs miss.

Secrets never reach it: `redactArgs()` masks `--value`/`--password`/`--token`
before any engine label is logged or embedded in an issue.

## PATH order decides which `node` npx runs

`guiPathDirs` is a **priority ranking**, not a set — its order picks which of
several installed toolchains wins. `withGuiPath()` builds the final PATH through
`prependPathDirs()`, which places those dirs at the front **in one pass**.
Prepending them one at a time (the old code) REVERSES them: each prepend pushes
the previous one back, so `/opt/homebrew/bin` — declared first — ended up last
among them. A Finder-launched app inherits neither Homebrew nor `/usr/local/bin`,
so both got prepended and `/usr/local/bin` won.

That is issue #36: a user with Node 26 in Homebrew and Node **21.1.0** in
`/usr/local/bin` got the 21.1.0. `chrome-devtools-mcp` declares
`engines: ^20.19.0 || ^22.12.0 || >=23`, and 21.x is in the gap — it uses
`import.meta.dirname` (Node 21.2.0+), which is `undefined` there, so the server
throws ``The "path" argument must be of type string`` at import. The message
names neither node nor a version, so every session silently came up with no
browser tools. Reproduced directly: the same server binary crashes on 21.1.0 and
exits 0 on 25.2.0.

Two guards now exist, and both should stay:
- `nodeVersionProblem()` mirrors that engines range. **The Setup Doctor fails the
  Node row** on an unsupported version — it previously reported a green
  `✓ Node.js v21.1.0` because it only checked that `node` *ran*. An unparseable
  version is deliberately NOT flagged (a doctor that cries wolf is worse).
- `probeMcpServers()` logs the node version it resolved and flags an unsupported
  one, so the diagnostic log names the cause instead of showing a bare crash.

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

**`qar` shim / skill invocation:** in the packaged app there is no `pnpm qar` (the
engine ships as a bundle), and `pnpm qar` alone wouldn't work in the Claude PTY
there. So the committed **`bin/qar`** shim (on PATH) dispatches to the bundled engine
or `pnpm qar` (dev). `qarBinValue()` (`gui/paths.go`) is the single source of the
engine location, exported as **two** vars — `QAR_NODE` and `QAR_BUNDLE` (packaged
only); `withGuiPath()` (`gui/app.go`) exports them AND prepends `<repoDir()>/bin` to
PATH, so a bare `qar <args>` works in the Claude sessions (authoring/validation/
companion) in both dev and the packaged app. The skills therefore invoke bare **`qar
<args>`** — not `pnpm qar`, and not the raw vars. The `Bash(qar:*)` allowlist entry
(`gui/app.go`) matches this shim.

They are two vars rather than one `"<node> --import tsx <bundle>"` command string
**because the installed app path contains a space** (`/Applications/SI QA
Runner.app/…`). A packed string leaves the shim no good option: unquoted it
word-splits at the space (`/Applications/SI: No such file or directory`, exit 127 on
every `qar` call in the packaged app); quoted it becomes one nonexistent command
name. Split into one path per var, each expansion is a single word and quotes
correctly. Don't recombine them.

**The shim does NOT fall back to `pnpm` when `QAR_REPO_DIR` is set but `QAR_NODE`
isn't.** That combination means a PACKAGED app whose `Resources/engine/qar.bundle.mjs`
wasn't found (`resourcesDir()` returned `""`), and the `pnpm qar` fallback is for a
DEV CHECKOUT — there, `node_modules` is a symlink into the `.app`, so pnpm dead-ends
on a node-version or pinned-pnpm error that names nothing real. The shim exits 127
with the actual cause instead. `withGuiPath()` correspondingly STRIPS inherited
`QAR_NODE`/`QAR_BUNDLE` (it already stripped `PATH`/`QAR_REPO_DIR`): `QAR_REPO_DIR` is
appended unconditionally while the pair is packaged-only, so without stripping, the
two halves of the shim's contract can disagree.

## Validating by PR number (Jira card inference)

The Validation screen takes a Jira card **and/or** a PR — either alone is enough
(`StartValidationSession` rejects neither-given). There is no role picker: the
qa-validate skill infers the role from the ticket.

Both inputs accept a **pasted URL** (`gui/frontend/src/components/validationInputs.ts`:
`parseJiraCard` / `parsePrNumber`). Parsing is behavior, not cosmetics — the PR
value flows into the `--pr` engine flag, the preview base URL, and `gh pr view`,
so a URL must be reduced to a bare number. `parsePrNumber` prefers the `/pull/<n>`
segment over a first-number match, since a trailing `#diff-r1234567` fragment or a
`?w=1` query also contains digits. These live in a plain `.ts` module (not
`ValidationTab.tsx`) so the engine's tsconfig — which sets no `--jsx` — can
typecheck `tests/gui/validationInputs.test.ts`.

Given only a PR, `inferJiraCard()` (`gui/app.go`) runs `gh pr view <n> --repo
safeinsights/management-app --json title,headRefName,body` and scans **title →
branch → description**, in that order (a description is scanned last because it
often quotes OTHER tickets — "related to OTTER-99"). The resolved key is returned
to the UI in `ValidationStart{token, jiraCard}` because the GUI needs it: the
Verdict button is disabled without a card, and the `verdict-posted` event is
matched by issue key.

The matcher is anchored to a **known board list** (`jiraBoards` — OTTER, SHRIMP,
plus the recurring SHRMP typo), the approach `versionista`'s `changelog.go` uses.
This is not incidental: management-app history is full of ticket-shaped noise
(`fixes-2026`, `node-7`, `haiku-4`, `pages-6`), and a generic `\w+-\d+` pattern
turns each into a bogus card that sends the validator chasing a ticket that
doesn't exist. Matching real boards also makes it safe to be case-insensitive and
to accept a space separator, so PR #907's `Otter 590` resolves to `OTTER-590`.
**Adding a new Jira board means adding it to `jiraBoards`.**

Inference is best-effort: offline, `gh`-unauthenticated, or genuinely no key (PR
#839 has none) yields `""`, and the session still starts using
`prompts/validation-by-pr.md`, which asks Claude to identify the ticket from the
PR itself.

### The PR caveat and the `pr-review` skill

`prompts/pr-env-caveat.md` (appended whenever a PR is given) closes a validation by
telling Claude to run `/pr-review <n> --repo <slug>`. The **repo must be explicit**:
the session's cwd is the qa-review checkout, so a bare `gh pr view 839` resolves
against qa-review (PRs in the low tens) instead of the repo under test. The caveat
interpolates `{{pr}}`/`{{repo}}` from `composeValidationPrompt`, with `{{repo}}`
sourced from the same `managementAppSlug` constant the card inference uses.

`.claude/skills/pr-review/SKILL.md` posts a **PENDING** review (no `event` field) —
private to the PR author until a human clicks Submit — so the caveat authorizes
posting without asking, but requires surfacing the returned `html_url`. A draft
nobody can find is a draft that never happened. Neither the caveat nor the skill may
APPROVE or REQUEST CHANGES. The skill also inherits `qa-validate`'s PTY rules
(one command per Bash call, no `cd`, `.tmp/` for scratch) because it runs in that
same allowlisted session — a pipe or redirect turns an allowlisted `gh …` into a
non-matching compound and prompts the user mid-review.

## Posting Jira comments with inline screenshots

A QA validation is worth much more with the evidence embedded in the comment. The
`jira-atlassian` MCP's `jira_add_comment` **cannot do this** — it only ever emits
text. Every image syntax you might try is stored verbatim and renders as literal
text (`![](f.png)`, `!f.png|thumbnail!`, and a markdown link to the attachment URL
were all confirmed to fail; the wiki form additionally comes back escaped as
`\![](f.png)`). This is upstream bug
[sooperset/mcp-atlassian#608](https://github.com/sooperset/mcp-atlassian/issues/608),
still open.

The reason: Jira Cloud renders **ADF**, and an embedded image is only expressible
as an ADF `media` node. That node is keyed by a **Media Services file UUID**, which
is NOT the numeric attachment id from the upload response. It's exposed only
indirectly — request `/rest/api/3/attachment/content/{id}` **without following the
redirect**, and the `Location` header is `.../file/{uuid}/binary`.

`src/engine/jira.ts` does exactly that: upload → resolve UUID from the redirect →
POST an ADF doc interleaving `paragraph` and `mediaSingle` nodes. So:

- `qar jira-comment --issue <KEY> --body-file <path.md> [--images a.png,b.png]`
  posts ONE comment with the images embedded. Images append after the body by
  default; put a `{{image:N}}` placeholder (1-based) in the body to position one
  inline instead. Prints `{"id","url"}`.
- `qar jira-delete-comment --issue <KEY> --ids <id1,id2>` removes comments (the MCP
  has no delete tool, so this is the only way to clean up a bad post). 404 = already
  gone = success.

Body text **is** markdown — `buildCommentAdf()` converts each text segment with
`markdownToAdf()` (the `marklassian` package) and splices the resulting block nodes
into the doc, so headings, bold/italic, inline code, lists, and links all render.
(This replaced an earlier literal-text path; write markdown, not plain prose.)

Auth comes from the same var names the MCP server uses: `JIRA_URL` (defaults to
`https://openstax.atlassian.net`), `JIRA_USERNAME`, `JIRA_API_TOKEN`. These are read
from the merged settings via `jiraConfig(vars)`, so the GUI's saved "Jira email"
is picked up from `settings.local.json` and does NOT need to be exported — inline
`JIRA_USERNAME=you@rice.edu qar jira-comment …` is only a fallback when it isn't
saved there. Note the Jira account email is not necessarily your git email.

Deliberately NOT implemented: an "upload any absolute path" helper. That's the
arbitrary-file-read/exfiltration hole the upstream maintainer blocked in
[PR #1402](https://github.com/sooperset/mcp-atlassian/pull/1402); uploads here go
through the issue attachment endpoint only.

## Useful commands

- `pnpm test` (vitest), `pnpm typecheck`
- `pnpm lint` (biome check — CI gate), `pnpm lint:fix` (auto-fix + format)
- `pnpm qar list` — list suites and their roles
- `pnpm qar run --suite create-study --role researcher --env qa`
- `pnpm qar run --suite <s> --pr <n>` — run against PR preview `prN.qa.safeinsights.org`
- `pnpm qar migrate` — one-time: import a legacy `.env` into `config/settings.local.json`
- `pnpm qar request-access [--name "..."]` — generate your identity + open a keyring PR
  (name defaults to `git config user.name`; re-running is idempotent)
- `pnpm qar access-status` — where your access request stands, as JSON
- `pnpm qar open-access-pr` — open/report the PR for an already-pushed access branch
- `pnpm qar rekey` — re-encrypt all secrets to the current keyring (reviewer step)
- `scripts/approve-access.sh <pr#>` — reviewer one-shot: check out an access PR's
  branch, `qar rekey`, push, and merge (honors `QAR_REPO_DIR`; runs the engine via
  the `bin/qar` shim)
- `scripts/revoke-access.sh "<name>" [--no-pr] [--yes]` — remove a user from the
  keyring, rekey to the survivors, and open a revocation PR
- `pnpm qar sync` — fast-forward pull (suites + keyring + secrets)
- `pnpm qar jira-comment --issue OTTER-640 --body-file notes.md --images a.png,b.png`
  — post a Jira comment with the screenshots embedded inline (see above)
- `pnpm qar jira-delete-comment --issue OTTER-640 --ids 45521,45522`
- `make dmg` — build the signed/notarized standalone Mac app (see Packaging above)
- `cd gui && go test ./...` — Go GUI tests (encryption, settings routing, interop)

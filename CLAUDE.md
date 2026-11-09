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
  envs; `suite-registry.ts` lists/loads suites. Every `ctx.step()` runs under a
  deadline — see "Debugging the run hangs on one step" in `src/engine/CLAUDE.md`.
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
- `config/environments.ts` — declares STABLE envs (`qa`, `staging`, `production`,
  `demo`) and derives PR
  preview URLs. **A PR run is identical to a QA run except for the base URL** —
  same accounts, same MFA. There is NO code that gates a suite to PR-only or
  QA-only. If a suite "runs on a PR but not on QA," the cause is environmental
  (data/secrets/org state), not suite selection.
- `src/engine/settings.ts` — the layered settings loader (replaces `.env`). See
  "Settings / configuration" below.
- `src/engine/jira.ts` — Jira Cloud REST client used to post validation findings.
  See "Posting Jira comments with inline screenshots" in `src/engine/CLAUDE.md` for why this exists
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
  only a PR is (see "Validating by PR number" in `gui/CLAUDE.md`).
- `src/engine/paths.ts` — single source of truth for where the repo lives:
  `repoDir()` reads `QAR_REPO_DIR` (set by the packaged app to the user-writable
  clone) and falls back to this checkout for `pnpm qar`. `configDir`/`resultsRoot`/
  `suitesSrcDir` all derive from it. The Go `repoDir()` reads the SAME var.
- `src/engine/keyring.ts` / `src/engine/identity.ts` — the multi-user encryption
  core: the committed recipient list (`config/keyring.json`) and the local age
  identity (`config/age-identity.txt`, gitignored). See "Settings" below.

### Adding a stable environment

The env list lives in four places that must agree, none of which the compiler
cross-checks:

1. `config/environments.ts` — add to `PRIVATE_KEY_ENVS` **and** `ENVIRONMENTS`.
   `privateKeyEnvFor` derives from the former, so an env missing there silently
   decrypts with QA's key and fails much later as an opaque wrong-key error.
2. `config/settings.json` — the `<ENV>_BASE_URL` value.
3. `gui/settings.go` — `envList`, so the Settings panel renders that env's fields.
4. `gui/frontend/src/lib/ipc.ts` — `ENVS`, the single list the three pickers
   (RunControls, ValidationTab, ExploratoryTab) import.

Then populate the per-env secrets (`<ROLE>_EMAIL_<ENV>`, `_PASSWORD_`, `_MFA_CODE_`
or `_MFA_SEED_`, and `REVIEWER_RESULTS_PRIVATE_KEY_<ENV>` for results decryption).
A stable env does NOT fall back to QA's credentials — that is deliberate, so an
unpopulated secret fails loudly instead of running against the wrong tenant.

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
- `pnpm qar set-secret --name <VAR> --value <v>` — encrypts one secret to all
  recipients (the GUI Settings "save secret" path). **`--name`, not `--key`**, for
  the same reason as `get-secret` below. `--key` used to be the documented flag and
  was silently broken: it encrypted the value under a var literally named "true" and
  printed `Encrypted true to N recipient(s)`. It is now rejected with that
  explanation rather than aliased — `key` is listed valueless for this command in
  `src/cli/args.ts`, so it cannot carry a name through the parser at all.
- `pnpm qar get-secret --name <VAR> [--force]` — the READ half: prints one decrypted
  value to stdout. The var is named with **`--name`, not `--key`** — `key` is listed
  valueless for this command in `src/cli/args.ts` (it was the documented flag once),
  so `--key FOO` parses to `true` and drops `FOO`. The command rejects it by name
  rather than looking up a var literally named "true". Writes NO trailing newline, so
  a PEM stays byte-exact, and refuses to print to a TTY without `--force` (keeps
  private keys out of scrollback):
  `qar get-secret --name REVIEWER_RESULTS_PRIVATE_KEY_QA > reviewer-qa.pem`.
  `*.pem` is gitignored, but delete the extracted file when done anyway — it's a
  live results-decryption key on disk.
- `pnpm qar sync` — fast-forward-only `git pull` (distributes suites + keyring +
  secrets). Skips when the working copy is dirty or diverged; the GUI's "Reset to
  clean & sync" discards only **uncommitted** edits (keeps local commits).
  `SyncButton` auto-syncs on mount, so a clone normally can't drift — **unless the
  sync keeps getting skipped**, which is silent by design (a dirty working copy is
  normal while authoring a suite). One clone sat **48 commits behind** that way, and
  the resulting failures named neither the app nor the staleness: the stale `bin/qar`
  hunted `QAR_BIN`, a var the app had stopped exporting in favour of
  `QAR_NODE`/`QAR_BUNDLE`. So the skip banner now carries a magnitude from
  `CommitsBehind()` (`gui/app.go`): a `git fetch` plus `rev-list --count HEAD..@{u}`,
  asked for **only** when a sync was skipped. It returns **0 rather than a guess**
  whenever the count is unknowable (offline, no upstream) — a staleness warning that
  fires on every offline launch teaches people to ignore the one that matters.
  **"Diverged" is reported only for git's own `Not possible to fast-forward`**; every
  other pull failure (stale upstream ref, no tracking branch, `Cannot fast-forward to
  multiple branches`, a refused write, anything new) is a **failure carrying git's
  stderr**. "Diverged" used to be the catch-all, which sent people to push a branch
  level with origin. If the banner still looks wrong, `git status -sb` and
  `rev-list --left-right --count HEAD...@{u}` settle it, and `diagnostics.log` carries
  git's real message under `[git] FAIL`.
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

## The Claude command sandbox blocks five things QA sessions need

Claude Code runs Bash in a sandbox that confines both **network egress** and
**filesystem writes**. That sandbox is what a validation session actually trips over,
and all five failures look like broken tooling rather than a permissions boundary —
so each one gets retried, guessed at, or reported as a bug in `qar`:

- **`qar jira-comment` → `fetch failed`.** `openstax.atlassian.net` was not on the
  allowlist. Node's `fetch` rejects with a bare `TypeError: fetch failed` for *every*
  transport failure, naming neither host nor cause. `jiraFetch()`
  (`src/engine/jira.ts`) now wraps all four Jira calls and rewrites that into
  "Could not reach `<host>` … add it to `sandbox.network.allowedDomains`".
  That host really was missing. If the host is ALREADY listed, the cause is the
  fourth item below and adding it again fixes nothing.
- **`gh` → `x509: failed to verify certificate: OSStatus -26276`.** Not auth, not
  network: `gh` is a Go binary that verifies TLS through the macOS keychain, and the
  sandbox blocks the `com.apple.trustd.agent` Mach service it needs.
  `sandbox.enableWeakerNetworkIsolation` re-opens exactly that service.
- **Any `qar` command that reaches the network → `fetch failed`, with the host
  already allowlisted.** The sandbox blocks DNS outright and routes egress through an
  authenticated proxy named in `HTTPS_PROXY`. `curl` honors that variable; Node's
  `fetch` (undici) does NOT, unless `NODE_USE_ENV_PROXY=1` — which exists only in
  **Node 24+**, while the packaged app pins its own `Resources/runtime/node`. When
  that pin is older than 24 the true error is `getaddrinfo ENOTFOUND <host>`, which
  undici swallows into a bare `fetch failed`. It therefore reads as a missing
  allowlist entry and gets "fixed" by re-adding a host that was already allowed —
  that misdiagnosis cost a full session. `bin/qar` now detects a configured proxy,
  exports `NODE_USE_ENV_PROXY=1`, and substitutes a Node 24+ found on PATH when the
  pin is too old, warning by name when it cannot find one. The substitution is gated
  on the proxy alone: overriding a deliberate pin whenever a newer node happens to be
  installed would trade a narrow bug for a broad one. `tests/cli/qar-shim.test.ts`
  pins both halves.
- **`qar study-state` → `Failed to create a ProcessSingleton for your profile
  directory`.** Misleading — no other Chromium held the profile. The real lines are
  above it: `Failed to create socket directory` and `open …/Chrome/Crashpad/
  settings.dat: Operation not permitted`. It launches its OWN Playwright Chrome (it
  needs an admin token, so it does not reuse the session browser), and that browser
  writes outside the sandbox's writable set.
- **`qar sync` → `Skipped sync — your branch has diverged (unpushed commits)`, with
  NOTHING to push.** The sandbox denies writes under `.claude/` (`skills`, `hooks`,
  `settings.json`) so a session cannot rewrite its own instructions. A pull that
  must update a skill file therefore writes every PERMITTED file, then dies on that
  one with `error: unable to unlink old '<path>': Operation not permitted` — and
  aborts **HALF-APPLIED**: HEAD on the old commit while the index and worktree hold
  the new one. `git log -1` and `git status` disagree, and the stranded files look
  like edits you made. Recover as in the `git checkout` case below, then **sync from
  the QA Runner Sync button**, which runs git from the native Wails process, OUTSIDE
  the sandbox, and so is the only path that reliably updates `.claude/`.
  `qar sync` reports this as a FAILURE carrying git's real stderr plus a recovery
  hint; it used to fall through to "diverged", which is why the advice was to push a
  branch that had nothing on it.

`.claude/settings.json` carries the config. Two things to know about it:

- The **network allowlist is `sandbox.network.allowedDomains`**. Hosts also arrive
  from `WebFetch(domain:…)` permission rules, which is why a host can work for
  whoever accumulated that rule in their **gitignored** `.claude/settings.local.json`
  and fail for everyone else. Put shared hosts in the committed file. Wildcards are
  supported: `*.qa.safeinsights.org` covers `app.qa` AND every `pr<N>.qa` preview
  host from `prBaseUrl()` — a bare `app.qa.safeinsights.org` entry would make QA
  runs work while PR-preview runs fail with the same unnamed transport error. The
  list also carries every non-Jira host the engine reaches via Node `fetch`
  (currently `api.mail.tm`, the signup suite's disposable-inbox API, and
  `api.media.atlassian.com`, where `jira-attachments --download` is redirected for
  the bytes) — a new outbound host in the engine needs a matching entry here.
- **`sandbox.excludedCommands` did NOT take effect.** The key is schema-valid and has
  listed `qar`/`pnpm qar`/`gh` since the file was created, yet sandboxed `gh` still
  failed the keychain check while its host WAS allowlisted — proof the command ran
  sandboxed anyway. Treat exclusion as unreliable and make the sandboxed path work;
  don't delete the key, but don't count on it either.

The `sandbox` block is read at **session start**, so an edit there changes nothing
until a new session. The `env` block is NOT subject to that — it reaches new Bash
calls immediately. `qar study-state` still needs `dangerouslyDisableSandbox`.

**Git writes inside `.git/` are blocked even though the repo directory itself is
writable.** Two shapes of this, both seen:

- `git push -u` and `git branch --set-upstream-to` fail with `could not lock config
  file .git/config: Operation not permitted`. Note what the message does NOT say: on
  `push -u` the **push already succeeded** and the branch is on the remote — only the
  upstream-tracking write failed. Do not re-push or assume the branch is missing;
  re-run just the tracking command with the sandbox off.
- `git checkout` of another branch can abort part-done, leaving **HEAD on the old
  commit while the index and worktree hold the new one** — `git log -1` and
  `git status` disagree, and the staged entries look like changes you made. Recover
  with `git reset` then `git checkout -f -- .`, and redo the checkout with the
  sandbox off. Back up any unrelated working-tree edits first; a reset makes them
  much harder to tell apart from the checkout's leftovers.

**Never run `pnpm install`, `pnpm test`, `pnpm typecheck` or `pnpm lint` in a
packaged-app clone — with OR without the sandbox.** `node_modules` there is a symlink
into `/Applications/SI QA Review.app/…/Resources/engine/node_modules`, and each of
those commands triggers pnpm's deps-status check, which runs an install. Sandboxed it
fails with `EPERM … mkdir node_modules/.pnpm`; with `dangerouslyDisableSandbox` it
SUCCEEDS — writing into the signed application bundle and plausibly breaking the
engine the GUI depends on. That EPERM is protecting the app, not obstructing you.

To actually run the checks, copy the repo somewhere disposable — `git clone <this
dir> "$TMPDIR/checks"` needs no network — then `pnpm install` and run them there.
Two things to know about such a run:

- **Unset `QAR_REPO_DIR` (and `QAR_NODE`/`QAR_BUNDLE`).** The GUI session exports
  them into every Bash call, and they redirect `suitesSrcDir()` away from the copy,
  failing three `suite-registry` tests for a reason that has nothing to do with the
  code under test.
- `tests/engine/cdp-launch.test.ts` needs the sandbox off wherever it runs
  (`listen EPERM … 127.0.0.1`, the localhost listener). That is safe in a disposable
  clone, which has its own real `node_modules` and no link to the `.app`.

With both handled the suite is green, so a failure there is a real one.

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

## Figma annotations are Plugin-API-only (and the validator may only READ)

Dev Mode annotations — where a design's per-column rules, states and "not ready
for engineering" markers live — are not returned by `get_screenshot`,
`get_metadata`, `get_variable_defs`, or the Figma REST API. Only the Plugin API
(the server's `use_figma` tool) exposes `node.annotations`. OTTER-617 was
validated twice against rendered frames alone and missed seven annotated rules.

`use_figma` can also WRITE to a design file. `gui/app.go` pre-approves only four
figma tools by name (`whoami`, `get_screenshot`, `get_metadata`,
`get_variable_defs`); `use_figma` is allowed only through the hook's explicit allow
(a pre-approval would fail open if the hook could not run), and the server's other
write tools are deliberately NOT pre-approved. So the only code a session may send is
`.claude/skills/qa-validate/figma-notes.js` (modes `pages` / `locate` / `page` / `frame`; only `frame` returns annotation text),
and the `PreToolUse` hook `.claude/hooks/figma-readonly.mjs` (wired in
`.claude/settings.json`) denies any `use_figma` call whose code differs from that
file in anything but its `MODE`/`TARGET` header.

**The Figma tool names depend on how the server was added.** The plugin exposes
`mcp__plugin_figma_figma__*`, `claude mcp add … figma` (the Doctor's own hint)
`mcp__figma__*`, and the claude.ai connector `mcp__claude_ai_Figma__*`. So the hook
matcher is the regex `^mcp__.+__use_figma$`: a matcher naming one prefix left the
read-only guard silently OFF for the others, while the Doctor still showed a green
Figma row. The read tools are pre-approved under all three known names
(`knownFigmaServers`, `gui/app.go`), and the Doctor's whoami probe uses the name of
the server `claude mcp list` reported as connected (`mcpToolName`). `tests/skills/` pins both the
hook and the script's write-API-free body. The hook runs `"${QAR_NODE:-node}"`,
so the packaged app's node is used.

Reading needs a **Dev or Full seat on the SafeInsights plan**: View/Collab seats
get 6 MCP calls a month. The Setup Doctor's "Figma seat" row probes `whoami`
through `claude -p` and caches any answer whoami gave (whatever the seat — a
failing seat re-probed on every launch could spend those 6 calls) for 24 h in
`~/Library/Application Support/qa-runner/figma-seat.json`; delete that file to
force a re-check.

Follow-up cards go through `qar jira-create-issue` (ADF description, inline
screenshots, a Relates link to the parent) — the MCP's `jira_create_issue` can do
none of those three. `qar followup-advice` is the routing rule (blocker → send
back; few/same-area → one card; else several), kept in code so it is testable.

**The report is gated by code, not by prose.** Two runs filed real bugs under
"also noted" and named lines by inventory id, which nobody can read without the
inventory open. So: every inventory line has a plain-language `title` (the only
name the report uses); the session writes `.tmp/<CARD>-results.json`; and
`qar results-check` (`src/engine/results.ts`) refuses a set with a line missing a
result, a result missing evidence, a FAIL missing severity/area, a NOT TESTED
missing the approver, or an `observed`-source line that is not a FAIL. There is
no "also observed" section: something seen outside the inventory is added as an
`observed` line and can only FAIL. **The card is the spec**: in a card-vs-Figma
conflict the card line is PASS or FAIL against the app and the Figma line is
CONFLICT, listed under "Unclear requirements" for information. A PM is asked
only for results carrying `decision` (a card-vs-Figma conflict in user-visible
behaviour, an UNCLEAR line whose readings change the verdict, or a scope
conflict), one per root cause; every decision is shown in full, never collapsed.
Reports are written in the conversational voice. `qar jira-comment` keeps a single newline as a
hard line break (`hardBreaks()`), since a report is line-oriented and markdown's
soft wrap had folded "Decisions needed" into one paragraph.

## Guidance kept in nested CLAUDE.md files

These load only when working under that directory:

- `gui/CLAUDE.md` — driving the GUI in a browser (`wails dev`), PATH order and node versions, packaging the `.dmg` and the `bin/qar` shim, validating by PR number and the `pr-review` caveat.
- `src/engine/CLAUDE.md` — the per-step deadline (`QAR_STEP_TIMEOUT_MS`, `clickUntil`) and posting Jira comments with inline screenshots.
- `src/suites/CLAUDE.md` — the `lighthouse` suite.

## Useful commands

- `pnpm test` (vitest), `pnpm typecheck`
- `pnpm lint` (biome check — CI gate), `pnpm lint:fix` (auto-fix + format)
- `pnpm qar list` — list suites and their roles
- `pnpm qar run --suite create-study --role researcher --env qa`
- `pnpm qar run --suite lighthouse --role admin --env qa` — Lighthouse audit sweep
  (see `src/suites/CLAUDE.md`); scores land in the GUI's Performance tab
- `pnpm qar run --suite <s> --pr <n>` — run against PR preview `prN.qa.safeinsights.org`
- `pnpm qar migrate` — one-time: import a legacy `.env` into `config/settings.local.json`
- `pnpm qar request-access [--name "..."]` — generate your identity + open a keyring PR
  (name defaults to `git config user.name`; re-running is idempotent)
- `pnpm qar access-status` — where your access request stands, as JSON
- `pnpm qar open-access-pr` — open/report the PR for an already-pushed access branch
- `pnpm qar rekey` — re-encrypt all secrets to the current keyring (reviewer step)
- `scripts/approve-access.sh <pr#>` — reviewer one-shot: check out an access PR's
  branch, `qar rekey`, push, approve, and merge (honors `QAR_REPO_DIR`; runs the
  engine via the `bin/qar` shim). The approve step satisfies the org `require-pr`
  ruleset (1 review on the default branch, not admin-bypassable); since GitHub
  forbids self-approval, a PR you opened yourself still needs a second reviewer
- `scripts/revoke-access.sh "<name>" [--no-pr] [--yes]` — remove a user from the
  keyring, rekey to the survivors, and open a revocation PR
- `pnpm qar sync` — fast-forward pull (suites + keyring + secrets)
- `pnpm qar jira-comment --issue OTTER-640 --body-file notes.md --images a.png,b.png`
  — post a Jira comment with the screenshots embedded inline (see `src/engine/CLAUDE.md`)
- `pnpm qar jira-delete-comment --issue OTTER-640 --ids 45521,45522`
- `pnpm qar jira-delete-attachment --issue OTTER-640 --ids 29216,29217` — remove a
  deleted comment's leftover uploads
- `pnpm qar jira-attachments --issue OTTER-617 --download`
- `pnpm qar jira-create-issue --project OTTER --summary "…" --body-file f.md --link OTTER-617`
- `pnpm qar inventory-render --input .tmp/OTTER-617-inventory.json` — the requirement
  inventory as one self-contained HTML page the session opens in its browser
- `pnpm qar results-check --inventory .tmp/OTTER-617-inventory.json --results .tmp/OTTER-617-results.json`
  — the gate before a verdict: every line has one evidenced result, observed
  findings are FAILs; lists every gap
- `pnpm qar followup-advice --input .tmp/OTTER-617-results.json`
- `pnpm qar clock --file .tmp/OTTER-617-clock.json --mark tested` / `--report` — phase
  timing for the report summary
- `pnpm qar jira-comment … --attach .tmp/OTTER-617-inventory.html` — attach non-image
  files and link them from the comment
- `make dmg` — build the signed/notarized standalone Mac app (see "Packaging" in `gui/CLAUDE.md`)
- `cd gui && go test ./...` — Go GUI tests (encryption, settings routing, interop)

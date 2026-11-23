# gui/ — notes for the Wails app

(Moved from the root CLAUDE.md, which still holds the repo-wide rules.)

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

**`QAR_REPO_DIR` set without `QAR_NODE`/`QAR_BUNDLE` is ambiguous, and the shim
resolves it by looking for `bin/qar.ts` in that dir.** The combination has two
causes with opposite fixes: (a) a DEV CHECKOUT pinning the repo explicitly — both
`wails dev` (where `resourcesDir()` is `""` by design) and `scripts/approve-access.sh`,
which sets `QAR_REPO_DIR="$REPO"` to target a clone; and (b) a PACKAGED app whose
`Resources/engine/qar.bundle.mjs` wasn't found. `pnpm qar` is right for (a) and
cannot work for (b) — there `node_modules` is a symlink into the `.app`, so pnpm
dead-ends on a node-version or pinned-pnpm error that names nothing real.
`bin/qar.ts` is the engine SOURCE: present in every checkout, never shipped in the
`.app` (`Resources/engine/` holds only the bundle + `node_modules`), so its presence
separates the two. The shim exits 127 with the real cause only for (b).
Treating the var alone as "packaged" broke `approve-access.sh` in an ordinary dev
checkout (`tests/cli/qar-shim.test.ts` pins this).
`withGuiPath()` correspondingly STRIPS inherited
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

The matcher is anchored to a **known board list** (`jiraBoards` — OTTER, SHRMP,
plus SHRIMP, the spelled-out form PRs use, normalized back to SHRMP), the approach `versionista`'s `changelog.go` uses.
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

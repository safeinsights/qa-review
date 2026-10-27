# Release regression — design

Date: 2026-10-26

## Problem

A management-app release goes to staging and then to production with no
single document that says what is in it, what was tested, and what was found.
The release page lists PRs, but the list is not reliable: the v1.6.9 release
body lists 43 PRs, while the tag compare `v1.6.8...v1.6.9` holds 63. The 20
others (#1078, #1080, #1084, #1086–#1109) appear in no release body at all. A
test that starts from the release page misses a third of the release.

The QA Runner can validate one Jira card. It has no way to test a whole
release.

## Goals

The QA Runner builds a regression plan for one management-app release. The
plan checks four things:

1. **Completeness.** Each PR in the tag compare gets a test line: "the change
   is present in this build", with a concrete check.
2. **No regressions.** The app still works. A fixed suite,
   `release-happy-path`, runs on every release. The changed areas get extra
   lines from the PRs.
3. **Security.** The diff is reviewed for vulnerabilities. Active probes run
   on staging only. Production gets read-only checks.
4. **Documentation.** The plan explains the release: a plain-language summary
   for PMs first, then a technical appendix for developers.

The plan runs as a go/no-go gate on staging before promotion, then as a smoke
check on production after the deploy. The plan and each run's results are
uploaded to the GitHub release as assets.

Scope: management-app only. The related releases (setup-app,
trusted-output-app, encryption, qa-review) are not covered.

## Decisions

- **Execution is a Claude session**, as Validation is. Claude reads the plan,
  drives the browser through each line, and records results in a file that a
  code gate checks. Generated Playwright suites were rejected: about 40
  one-shot suites per release is too much to write and fix.
- **The PR set comes from the tag compare**, never from the release body.
  The body is cross-checked, and the difference is reported in the plan.
- **The engine does the data, Claude does the judgment.** Deterministic parts
  (PR list, Jira keys, asset upload, line parsing, results gate) are `qar`
  commands with unit tests. Synthesis and execution are skills. This is the
  pattern Validation uses (`inventory-render`, `results-check`).
- **Editor is raw markdown** (CodeMirror 6) with a Preview toggle. A WYSIWYG
  editor was rejected: it rewrites tables, IDs and spacing even when nobody
  edits, which breaks the line IDs and the sync rule.
- **Results go to the release as assets**, one per run, timestamped. No Jira
  comments.
- **`release-happy-path` runs the full lifecycle on production too.** The
  user adds `RESEARCHER_RESULTS_PRIVATE_KEY_PRODUCTION`, which is missing today.

## Files and formats

### Working directory

`.tmp/release/<tag>/` holds everything for one release:

| File | Written by | Read by |
|---|---|---|
| `prs.json` | `qar release-prs` | plan skill |
| `pr-<n>.json` | plan subagents | plan skill |
| `plan.md` | plan skill, the editor | editor, run skill |
| `plan-lines.json` | `qar plan-lines` | `results-check`, the GUI status row |
| `results-<env>.json` | run skill | `results-check`, `results-render`, the GUI |
| `results-<env>.md` | `qar results-render` | `release-upload` |

The path is the same in dev and in the packaged app (`repoDir()`).

### `prs.json`

```json
{
  "tag": "v1.6.9",
  "previousTag": "v1.6.8",
  "prs": [{
    "number": 1110, "title": "…", "author": "Rod0352", "mergedAt": "…",
    "jiraKeys": ["OTTER-794", "OTTER-698"],
    "files": ["src/…"], "additions": 120, "deletions": 30, "body": "…"
  }],
  "notesMissing": [1078, 1080],
  "notesExtra": []
}
```

- `previousTag` is the release before `tag` in `gh release list`.
- PR numbers come from the commit subjects of `compare/<prev>...<tag>`:
  `Merge pull request #N` and squash `(#N)` at the end of the subject.
- `jiraKeys` are matched in title, then branch, then body, with the
  `jiraBoards` list (`OTTER`, `SHRIMP`, `SHRMP`, `SIINFOSEC`). The
  matcher is case-insensitive and accepts a space separator (`Otter 802`).
- `notesMissing` are PRs in the compare but not in the release body.
  `notesExtra` are PRs in the body but not in the compare.

### `plan.md`

Fixed sections, in this order:

1. **Summary** — plain language, by feature. For PMs.
2. **Baseline** — one line: run `release-happy-path`.
3. **Changes** — one subsection per PR. Each has one or more test lines:
   `- [R-1112-1] <title> — <steps to check>`. Line IDs are `R-<pr>-<n>`.
4. **Security** — findings from the diff review, each a line
   `- [S-<n>] <title> — <probe or check>`. A line that needs an active probe
   ends with `(staging only)`. PRs reviewed with no finding are listed.
5. **Technical appendix** — per PR: files, migrations, flags, routes, Jira
   links. Ends with "PRs missing from the release notes".

### `plan-lines.json`

The machine form of the `R-`/`S-` lines. `qar plan-lines --input plan.md`
parses the IDs out of the markdown, so the markdown stays the single source
and the user can edit it freely.

```json
{ "lines": [{ "id": "R-1112-1", "title": "…", "section": "changes",
              "pr": 1112, "stagingOnly": false }] }
```

### `results-<env>.json`

Same shape as the Validation results file: `{ id, result, evidence,
severity?, area?, approvedBy?, decision? }` per line, plus one entry with id
`BASELINE` for the suite run. `results-check` validates it against
`plan-lines.json`.

### Release assets

- `regression-plan.md` — replaced on each save (`--clobber`).
- `regression-results-<env>-<YYYYMMDD-HHMM>.md` — one per run, never
  replaced.

### Entering a release that already has a plan

On entering a tag, the tab calls `qar release-status --tag <tag>` first.

- No plan on the release and none local → the Plan phase starts a generation
  session.
- Plan on the release → download it to `.tmp/release/<tag>/plan.md` and open
  the editor. No session starts. A **Regenerate** button starts the session;
  it asks to confirm because it overwrites the plan. **Run** goes to the Run
  phase.
- Local plan exists and differs from the asset → keep the local file, show
  an "unsaved edits" badge, and offer Save or Discard. No silent overwrite in
  either direction.
- Results on the release → the History phase lists them (env, time, counts).
  A run can repeat on any env; each run adds a new asset.
- A tag that does not exist → an error before anything starts.

## Engine commands

In `bin/qar.ts` and `src/engine/release.ts`.

| Command | Does | Output |
|---|---|---|
| `qar release-list` | `gh release list`, newest first, 20 | JSON |
| `qar release-prs --tag v1.6.9` | previous tag; compare → PR numbers; `gh pr view` per PR; Jira keys; release body diff | `prs.json` |
| `qar release-status --tag v1.6.9` | assets on the release, local files, whether the local plan differs from the asset, `canUpload` | JSON |
| `qar release-download --tag … --asset regression-plan.md` | `gh release download` into `.tmp/release/<tag>/` | path |
| `qar release-upload --tag … --file plan.md [--as regression-plan.md]` | `gh release upload --clobber` | asset URL |
| `qar plan-lines --input plan.md` | parses `[R-…]`/`[S-…]` lines; rejects duplicate IDs and sections out of order | `plan-lines.json` |
| `qar results-check --plan plan-lines.json --results results-staging.json --env staging` | the existing gate, extended to accept plan lines as the inventory; with `--env production` rejects a `stagingOnly` line that is PASS or FAIL | problems list |
| `qar results-render --results … --plan …` | builds `results-<env>.md`: counts, each line's result and evidence, screenshot links | path |

Rules:

- All `gh` calls go through one `ghJson()` helper with the repo explicit.
  `managementAppSlug` moves from Go into `config/environments.ts`, and Go
  reads it from there, so both sides read one value.
- `jiraBoards` moves to TypeScript too; Go reads the same list.
- `release-upload` accepts only files under `.tmp/release/<tag>/`.
- No new network hosts: `gh` handles GitHub, and
  `enableWeakerNetworkIsolation` is already set for it.

## The suite

`src/suites/release-happy-path.ts`. Role `researcher`. Steps:

1. Sign in as admin, dashboard visible.
2. Sign in as reviewer, dashboard visible.
3. `studyLifecycleSteps({...})`, the builder `study-happy-path` and
   `study-agreements-happy-path` use, then cleanup.

About 35 steps. Added to the pinned names in
`tests/suites/step-names.test.ts`.

## The skills

Both skills inherit the Validation PTY rules: one command per Bash call, no
`cd`, scratch in `.tmp/`. Neither posts to Jira.

### `qa-release-plan`

`.claude/skills/qa-release-plan/SKILL.md`. Opening prompt from
`gui/prompts/release-plan.md` with `{{tag}}`.

1. `qar release-prs --tag <tag>` → `prs.json`.
2. One subagent per PR, 6 in parallel. Each reads the diff with
   `gh pr diff` and writes `pr-<n>.json`: a plain summary, a technical
   summary, test lines, security notes (auth, input, data exposure, migration
   risk), and the Jira card's acceptance criteria if a key exists.
3. The main session merges the files into `plan.md` in the fixed section
   order. A security finding that needs an active probe is marked
   `(staging only)`.
4. `qar plan-lines --input plan.md` must pass before the session says
   "ready".
5. The session waits. The user edits in the editor or talks. Before every
   edit, Claude re-reads `plan.md`. After every edit, it runs `plan-lines`
   again.
6. On "save": `qar release-upload`. It prints the asset URL and writes the
   `release-saved` rendezvous file.

### `qa-release-run`

Opening prompt from `gui/prompts/release-run.md` with `{{tag}}`, `{{env}}`.

1. `qar release-download` the plan, then `qar plan-lines`.
2. `qar run --suite release-happy-path --env <env>`. Record the result as
   the `BASELINE` line. A failure does not stop the run; the other lines
   still need results.
3. Execute each `R-`/`S-` line in the browser (chrome-devtools MCP, the
   Validation allowlist). On production, skip `(staging only)` lines and
   record them `NOT TESTED` with the reason.
4. Write `results-<env>.json`, pass `results-check`, run `results-render`,
   then `release-upload`.
5. Print the counts and the asset URL.

## The GUI

Tab **Release** (`gui/frontend/src/components/ReleaseTab.tsx`), after
Validation. Three phases, one component each.

- **`ReleasePicker`** — a `Select` from `qar release-list`, or a typed tag.
  On pick it calls `release-status` and goes to Plan.
- **`ReleasePlan`** — full-width editor on top, Claude terminal below (the
  existing `Terminal` component), and a status row between them: the
  `plan-lines` result (green "41 lines" or the problems), the "unsaved
  edits" badge, and the buttons **Save to release**, **Regenerate**, **Run…**.
  Save sends "save the plan" to the PTY, as the Verdict button does. The
  `release-saved` event clears the badge.
- **`ReleaseRun`** — env picker (staging, production only), **Start**,
  terminal, and the live results count read from `results-<env>.json`.
  **History** lists the assets below it.

### Editor

CodeMirror 6: `@codemirror/view`, `@codemirror/state`,
`@codemirror/lang-markdown`, `@codemirror/theme-one-dark` for dark mode. The
Preview toggle renders with the existing `react-markdown` + `remark-gfm`.
Autosave to disk 500 ms after the last keystroke.

### Sync rule

Go watches `.tmp/release/<tag>/plan.md` with `fsnotify` and emits
`plan-changed {mtime, hash}`. The editor applies the change if its buffer is
saved, which autosave makes the usual case. If the buffer has unsaved
keystrokes, it shows a banner: "Claude changed the plan — Reload / Keep
mine". The editor's own writes carry the hash it wrote, so its own saves do
not trigger a reload. The decision is a pure function in
`gui/frontend/src/components/releaseSync.ts`.

### Go bindings

`gui/release.go`: `ListReleases`, `ReleaseStatus(tag)`, `ReadPlan(tag)`,
`WritePlan(tag, text)`, `StartReleasePlanSession(tag)`,
`StartReleaseRunSession(tag, env)`. The session starters follow
`StartValidationSession`: browser + MCP config, `--permission-mode auto`,
the Validation allowlist plus `Bash(qar release-*)`, `Bash(qar plan-lines*)`
and `Bash(qar results-render*)`, and the opening prompt from
`gui/prompts/release-*.md`. `SessionKind` gets `'release-plan' |
'release-run'`.

## Errors

- `gh` not authenticated, or no push right on management-app →
  `release-status` reports `canUpload: false`. The tab shows it before any
  session starts. Save is disabled with the reason.
- A tag with no previous release → `release-prs` fails: "no previous
  release to compare against".
- `release-happy-path` fails → the run continues. The results record the
  `BASELINE` line as FAIL with the failed step name.
- The session exits before "ready" → the `session-ended` event; the tab
  shows the terminal's last output and a Retry button. Partial `pr-<n>.json`
  files stay, so the retry reuses them.
- `plan-lines` rejects the plan on Save → Save is refused; the problems show
  in the status row.

## Security

- Active probes run on staging only. The plan marks them `(staging only)`;
  the run skill skips them on production; `results-check --env production`
  rejects a PASS or FAIL on such a line.
- Subagents read PR diffs only. The only write to management-app is
  `gh release upload`, and `release-upload` accepts only files under
  `.tmp/release/<tag>/`.
- No credentials in the plan. `results-render` redacts any `*_PASSWORD` or
  `*_MFA_*` value that appears in evidence text.

## Testing

- `tests/engine/release.test.ts` — fixtures from v1.6.8/v1.6.9: PR set,
  previous tag, Jira keys (`SIINFOSEC`, `Otter 802`), the notes gap, the
  upload path guard.
- `tests/engine/plan-lines.test.ts` — parse, duplicate IDs, section order,
  the `(staging only)` flag.
- `tests/engine/results.test.ts` — the production rule.
- `tests/gui/releaseSync.test.ts` — the reload decision: own hash, saved
  buffer, dirty buffer.
- `tests/suites/step-names.test.ts` — `release-happy-path` steps.
- `gui/release_test.go` — `ReleaseStatus` from a fake asset list and a temp
  dir.
- Manual: generate the plan for v1.6.9, run it on staging.

## Amendments (2026-10-26, after the first end-to-end run)

### The editor appears only when the plan exists

While the plan session is generating (no `plan.md` yet), the Plan phase shows
only the terminal, with a one-line "Generating the plan…" note where the editor
will be. The editor and its status row appear once `plan.md` exists. A plan
that is downloaded from the release shows the editor at once.

### Save also writes the summary into the release description

On "save the plan", after the asset upload, the plan's `## Summary` section is
written into the GitHub release description (`body`) as a block:

```
<!-- regression-summary -->
## What changed
<the Summary section's text>
<!-- /regression-summary -->
```

Placement: if the markers already exist, the block between them is replaced.
Otherwise the block is inserted before the first line that is exactly `------`
(the separator between "Related Releases" and the PR table in the generated
notes). If there is no such line, the block is appended to the end. The rest of
the body is never changed. `qar release-summary --tag <tag> --input <plan.md>`
does this (`gh release edit <tag> --notes-file`), and the plan skill runs it as
the step after `release-upload`.

### Changes are ordered by impact

Each per-PR subagent rates the PR's `impact`: `high` (a user-visible behaviour
change, a data migration, auth or permission change, or a security fix),
`medium` (a visible UI change with no behaviour change, an email change, an
admin-only change), `low` (a dependency bump, CI, lint, docs, tests only). The
plan's Summary lists the feature groups with high-impact items first, and the
Changes section orders its `### #<pr>` subsections by impact (high, medium,
low), then by PR number within an impact. Each subsection heading ends with the
impact in brackets, e.g. `### #1110 OTTER-794 … [high]`. The Technical appendix
stays in PR-number order. Security is ordered by severity as before.

### Decisions after the final review

1. **The public asset is `testing-plan.md`** (replaces `regression-plan.md`) and
   carries Summary, Baseline, Changes and Technical appendix only. The repo is
   public, so the Security section stays local in `.tmp/release/<tag>/plan.md`
   and is never uploaded; `release-upload` refuses a file that contains one.
   The release description gets only the Summary.
2. **Security lines run on staging only**, only from the machine that holds the
   local plan. Their results go to a local `security-results-<env>.md`, shown to
   the human runner in the session, never uploaded. On request the session may
   file one Jira card with them (`qar jira-create-issue`), the run session's
   only Jira write. On production they are `NOT TESTED`.
3. **The baseline suite runs from the GUI.** The Run phase's Start runs
   `release-happy-path` through Go (`RunBaseline(tag, env)`, the Testing tab's
   engine spawn, outside the sandbox), streams step progress, writes
   `.tmp/release/<tag>/baseline-<env>.json`, then starts the Claude run session,
   which reads that file for the `BASELINE` line and never runs `qar run`.
4. **Writes to management-app**: `gh release upload` and
   `gh release edit --notes-file` only. Release sessions get a release-specific
   allowlist (read-only Jira issue tool, `gh pr view/diff`, the `qar release-*`,
   `plan-lines`, `results-*`, `session-login` commands, `jira-create-issue` in
   the run session, Read/Write/Edit, Agent in the plan session, chrome-devtools
   in the run session), not the Validation list.
5. **Completeness is gated**: `plan-lines` reads `prs.json` beside the plan and
   reports every PR without an `R-<n>-*` line, and any `R-` line whose PR is not
   in the compare.

Clarification: because the public asset cannot list Security lines, a production
run has none to record — they are absent from the public results, not
`NOT TESTED`. The local `security-results-<env>.md` exists only for staging.

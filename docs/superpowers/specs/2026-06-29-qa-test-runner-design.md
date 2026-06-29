# QA Test Runner — Design Spec

**Date:** 2026-06-29
**Status:** Approved design, ready for implementation planning

## Purpose

Give non-technical QA staff a simple way to run functional checks against the
**Management App** (`../management-app`) running in live **QA** and **staging**
environments. Staff pick a curated test suite and an environment, hit Run, and
review a clear pass/fail result with screenshots and video — for every run, pass
or fail. A contained plain-English mode lets them run ad-hoc exploratory checks
without anyone writing new test code.

This tool is **separate** from management-app's existing Playwright suite. That
suite fakes authentication (`E2E_FAKE_CLERK`) and runs against a
Playwright-owned local app instance for CI. This tool runs against **real
deployed environments with real authentication** — a different job requiring a
different tool.

## Audience & usage model

- **Users:** non-technical / manual QA staff. They never write or maintain code.
- **Primary workflow (A):** run pre-built, curated suites authored by developers
  (e.g. "Sign in", "Create a study", "Invite a user"). Staff choose
  *suite + environment*, run, and read results.
- **Secondary workflow (B, "a bit of"):** a plain-English exploratory mode for
  one-off checks, implemented as a Claude Code skill (see "Plain-English mode").
- **Surfaces:** a desktop GUI (primary) and a simple interactive CLI (same
  engine), both thin shells over one engine.

## Architecture

Four well-bounded units sit under one **engine**; three thin shells (GUI, CLI,
AI mode) drive that engine. No test logic lives in the shells.

```
 Desktop GUI (Tauri)   Simple CLI   Plain-English mode (Claude Code skill)
        └──────────────────┴──────────────────┘
                           │ all call engine.run(...)
                  ┌────────▼─────────┐
                  │   Test Engine    │  resolve env → login → run suite →
                  │                  │  record → cleanup → emit results
                  └────────┬─────────┘
         ┌──────────────┬──┴───────────┬──────────────┐
         ▼              ▼              ▼              ▼
   Env config     Auth module      Suites      Results/recorder
   (URLs+keys)   (Clerk OTP login) (Playwright)  + cleanup
```

### Units (each has one job)

1. **Env config** — given an environment name, returns everything needed to
   target it: base URL, that env's Clerk testing keys, the cleanup-API endpoint
   and secret. Consumers never hardcode URLs or secrets.
2. **Auth module** — given an env + role, returns a logged-in browser session
   using **Clerk testing-mode OTP** (deterministic, no real email/SMS
   round-trip). Isolated so Clerk changes touch only this unit.
3. **Suites** — curated Playwright specs (developer-authored), each a named,
   listable flow. They consume Env + Auth; they don't know about any shell.
4. **Results/recorder + cleanup** — wraps every run to record screenshots and
   video **always**, collect per-step pass/fail, and call the cleanup API as a
   **guaranteed teardown**. Produces a self-contained local result bundle.

### Key principle

The engine is the only thing that knows *how* to run; the shells only know *how
to ask*. This is what lets the CLI exist "for free" alongside the GUI and keeps
the non-deterministic AI mode from contaminating the deterministic path.

## Run lifecycle & data flow

The engine runs this sequence regardless of which shell triggered it:

1. **Select** — shell calls
   `engine.run({ suite, env, role })`.
2. **Resolve** — Env config returns
   `{ baseURL, clerkTestKeys, cleanupApi, cleanupSecret }`.
3. **Auth** — Auth module logs in via Clerk testing-mode OTP → authenticated
   browser session.
4. **Run** — suite executes against `baseURL`, emitting a step event per action
   (start / pass / fail).
5. **Record** — recorder captures screenshots + video continuously; attaches
   per step.
6. **Cleanup** — engine calls the cleanup API as a **guaranteed teardown**:
   fires on pass, fail, or crash.
7. **Emit** — engine writes a result bundle and streams live status to the
   shell.

### Live feedback

The engine emits step events as they happen so the GUI shows a running checklist
(`✓ Logged in → ✓ Opened studies → ⏳ Creating study…`), not a frozen spinner.
For non-technical staff, visible progress is what makes it trustworthy.

### Result bundle

One self-contained folder per run:

```
results/2026-06-29_143022_create-study_staging/
  summary.json        machine-readable: steps, pass/fail, timings, env, account, mode
  report.html         human view: step list + inline screenshots + embedded video
  video.webm          full-run recording (always, even on success)
  screenshots/        per-step stills
  trace.zip           Playwright trace (for a developer to debug a failure)
```

`results/` is git-ignored.

### Recording policy

Record screenshots **and** video on **every** run, not just failures — for
manual QA the recording *is* the deliverable, so they can review actual behavior
even when a test passes. This deliberately departs from management-app's config
(`screenshot: 'only-on-failure'`, `trace: 'retain-on-failure'`).

### Cleanup (guaranteed teardown)

The cleanup API (management-app PR #839) deletes **by id**, not by tag:
- `DELETE /api/qa/users/[userId]` — deletes a user (DB + backing Clerk account)
- `DELETE /api/qa/studies/[studyId]` — deletes a study (DB + S3 folder)

Both are non-prod gated (`PROD_ENV === false`) and authorized by the **caller's
Clerk session** — it must be an SI admin (`requireQaAdmin` → `isSiAdmin`). There
is no separate cleanup secret: cleanup calls reuse the run's authenticated
session (so cleanup-capable runs log in as the **admin** role, or the engine
obtains an admin session for teardown).

- **Id-tracked:** the engine records the id of every entity a run creates (study
  ids, user ids) and, on teardown, calls the delete endpoint for exactly those
  ids. This is precise and shared-env safe without wiping all test data. (A
  per-run tag is still woven into created titles for human-readable reports and
  manual cleanup, but the *delete* is id-based, not pattern-based.)
- **Unconditional:** wrapped so it always fires — pass, fail, or crash. Test
  data never accumulates in QA/staging.
- **Never swallowed:** if cleanup itself fails, that is surfaced as a loud
  warning on the result (see error handling), not hidden.

### Concurrency

Designed for **one-at-a-time** operation for now. Per-run tagging means
concurrent runs would be data-safe, but no queuing/locking UI is built in v1
(YAGNI). This is an explicit, revisitable assumption.

## Error handling & failure model

Principle: every failure produces a clear, human-readable outcome and never
leaves test data behind. The engine distinguishes failure **categories**,
because "the app has a bug" and "the test tool broke" need different responses
from a non-technical tester.

| Category | Example | What QA sees | Cleanup runs? |
|---|---|---|---|
| **App assertion failed** | Expected dashboard to show new study, it didn't | ❌ red step + screenshot at failure + video. "Looks like a real bug — share this report." | Yes |
| **Environment / infra** | QA env down, 500s, network timeout | ⚠️ amber, distinct from a bug. "Staging looks unavailable — not a test failure." | Yes (best-effort) |
| **Auth failure** | Clerk OTP rejected, test account locked | ⚠️ "Couldn't log in as org-admin — check test account." | Yes (best-effort) |
| **Cleanup failure** | Cleanup API errored / partial | 🔶 Loud warning even on a passing run: "Test passed but cleanup failed — leftover data may need manual removal." | N/A (this *is* cleanup) |
| **Tool / engine crash** | Bug in the engine itself | 🔶 "The test tool hit an error" + log path for a developer. | Yes (teardown guard) |
| **AI gave up** (AI mode only) | Agent couldn't carry out the instruction / ambiguous | 🔷 "I couldn't figure out how to do that." Visually distinct from a real app failure. | Yes |

### Implications

- **Cleanup teardown is unconditional** across all categories except its own
  failure, which is reported distinctly.
- **App-bug vs. environment/auth vs. tool-problem is the primary distinction QA
  sees** — a non-technical tester must not file a bug ticket when staging is
  simply down. Category drives the headline message and color.
- **No silent failures:** partial cleanup, skipped steps, and swallowed errors
  are always surfaced in `summary.json` and the report.

## Plain-English (AI) mode

Implemented as a **Claude Code skill** (`.claude/skills/qa-explore/`), so it runs
through existing Claude Code accounts — no separate AI API keys or billing in
this tool.

- **Borrows the engine's deterministic spine:** the skill calls the same engine
  for env resolution, Clerk-OTP login, recording, and the **guaranteed cleanup
  teardown**. It does not reinvent these.
- **Owns only the browser-driving intelligence:** it drives the browser via
  Claude Code's existing browser tooling (Playwright MCP / chrome-devtools MCP)
  to carry out the plain-English instruction.
- **Same output:** emits the same step events and writes the same result bundle
  as a curated suite, so the GUI renders AI runs identically.
- **Result labeling:** AI-mode results are clearly marked *exploratory /
  AI-driven* and carry the "AI gave up" failure category, kept visually distinct
  from a real app bug — these runs are inherently less certain.

### GUI invocation (headless)

QA stays in the desktop GUI. An "Exploratory" mode offers a text box; on Run the
GUI invokes the Claude Code skill headlessly as a subprocess (`claude -p` with
the skill), pointed at the chosen env/role. The skill streams step events back;
the GUI shows the same running checklist and final report. QA never sees Claude
Code itself.

### Boundary that keeps determinism safe

The engine owns env/auth/recording/cleanup for **both** paths. The skill owns
only the non-deterministic "figure out how to do this in the browser" part. So
an AI run that goes sideways still cannot leave test data behind (cleanup fires)
and still produces reviewable evidence.

## Tech stack

- **Engine + suites:** TypeScript + Playwright — the team's existing tool,
  native always-on video/screenshots/trace, reuses selector/helper patterns from
  the existing suite. Suites point at live URLs instead of the faked-auth local
  server.
- **Desktop GUI:** **Tauri** — small/light install for non-technical staff; Rust
  shell wrapping a web UI; spawns the Node engine and the `claude -p` skill
  subprocess. (Electron is a fallback only if the team wants all-JS.)
- **CLI:** the same Node engine behind a tiny **interactive** command (menus, not
  flags) so it stays simple for non-technical use.
- **AI mode:** Claude Code skill, invoked headlessly via `claude -p`.

## Repo layout

Standalone in the `shotsy` repo (separate from management-app):

```
qatest/
  engine/
    env/        Env config: URLs, Clerk test keys, cleanup API
    auth/       Clerk testing-mode OTP login per role
    recorder/   always-on screenshots+video, step events, result bundle
    cleanup/    per-run-tagged teardown (guaranteed)
  suites/       curated Playwright specs (developer-authored)
  cli/          thin interactive CLI shell
  gui/          Tauri desktop shell
  .claude/skills/qa-explore/   plain-English AI mode skill
  results/      run bundles (git-ignored)
```

## Configuration & secrets

- Environment definitions in a committed config file (one entry per env: QA,
  staging — name, base URL). Each env lists its three test-account roles —
  **admin, researcher, reviewer** — declaring which roles exist and how to find
  their credentials (e.g. env-var names), not the secrets themselves.
- Clerk publishable/secret keys and the per-role test-account credentials live in
  an untracked `.env` / secrets store, **never committed** — one set per
  environment. There is no separate cleanup secret (cleanup is authorized by the
  admin role's Clerk session).

## Testing strategy (for the tool itself)

- **Engine units in isolation** — env resolution, result-bundle shape, and
  especially the **cleanup teardown guard**: assert it fires on pass, fail, and
  crash, and that it scopes to the per-run tag. These are correctness-critical.
- **Auth module** — smoke-tested against a real env's Clerk testing mode.
- **Suites** — are themselves the tests; validated by running against QA.
- **Recorder** — verified by asserting a completed run produces video, per-step
  screenshots, and a valid `summary.json`.
- **No mocking of our own components** (per project preference); cleanup/auth
  tested against real testing-mode endpoints where feasible.

## Out of scope (v1)

- Shareable/hosted reports, bug-tracker (Jira) integration, run history/trends —
  deliberately deferred. The result bundle is self-contained, leaving room to add
  these later.
- Concurrency / queuing UI (one-at-a-time assumption above).
- Cross-browser / mobile viewports (Chromium only to start, matching the existing
  suite's active project).

## Resolved during planning

- **Cleanup API** — management-app PR #839 adds
  `DELETE /api/qa/users/[userId]` and `DELETE /api/qa/studies/[studyId]`, non-prod
  gated, authorized by an SI-admin Clerk session. Cleanup is **id-based** (the
  engine tracks created ids), not tag-based. No separate secret.
- **Clerk login** — QA/staging use **Clerk testing mode** (`+clerk_test` emails,
  fixed OTP `424242`); the Auth module uses `@clerk/testing`.
- **Role accounts** — each env declares **admin, researcher, reviewer** in config.

## Open questions to confirm at implementation time

- **Test-account inventory** — the exact `+clerk_test` email per role per env, and
  that each env's accounts have the right org membership/roles (admin must be an
  SI admin so cleanup is authorized).
- **GUI ↔ skill bridge** — exact `claude -p` invocation and the step-event
  streaming format the GUI consumes (deferred; GUI is a later phase).

# QA Runner GUI — Design Spec

**Date:** 2026-06-29
**Status:** Approved design, ready for implementation planning
**Builds on:** `2026-06-29-qa-test-runner-design.md` (the engine + CLI, now implemented)

## Purpose

Give non-technical QA staff a desktop GUI to run the existing curated Playwright
suites and a plain-English (AI) exploratory mode against live QA / staging / PR
preview environments — watching the run happen and reviewing pass/fail with
video and per-step screenshots. Testers can also **pull the latest dev-authored
suites** from GitHub, and **promote a successful exploratory run into a real,
committed suite** (via a PR for dev review).

The GUI is a **thin Tauri shell** over the already-built engine. The guiding
principle from the engine spec holds: *the engine knows how to run; shells only
know how to ask.* The GUI either spawns an engine subprocess and renders its
`StepEvent` stream + result bundle, or runs a git/gh operation.

## Audience & usage model

- **Users:** non-technical / manual QA staff, running locally on their own Mac.
- **Run curated suites:** pick environment + role + suite → Run → watch → review.
- **Run exploratory tests:** type a plain-English instruction → Run → watch →
  review; if it's good, save it as a suite (opens a PR).
- **Collaborate:** pull the latest dev-authored suites; contribute new suites by
  promoting exploratory runs through a reviewed PR.
- Testers primarily *run* tests; they *may* author via the AI-promote flow, but
  generated suites are dev-reviewed before joining the regression set.

## Execution model

**Local.** The Tauri app spawns the Node engine + Chromium on the tester's own
machine (no server). Self-contained, works against any reachable URL. The GUI
lives inside a clone of this repo (so "pull latest tests" operates on that
clone).

## Architecture

```
┌──────────────────────── Tauri GUI (tester's Mac) ────────────────────────┐
│  Tabs:  [ Suites ]   [ Exploratory ]            [⟲ Pull latest tests]     │
│  Suites:      env/role/suite dropdowns → ▶ Run                            │
│  Exploratory: env/role + plain-English box → ▶ Run → (on success) Save→PR │
│  Both render: live step checklist + headed Chromium window + result bundle│
└───────────────┬───────────────────────────────────────────┬──────────────┘
                │ spawns child process                        │ git / gh
                ▼                                             ▼
   ┌────────────────────────────┐                  ┌────────────────────┐
   │ curated:  qatest run ...    │                  │ git pull (suites)  │
   │ AI:       claude -p qa-     │                  │ branch+commit+push │
   │           explore ...       │                  │ gh pr create       │
   └─────────────┬──────────────┘                  └────────────────────┘
                 │ both emit StepEvent JSON (stdout) + write a result bundle
                 ▼
       ┌──────────────────────────────────────────────┐
       │  Engine (existing) + new thin CLI surface      │
       │  runEngine · resolveEnv/resolvePrEnv · Recorder│
       │  · CleanupClient (guaranteed teardown)         │
       │  qa-explore skill: drives browser via MCP,     │
       │   shells qatest login/cleanup, emits same      │
       │   StepEvents + bundle, can codegen a TS suite  │
       └──────────────────────────────────────────────┘
```

### The unifying contract

Every run — curated or AI — is **a child process that streams `StepEvent` JSON
on stdout and writes a result bundle**. The GUI is identical for both; only the
spawned command differs (`qatest run` vs `claude -p qa-explore`). The GUI never
reaches into engine internals; it reads stdout and the bundle on disk.

### Three new pieces (beyond today's engine)

1. **`qatest` CLI** — promote today's `bin/run-pr.ts` into a real CLI with
   subcommands (`run`, `login`, `cleanup`, `codegen`) and a `--json` step-event
   output mode. The GUI and the skill both call it.
2. **`qa-explore` skill** — a Claude Code skill that drives the browser via
   Claude Code's browser MCP, reuses the engine CLI for login/cleanup, emits the
   same StepEvents + bundle, records an action trace, and (on save) generates a
   TS suite.
3. **Tauri GUI** — dropdowns, live checklist, headed-browser run, result panel,
   `[Pull latest tests]`, and `[Save as suite → PR]`.

## Run lifecycle

Both run types share the GUI-side lifecycle; only the spawned command differs.

**Curated suite run:**
1. Tester picks env / role / suite → ▶ Run.
2. GUI spawns `qatest run --suite <s> --env <e> --role <r> --json`.
3. Engine runs **headed** Chromium (tester watches the real browser).
4. Engine emits one JSON line per step event to stdout:
   `{"type":"step","name":"Open dashboard","status":"running"}` then
   `{"type":"step","name":"Open dashboard","status":"passed","screenshot":"screenshots/01-..png"}`.
5. GUI parses each line → ticks the live checklist.
6. On finish: `{"type":"result", ...RunResult}` and the bundle is written.
7. GUI shows pass/fail banner, plays `video.webm`, lists per-step screenshots,
   shows cleanup status (✓ / ⚠ with HTTP code).

**Exploratory (AI) run** — same shape, different command:
- GUI spawns `claude -p` with the `qa-explore` skill, `--env`, `--role`,
  `--instruction "<plain English>"`.
- The skill shells `qatest login` → drives the browser via MCP → emits the SAME
  `{"type":"step",...}` lines → shells `qatest cleanup <ids>` (guaranteed) →
  writes the same bundle → emits `{"type":"result",...}`.

The GUI's stdout parser is **identical** for both.

### StepEvent JSON — the one contract

`StepEvent` already exists as a type. This formalizes printing it as
newline-delimited JSON on stdout (a `--json` CLI mode) and having the skill emit
the same shape. Two envelope types: `{"type":"step", ...StepEvent}` during the
run and `{"type":"result", ...RunResult}` at the end.

### Headed browser

`defaultDeps` gains a headed launch (`headless: false`) when invoked from the GUI
(e.g. a `--headed` flag on `qatest run`), so the tester watches the real
Chromium drive itself. The recorded `video.webm` is still saved into the bundle
for replay after the run.

## Error handling

Unchanged from the engine: `failureCategory`
(app-assertion / environment / auth / cleanup / tool-crash / ai-gave-up) drives
the banner color + message. Cleanup failures show loudly with the captured HTTP
status. The GUI adds no new failure semantics — it renders what the engine
reports.

## AI exploratory flow + suite generation

**Running an exploratory test:** the GUI spawns the `qa-explore` skill via
`claude -p`. The skill prompt instructs Claude to:
1. Shell `qatest login --env <e> --role <r>` → authenticated session (reuses the
   engine's real Clerk + MFA login — deterministic, not the AI's job).
2. Drive the browser via Claude Code's browser MCP to satisfy the instruction,
   and for **each concrete action**: (a) emit a `StepEvent` JSON line, and
   (b) append the action to an **action trace** (`{action, selector, value}`).
3. Track any created entity ids (study / user) for cleanup.
4. **Always** shell `qatest cleanup <ids>` at the end (guaranteed teardown).
5. Write the same result bundle (plus the action trace) and emit the result.

The **action trace** is the raw material for codegen; without it, "save as
suite" would be guessing.

**Promoting a successful run to a committed suite:**
- After a green exploratory run, the GUI shows `[ Save as suite → PR ]`.
- Tester names it; `qatest codegen` turns the action trace into a real Playwright
  suite using the existing `Suite` interface + `ctx.step()` pattern.
- The GUI **typechecks the generated file** before pushing; a non-compiling
  result is surfaced as an error, not pushed.
- The GUI creates a branch, commits the suite, pushes, and opens a PR via `gh`.
  A dev reviews / hardens / merges before it joins the shared suite set.

**Honesty caveat (stated so expectations are right):** AI-generated selectors
from an action trace can be brittle. "Save as suite" produces a **strong,
dev-reviewed starting point** for a real suite — not a guaranteed-perfect one.
The PR gate is what makes this safe; nothing AI-generated reaches `main`
unreviewed.

## Collaboration / git

- **Pull latest tests:** a `[⟲ Pull latest tests]` button runs `git pull` in the
  repo clone. Because suites are TS run via `tsx`, new `src/suites/*.ts` files
  work with no build step. The Suite dropdown reads from `listSuites()` /
  auto-discovery of `src/suites/*.ts`; after a pull the GUI re-reads it.
- **Promote (save as suite):** branch + commit + push + `gh pr create` (above).
  Requires the tester to have `git` and `gh` available and authenticated.

## Tech stack

- **GUI shell:** Tauri (Rust shell + web frontend) — small footprint; spawns
  child processes (`qatest`, `claude -p`, `git`, `gh`) and reads stdout.
- **GUI frontend:** React + TypeScript + Vite — matches team familiarity; kept
  minimal (thin shell).
- **Engine CLI:** TypeScript via `tsx` — promote `bin/run-pr.ts` into a real
  `qatest` command. No new runtime.
- **AI mode:** the `qa-explore` Claude Code skill (markdown prompt + the engine
  CLI it shells out to). Runs through existing Claude Code accounts — no separate
  AI keys/billing.

## Repo structure (additions)

```
qatest/
  bin/
    qatest.ts                CLI entrypoint (run | login | cleanup | codegen), --json
  src/
    cli/
      commands/              run.ts, login.ts, cleanup.ts, codegen.ts
      step-stream.ts         format StepEvent as newline JSON on stdout
    codegen/
      action-trace.ts        the trace type the skill records
      generate-suite.ts      action trace → Suite .ts source
    suites/                  (existing) + auto-discovery so generated suites appear
  .claude/skills/qa-explore/
    SKILL.md                 the skill prompt (replaces today's README stub)
  gui/                       Tauri app (replaces today's README stub)
    src-tauri/               Rust shell: spawn processes, git/gh, file paths
    src/                     React: RunScreen, SuitesTab, ExploratoryTab,
                             StepChecklist, ResultPanel, SyncButton, SaveAsSuite
    package.json
```

## Testing strategy

- **Engine CLI:** unit-test the step-stream formatter (StepEvent → JSON line) and
  arg parsing. `run`/`login`/`cleanup` are thin wrappers over already-tested
  engine code.
- **Codegen:** unit-test `generate-suite.ts` — a sample action trace produces TS
  that (a) typechecks and (b) matches the `Suite` interface. Riskiest new logic;
  gets real coverage.
- **GUI:** React components that parse the StepEvent stream and render the
  checklist are unit-tested with a fake stream. Tauri/process-spawn glue is
  validated by running the app (manual/live).
- **Skill:** validated live (agent prompt, not unit-testable); the deterministic
  parts it calls (login/cleanup) are already covered.
- **No mocking our own code** (project preference); codegen/stream tested against
  real outputs.

## Out of scope (this plan)

- Run history / trends, hosted server, bug-tracker integration.
- A packaged installer (.dmg) + bundled Chromium provisioning — deferred to a
  later packaging plan. v1 runs via `pnpm tauri dev` / a simple launch from the
  repo clone.
- Chromium assumed installed (as today).
- Saved-prompt-only library (we chose AI→code-suite generation instead).

## Dependencies / assumptions

- Tester has a clone of this repo, with `git` + `gh` authenticated (for pull /
  promote), and Claude Code installed (for exploratory mode).
- The engine, suites, auth (real Clerk + MFA), recorder, and cleanup client are
  already implemented and validated live (see the engine spec).
- Cleanup endpoint correctness is a server-side concern being addressed
  separately; the GUI surfaces whatever the cleanup client reports.

## Open questions to confirm at implementation time

- **`qatest login` session hand-off:** exact shape of what `login` outputs so the
  skill can reuse the authenticated session (cookie string vs. storage-state file
  the skill points the MCP browser at).
- **Action-trace fidelity:** what Claude Code's browser MCP exposes for capturing
  concrete selectors/values, and how faithfully that maps to Playwright locators
  for codegen.
- **Suite auto-discovery vs. registry edit:** whether generated suites are
  picked up by globbing `src/suites/*.ts` or require a registry entry (and
  whether codegen edits the registry).
- **gh auth on tester machines:** how testers authenticate `gh` for the promote
  PR flow.

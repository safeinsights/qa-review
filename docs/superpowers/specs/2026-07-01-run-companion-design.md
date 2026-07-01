# Run Companion — Claude in the test run

**Date:** 2026-07-01
**Status:** Design approved, pending spec review

## Problem

The QA Runner has two separate worlds:

- **Suites tab** — `qar run --json --screencast` runs a suite. The *engine* drives
  the browser through the suite's `steps[]` and streams JSON step envelopes to the
  React UI (StepChecklist + live BrowserPanel + recording/artifacts). No Claude.
- **Author a Suite tab** — `qar session` boots a logged-in browser with a CDP port;
  a `claude` PTY drives *that* browser via the `chrome-devtools` MCP to author a new
  suite from scratch.

They don't meet. During a run there is no way to ask Claude "why did step 3 fail?",
have it poke the frozen browser to diagnose, or fix/extend the suite in place. This
design brings a Claude companion into the run.

## Goals

A Claude companion, available during and after a Suites run, that can:

1. **Answer questions about the run** — read step results, errors, screenshots,
   console, current URL, and explain.
2. **Debug interactively** — when the run is paused or errored, drive the *frozen
   run browser* (snapshot/click) to diagnose.
3. **Fix/edit the suite live** — edit `src/suites/<name>.ts` (selectors, steps).
4. **Add new steps** — explore a new step in the paused browser, append it to the
   suite.

## Core model: **idle = drivable**

The single organizing principle. In a run the engine owns the browser; Claude and
the engine must not drive it concurrently. So:

- **While the engine is running** a step, the companion is **read-only** — it
  answers questions from the run's persisted state, but does not touch the browser.
- **When the engine is idle** — the run is **paused** (existing pause-before-step
  machinery) or **stopped on an error** — the browser is frozen at that point and
  the companion **may drive it** (snapshot, click, explore, and thereby fix/add
  steps).
- **Resume** (or the next **Run**) hands control back to the engine.

This sidesteps concurrent-control races entirely: the engine is genuinely idle at
exactly the moments Claude takes the wheel.

## Architecture

Three pieces of connective tissue bridge the run world and the companion:

1. **The run browser exposes a CDP endpoint.** `qar run`'s browser is launched with
   `--remote-debugging-port` (as `qar session` already does), so
   `chrome-devtools-mcp` can attach via `--browserUrl`. The CDP port is emitted to
   the GUI on the screencast envelope.
2. **The engine persists live run state to disk.** As step/result envelopes stream,
   the engine writes `<bundleDir>/run-state.json`. Screenshots already land in the
   bundle dir. Claude reads both with the `Read` tool — no new protocol.
3. **The GUI spawns a companion Claude lazily**, pointed at (a) the run's CDP port
   via the existing `writeSessionMcpConfig` plumbing and (b) a new
   `qa-run-companion` skill.

### Why the launch flag, not a proxy

`chrome-devtools-mcp` attaches to an HTTP/WS debug endpoint (`--browserUrl`). The
screencast uses a *Playwright* CDP session (`page.context().newCDPSession(page)`),
which rides Playwright's own connection and does **not** open the HTTP debug port
Claude needs. So Claude needs its own attach point.

Two options were considered:

- **Launch flag (chosen):** add `--remote-debugging-port=<freePort>` to the run's
  `chromium.launch`. This is the exact mechanism the Author tab already uses in
  production (`qar session` → `writeSessionMcpConfig` → `--browserUrl`). Reusing it
  means the companion and the authoring session share one battle-tested attach path.
- **Engine proxies CDP (rejected):** even a proxy must *host* an HTTP/WS endpoint
  for `chrome-devtools-mcp` to hit, then relay to the real browser — new
  multiplexing code that merely reproduces what the launch flag gives for free, and
  more tightly coupled to CDP's evolution. If interposition is ever needed
  (recording/sandboxing Claude's CDP traffic), a proxy can be added at the same seam
  later without paying for it now.

## Component changes

### Engine

- **`src/engine/run.ts` `openBrowser`:** launch Chrome with
  `--remote-debugging-port=<freePort>`. Reuse the `freePort()` + retry-once logic
  from `src/cli/commands/session.ts` (the launched port can be taken in the TOCTOU
  window). This is the single launch path for **all** runs, whether or not Claude is
  used — the "always-on" cost is a localhost-only debug port open for the run's
  duration, identical to today's Author tab.
- **`src/engine/types.ts` `ScreencastInfo`:** add `cdpPort: number` alongside the
  existing `port`. The `--screencast` path already emits this envelope at run start;
  it now carries the CDP port too.
- **Live run-state file:** as each step/result envelope is emitted, the engine
  writes/updates `<bundleDir>/run-state.json` — the accumulated steps (name, status,
  error, screenshot rel-path, url, console) plus the final result. Best-effort:
  writing this file must never fail the run.

### GUI (Go)

- **Screencast envelope parsing:** capture `cdpPort` from the screencast envelope in
  addition to the screencast `port`, and hold it on the run's state so the companion
  spawn can reach it.
- **Lazy companion spawn:** on first "Ask Claude" for a run, spawn a `claude` PTY
  reusing `writeSessionMcpConfig(cdpPort)` — pointed at the **run's** CDP port — and
  the existing PTY plumbing (`pty.go`, `WriteToPty`, `ResizePty`, PTY output events).
  One companion at a time. Torn down when the run screen unmounts or a new run
  starts. Seed its first message via the same split-text-then-CR `submitToPty` used
  by the Author flow.
- **Allowlist:** reuse `authoringAllowedTools` (chrome-devtools MCP, `qar`,
  `Read`/`Write`/`Edit`, the safe read-only shell helpers).

### GUI (React)

- **`ScreencastInfo`/RunScreen:** read `cdpPort` from the screencast envelope.
- **"Ask Claude" toggle in the live-browser top bar.** The toggle button lives in
  the browser panel's top bar (the strip with the live-dot + URL), to the right of
  the URL, alongside the current step title (the step the run is paused before, or
  the step the engine is on). This bar is present only in the LIVE-browser view —
  i.e. during a run, at a pause, or on an error — which is exactly when the companion
  can drive the browser. On a **finished** run the right panel flips to the
  recording replay (no top bar), so the toggle is not shown there; a finished-run
  companion entry point (in the RecordingPanel header) is a possible follow-up, out
  of scope for the initial build.
- **Bottom drawer.** Clicking the toggle opens a Mantine v9
  `<Drawer position="bottom">` that slides up from the bottom, **non-modal**
  (`withOverlay={false}`, `closeOnClickOutside={false}`, `trapFocus={false}`,
  `lockScroll={false}`) — so the user keeps full interaction with the run screen
  (click steps, watch/scroll the live browser) while Claude is open. Only the toggle
  / Hide / Esc closes it. On pause/error the toggle is **visually emphasized**
  (filled + hint) to point the user at it, but the companion still only spawns when
  the user actually opens the drawer — the drawer does not auto-open and does not
  auto-spawn Claude, preserving the lazy-spawn promise. Renders the existing
  `Terminal` component against the companion PTY, mounted after the slide-in
  transition so xterm sizes to the final panel height. Closing the drawer keeps the
  PTY alive (reopening resumes the conversation); it's torn down when the run screen
  unmounts or a new run starts.
- **Read-only affordance:** while the engine is mid-step (running, not paused/
  errored), the drawer indicates the companion is read-only — "pause or stop to let
  Claude drive."

### New skill: `qa-run-companion`

Scoped to run-companion mode, distinct from `qa-explore`'s author-from-scratch mode:

- Read `<bundleDir>/run-state.json` + screenshots to answer questions about the run.
- When the run is **paused or errored**, drive the frozen browser via
  `chrome-devtools` MCP to diagnose.
- Edit `src/suites/<name>.ts` to fix/add steps, following the same conventions as
  qa-explore (`ctx.step`, stable selectors `getByRole`/`getByLabel`/`getByTestId`,
  `ctx.state` for cross-step values).
- **Never runs `qar run` itself.** After editing, it tells the user to **press Run**
  — the GUI owns the authoritative run (build-suites → live browser → step
  checklist). This keeps Claude's editing cleanly separated from the GUI's run and
  avoids a Claude verify-loop fighting the GUI for the browser.

## Lifecycle

- **Spawn on first use.** No companion process/tokens for runs where nobody asks.
  On first drawer-open, spawn attached to the run's CDP + run-state file.
- **One companion at a time.** Tear down on run-screen unmount or when a new run
  starts.

## The re-run loop

Claude edits `src/suites/<name>.ts` and says "fixed — press Run." The user presses
the GUI's Run button; the normal run screen recompiles (`build-suites`) and re-runs
with the live browser + step checklist. Claude owns editing/diagnosis; the GUI owns
the authoritative run.

## Control / ownership rules (safety model)

| Engine state        | Browser        | Companion capability                    |
|---------------------|----------------|-----------------------------------------|
| Running a step      | Engine-driven  | **Read-only** (answers from run-state)  |
| Paused before step  | Frozen         | **May drive** (snapshot/click/edit/add) |
| Errored / stopped   | Frozen         | **May drive**                           |
| Resume / next Run   | Engine retakes | Back to read-only                       |

The GUI discourages/prevents driving while the engine is mid-step.

## Out of scope

- Merging the Suites and Author tabs into one screen (companion is a drawer on the
  existing run screen; Author tab stays as-is for from-scratch authoring).
- Auto re-run on file save (re-run is an explicit GUI Run press).
- A persistent cross-run companion (spawn is per-run, lazy).
- Concurrent engine+Claude driving of the browser (explicitly avoided by the
  idle=drivable model).

## Key files

- `src/engine/run.ts` — `openBrowser` gains `--remote-debugging-port`; run-state
  persistence.
- `src/cli/commands/session.ts` — source of the `freePort()` + retry launch pattern
  to reuse.
- `src/engine/types.ts` / `src/cli/step-stream.ts` — `ScreencastInfo.cdpPort`.
- `gui/app.go` — companion spawn (reuses `authoringAllowedTools`, `submitToPty`,
  PTY plumbing); screencast `cdpPort` capture.
- `gui/paths.go` — `writeSessionMcpConfig` reused for the run's CDP port.
- `gui/pty.go` — existing single-PTY machinery.
- `gui/frontend/src/components/RunScreen.tsx` — "Ask Claude" drawer + toggle,
  read-only affordance, `cdpPort` capture.
- `gui/frontend/src/components/Terminal.tsx` — reused for the companion PTY.
- `.claude/skills/qa-run-companion/SKILL.md` — new skill (models on
  `.claude/skills/qa-explore/SKILL.md`).

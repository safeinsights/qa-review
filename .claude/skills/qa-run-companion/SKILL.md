---
name: qa-run-companion
description: Companion to a live SafeInsights suite RUN. Read the run's state to answer questions; when the run is paused or errored, drive the frozen browser to diagnose; edit the suite to fix/add steps. Use inside the QA Runner's run screen (NOT for authoring a suite from scratch — that's qa-explore).
---

# qa-run-companion

You are attached to a **live or just-finished run** of an existing SafeInsights
Playwright suite in the QA Runner. You help a QA staffer understand and fix that
run. This is DIFFERENT from qa-explore (which authors a suite from scratch): here a
suite already exists and the engine is driving the run.

## The environment you're in
- The repo is at **`$QAR_REPO_DIR`** and is your working directory. The CLI is
  **`${QAR_BIN:-pnpm qar}`**.
- The run engine owns the browser. A CDP-attached **`chrome-devtools` MCP** is
  available, pointed at the SAME browser the run uses.
- The run writes **`<bundleDir>/run-state.json`** — the ordered steps (name,
  status, error, screenshot path, url, console) and the final result once done.
  Per-step screenshots live under `<bundleDir>/screenshots/`. Find the newest
  bundle under the results root (the engine prints `report: <bundleDir>/report.html`
  in CLI runs; in the GUI, read the most recent run-state.json).
- The engine rewrites `run-state.json` as the run progresses. It writes atomically,
  but if a read ever fails to parse (you caught it mid-write), just read it again.

## The ONE rule about the browser: idle = drivable
- **While a step is running, the engine is driving the browser — DO NOT touch it.**
  Answer from `run-state.json` and screenshots only.
- **Only when the run is PAUSED or ERRORED** (the engine is idle, the browser is
  frozen at that point) may you drive the browser with the chrome-devtools MCP
  (snapshot, click, read the page) to diagnose.
- If unsure whether the run is idle, ask the user, or check run-state.json
  (`running: false` or a failed final step = idle).

## What you do
1. **Answer questions about the run** — read `run-state.json` + the relevant
   screenshot(s), explain what happened at a step, why it failed, what the page
   showed. Be concise and plain-language.
2. **Diagnose interactively (idle only)** — snapshot/read the frozen browser to see
   the real DOM at the failure, compare to what the step expected.
3. **Fix or extend the suite** — edit `src/suites/<name>.ts` following its existing
   conventions: steps are `{ name, run: async (ctx) => { await ctx.step('<name>',
   async () => { … }) } }`; thread values via `ctx.state`; use `ctx.page`,
   `ctx.baseURL`, `ctx.tag`, `ctx.trackStudy`/`ctx.trackUser`. Prefer stable
   selectors: `getByRole`, `getByLabel`, `getByTestId`, `text=`. See
   `src/suites/create-study.ts` as the template and `src/suites/types.ts` for shapes.
4. **Hand back to Run — do NOT run the suite yourself.** After editing, tell the
   user: *"Fixed <what> — press Run to re-run and verify."* The QA Runner recompiles
   (`build-suites`) and re-runs through its run screen. You never call `qar run`;
   the GUI owns the authoritative run and its live browser.

## Keeping the session smooth
- Never prefix commands with `cd` — you're already in `$QAR_REPO_DIR`. One command
  per Bash call (chained/piped commands fall outside the allowlist and prompt).
  Pre-approved: `pnpm qar …`, `qar …`, `pnpm typecheck`, `pnpm test`, and read-only
  `mkdir`/`ls`/`cat`/`date`/`echo`, plus Read/Write/Edit and the chrome-devtools MCP.
- Be quiet: do the work, then give a short plain-language result. Don't paste raw
  JSON step lines or long logs.

## Rules
- Drive the EXISTING run browser via chrome-devtools MCP; never open your own, and
  only when the run is idle (paused/errored).
- The suite file is the deliverable when fixing — leave it self-contained and
  re-runnable with selectors a reviewer can trust.
- Editing ends with "press Run to verify", not a self-run.

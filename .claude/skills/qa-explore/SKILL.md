---
name: qa-explore
description: Interactively author a SafeInsights Playwright test suite by driving a live, already-logged-in browser, then writing and verifying the suite file. Use when given a QA instruction + env + role inside the QA Runner's authoring session.
---

# qa-explore

You help a QA staff member author a reusable Playwright **test suite** by driving a
real, already-open browser to carry out a plain-English instruction, then writing
the suite to a file and verifying it passes. You run **interactively in a terminal**
— talk to the user in plain language, ask when unsure, and let them approve actions.

## The environment you're in
- The browser is **already launched and logged in** (the QA Runner ran `qar session`
  before you started). Drive it with the **`chrome-devtools` MCP tools** — do NOT
  launch your own browser, and do NOT log in again for the primary role. In
  particular do NOT run `qar login` — the session is already authenticated.
- The repo is at **`$QAR_REPO_DIR`** and **is already your working directory.**
  The engine CLI is **`${QAR_BIN:-pnpm qar}`** (`$QAR_BIN` in the packaged app,
  else `pnpm qar`).
- The prompt names the **role**, **target** (`--env <name>` or `--pr <n>`), and the
  **instruction**. The browser is already on that environment as that role.

## Keeping the session smooth (IMPORTANT — read before running anything)
This runs in a permission-scoped terminal the QA staffer watches. To avoid
needless permission prompts and noise:
- **Never prefix a command with `cd`** — you are already in `$QAR_REPO_DIR`.
  A compound like `cd … && pnpm qar …` does NOT match the pre-approved allowlist,
  so it forces a permission prompt. Run `pnpm qar …` directly.
- **One command per Bash call.** Don't chain with `&&`, `;`, or pipes when you can
  avoid it — chained/piped commands fall outside the allowlist and prompt. The
  pre-approved commands are: `pnpm qar …` (and `qar …`), `pnpm typecheck`,
  `pnpm test`, and the read-only helpers `mkdir`, `ls`, `cat`, `date`, `echo`.
- **Be quiet.** Don't narrate every tool call. Do the work, then give the user a
  short, plain-language result. Skip pasting raw JSON step lines and long logs.

## What to do
1. **Carry out the instruction in the browser** using the chrome-devtools MCP tools
   (navigate, click, fill, snapshot to read the page). Confirm each meaningful step
   actually worked by reading the resulting page. Keep the user informed.
2. **Track anything you create** (study/user ids from the URL, e.g.
   `/.../study/<id>/...`) so it can be cleaned up.
3. **When the user asks to save it as a suite** (they'll give it a short name),
   **write `src/suites/<name>.ts`** following `src/suites/types.ts`
   (`Suite` + `Step` + `RunContext`). Use an existing suite (`src/suites/create-study.ts`) as
   the template:
   - export a `const <name>Suite: Suite` with `name`, `description`, `roles`, and a
     **`steps: Step[]` array** (ordered). Each entry is `{ name: '<human name>',
     run: async (ctx) => { … } }`. There is NO `run(ctx)` on the suite anymore — the
     engine loops over `steps` and shows their names in the GUI before the run.
   - inside each step's `run`, wrap the action in
     `await ctx.step('<human name>', async () => { … })` (same human name as the
     step). This keeps the per-step screenshot/status/error machinery working.
   - **thread shared values between steps via `ctx.state`** — e.g. a step that
     captures a created study's id does `ctx.state.studyId = id`, and later steps
     read `ctx.state.studyId as string`. Don't rely on closures across steps.
   - use `ctx.page` (Playwright Page), `ctx.baseURL`, `ctx.tag` for unique titles, and
     `ctx.trackStudy(id)` / `ctx.trackUser(id)` for anything you create (cleanup).
   - prefer **stable selectors**: `getByRole`, `getByLabel`, `getByTestId`, `text=`.
4. **Run and debug the suite until it passes:**
   `${QAR_BIN:-pnpm qar} run --suite <name> --role <role> (--env <name> | --pr <n>)`
   Read failures, fix the selectors/steps in the `.ts`, and re-run until green. Tell
   the user when it passes.
5. **Clean up** anything you created while exploring:
   `${QAR_BIN:-pnpm qar} cleanup (--env <name> | --pr <n>) --studies <ids> --users <ids>`

## Rules
- Drive the EXISTING browser via chrome-devtools MCP; never open your own.
- The suite file is the deliverable — make it self-contained and re-runnable, with
  stable selectors a reviewer can trust.
- Always clean up created entities.
- There is **no machine-readable output contract** — this is an interactive terminal
  session. Communicate with the user in plain language.
- The QA Runner's "Save as suite → Open PR" button compiles your `src/suites/<name>.ts`
  (`qar build-suites`) and opens the PR; you just need to leave a passing suite file.

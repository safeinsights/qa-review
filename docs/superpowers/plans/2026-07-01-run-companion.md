# Run Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude "run companion" to the Suites run screen that can read the run's state, drive the frozen browser when the run is paused/errored, and edit the suite — while the engine owns the browser during active steps.

**Architecture:** The run engine launches Chrome with a CDP remote-debugging port (as `qar session` already does) and emits it on the screencast envelope; it also persists a live `run-state.json` into the run bundle. The React run screen surfaces an "Ask Claude" drawer that lazily spawns a `claude` PTY (via a new Go method) attached to the run's CDP port and a new `qa-run-companion` skill. Claude drives the browser only when the engine is idle (paused/errored); after editing the suite the user re-runs via the normal Run button.

**Tech Stack:** TypeScript (Node engine, vitest), Playwright, Go (Wails GUI, `go test`), React + Mantine + xterm, `chrome-devtools-mcp`, `filippo.io/age` (unaffected).

---

## Spec reference

`docs/superpowers/specs/2026-07-01-run-companion-design.md`

## File Structure

**Engine (TypeScript):**
- `src/engine/run.ts` — `BrowserHandle` gains `cdpPort?`; `defaultDeps().openBrowser` launches with `--remote-debugging-port`; new optional `deps.onRunState` sink called with the accumulated run snapshot.
- `src/engine/run-state.ts` *(new)* — pure builder `buildRunState(steps, result?)` → the JSON-serializable snapshot; keeps run.ts/run command thin and unit-testable.
- `src/engine/types.ts` — `ScreencastInfo` gains `cdpPort: number`; new `RunState` type.
- `src/cli/step-stream.ts` — no shape change needed (screencast line spreads `ScreencastInfo`), but `parseLine` already tolerant. (Verified: `screencastLine` spreads the info object.)
- `src/cli/commands/run.ts` — pass `cdpPort` from the handle into the screencast line; wire `onRunState` to write `<bundleDir>/run-state.json`.
- `src/engine/paths.ts` — add `runStatePath(bundleDir)` helper (single source of truth for the filename).

**Shared launch helper:**
- `src/engine/cdp-launch.ts` *(new)* — extract `freePort()` + `launchChromeWithCdp(baseURL, opts)` so both `session.ts` and `run.ts` share one CDP-launch implementation (DRY).

**GUI (Go):**
- `gui/app.go` — new bound method `StartRunCompanion(cdpPort int, suite string)` that spawns the companion `claude` PTY (reuses `authoringAllowedTools`, `writeSessionMcpConfig`, `submitToPty`, `pty`); companion torn down in `teardownSession`/on new run.
- `gui/paths.go` — `writeSessionMcpConfig` reused as-is.

**GUI (React):**
- `gui/frontend/src/lib/stepStream.ts` — `ScreencastEnvelope` gains `cdpPort`.
- `gui/frontend/src/lib/ipc.ts` — bind `StartRunCompanion` + `StopSession` (existing).
- `gui/frontend/src/components/RunScreen.tsx` — capture `cdpPort`; render `CompanionDrawer`; emphasize toggle on pause/error.
- `gui/frontend/src/components/CompanionDrawer.tsx` *(new)* — the "Ask Claude" toggle + drawer hosting `Terminal`; lazy-spawns on first open; shows read-only hint while engine is mid-step.

**Skill:**
- `.claude/skills/qa-run-companion/SKILL.md` *(new)* — companion-mode skill.

---

## Task 1: Extract shared CDP-launch helper

**Files:**
- Create: `src/engine/cdp-launch.ts`
- Test: `tests/engine/cdp-launch.test.ts`
- Modify: `src/cli/commands/session.ts` (replace local `freePort`/`launchWithCdp`)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/engine/cdp-launch.test.ts
import { describe, it, expect } from 'vitest'
import { freePort } from '@/engine/cdp-launch'

describe('freePort', () => {
    it('returns a usable TCP port number', async () => {
        const p = await freePort()
        expect(typeof p).toBe('number')
        expect(p).toBeGreaterThan(0)
        expect(p).toBeLessThan(65536)
    })

    it('returns different ports across calls (not a fixed constant)', async () => {
        const a = await freePort()
        const b = await freePort()
        // Not guaranteed distinct, but both must be valid ports.
        expect(a).toBeGreaterThan(0)
        expect(b).toBeGreaterThan(0)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/engine/cdp-launch.test.ts`
Expected: FAIL — `Cannot find module '@/engine/cdp-launch'`.

- [ ] **Step 3: Write the helper**

```typescript
// src/engine/cdp-launch.ts
import net from 'node:net'
import type { Browser, BrowserContext, Page } from '@playwright/test'

// Pick a currently-free TCP port by binding to 0 and reading the assignment.
// There's a small TOCTOU window before chromium grabs it; callers retry once.
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address()
            const port = typeof addr === 'object' && addr ? addr.port : 0
            srv.close(() => resolve(port))
        })
    })
}

export interface CdpLaunch {
    browser: Browser
    context: BrowserContext
    page: Page
    cdpPort: number
}

// Launch the user's Chrome with a fixed remote-debugging port so chrome-devtools-mcp
// can attach over CDP (--browserUrl). Playwright's isolated temp user-data-dir
// satisfies Chrome 136+'s "no remote debugging on the default profile" rule.
// `contextOptions` lets callers add e.g. recordVideo without duplicating launch code.
// Retries once if the picked port is taken in the TOCTOU window.
export async function launchChromeWithCdp(
    contextOptions: Parameters<Browser['newContext']>[0],
): Promise<CdpLaunch> {
    const { chromium } = await import('@playwright/test')
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
        const cdpPort = await freePort()
        try {
            const browser = await chromium.launch({
                channel: 'chrome',
                args: [`--remote-debugging-port=${cdpPort}`],
            })
            const context = await browser.newContext(contextOptions)
            const page = await context.newPage()
            return { browser, context, page, cdpPort }
        } catch (e) {
            lastErr = e
        }
    }
    throw lastErr
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/engine/cdp-launch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `session.ts` to use the helper**

Replace the local `freePort` and `launchWithCdp` in `src/cli/commands/session.ts` with the shared helper. The session's launch used `{ baseURL }` as context options and its own retry loop:

```typescript
// src/cli/commands/session.ts — replace the file's `freePort`, `launchWithCdp`,
// and the attempt loop with:
import net from 'node:net' // <- REMOVE this import (now unused)
import { launchChromeWithCdp } from '@/engine/cdp-launch'
// ...
// Inside sessionCommand, replace the freePort/launchWithCdp block with:
    const { browser, context, page, cdpPort } = await launchChromeWithCdp({ baseURL: env.baseURL })
```

Delete the now-unused local `freePort()` and `launchWithCdp()` functions and the `net` import from `session.ts`.

- [ ] **Step 6: Run typecheck + session-adjacent tests**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/engine/cdp-launch.ts tests/engine/cdp-launch.test.ts src/cli/commands/session.ts
git commit -m "refactor: extract shared CDP Chrome-launch helper"
```

---

## Task 2: Run engine launches Chrome with a CDP port and exposes it

**Files:**
- Modify: `src/engine/run.ts` (`BrowserHandle`, `defaultDeps().openBrowser`)
- Modify: `src/engine/run-headed.ts` (keep `BrowserHandle` shape compiling — `cdpPort` optional)
- Test: `tests/engine/run.test.ts` (add a case that a handle's `cdpPort` flows through)

- [ ] **Step 1: Write the failing test**

Add to `tests/engine/run.test.ts`. First inspect the file's existing fake-deps pattern; it injects `openBrowser` returning a `BrowserHandle`. Add:

```typescript
// tests/engine/run.test.ts — new test
it('exposes the browser handle cdpPort to an onPage/screencast consumer', async () => {
    // A fake handle that reports a cdpPort, proving the type carries it end-to-end.
    const handle = {
        page: fakePage(),          // reuse this file's existing fake page factory
        cookieHeader: '',
        cdpPort: 54321,
        close: async () => {},
    }
    let seenPort: number | undefined
    const deps = makeFakeDeps({          // reuse this file's existing deps factory
        openBrowser: async () => handle,
        onPage: async () => { seenPort = handle.cdpPort },
    })
    await runEngine({ suite: 'signin', env: 'qa', role: 'admin', envConfig: fakeEnv() }, deps)
    expect(seenPort).toBe(54321)
})
```

> Note: adapt `fakePage()`, `makeFakeDeps()`, `fakeEnv()` to the actual helper names already in `run.test.ts`. If the file builds deps inline, mirror that style. The behavior asserted is: `BrowserHandle.cdpPort` is a valid optional field that a consumer can read.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/engine/run.test.ts`
Expected: FAIL — TS error `cdpPort does not exist on type BrowserHandle` (or the assertion fails).

- [ ] **Step 3: Add `cdpPort` to `BrowserHandle` and launch with CDP**

In `src/engine/run.ts`, add the optional field:

```typescript
export interface BrowserHandle {
    page: import('@playwright/test').Page
    cookieHeader: string
    // The Chrome remote-debugging port this browser exposes, if launched with one
    // (production runs do; test fakes may omit). Lets the run companion attach.
    cdpPort?: number
    close: () => Promise<void>
    saveTraceTo?: (bundleDir: string) => Promise<void>
    saveVideoTo?: (bundleDir: string) => Promise<void>
}
```

Then change `defaultDeps().openBrowser` to launch via the shared helper so it gets a CDP port. Replace the `chromium.launch({ channel: 'chrome' })` + `browser.newContext(...)` lines with:

```typescript
        openBrowser: async (env) => {
            const { launchChromeWithCdp } = await import('@/engine/cdp-launch')
            // channel:'chrome' + a remote-debugging port: the run companion can
            // attach chrome-devtools-mcp to this same browser when the run is idle.
            const { browser, context, page, cdpPort } = await launchChromeWithCdp({
                baseURL: env.baseURL,
                recordVideo: { dir: resultsRoot }, // moved into bundle after finish
            })
            // Capture a Playwright trace (unchanged from before).
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {})
            const video = page.video()
            let browserClosed = false
            const closeBrowser = async () => {
                if (browserClosed) return
                browserClosed = true
                await browser.close().catch(() => {})
            }
            return {
                page,
                cookieHeader: '',
                cdpPort,
                // ...keep the existing returned close/saveTraceTo/saveVideoTo fields
                //    exactly as they were below this point.
```

> Preserve every existing field in the returned handle (close, saveTraceTo, saveVideoTo). Only the launch mechanism and the added `cdpPort` change.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/engine/run.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (`run-headed.ts` still compiles — it returns a handle without `cdpPort`, which is allowed since the field is optional).

- [ ] **Step 6: Commit**

```bash
git add src/engine/run.ts tests/engine/run.test.ts
git commit -m "feat: run engine launches Chrome with a CDP debug port"
```

---

## Task 3: Add `cdpPort` to the screencast envelope

**Files:**
- Modify: `src/engine/types.ts` (`ScreencastInfo`)
- Modify: `src/cli/commands/run.ts` (emit `cdpPort` on the screencast line)
- Test: `tests/engine/screencast.test.ts` OR a small step-stream unit (see below)

- [ ] **Step 1: Write the failing test**

Create a focused unit test for the envelope shape:

```typescript
// tests/engine/step-stream.test.ts (new)
import { describe, it, expect } from 'vitest'
import { screencastLine, parseLine } from '@/cli/step-stream'

describe('screencast envelope carries cdpPort', () => {
    it('round-trips port and cdpPort', () => {
        const line = screencastLine({ port: 9001, cdpPort: 9222 })
        const env = parseLine(line.trim())
        expect(env).toEqual({ type: 'screencast', port: 9001, cdpPort: 9222 })
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/engine/step-stream.test.ts`
Expected: FAIL — TS error: `cdpPort` not assignable to `ScreencastInfo`.

- [ ] **Step 3: Add `cdpPort` to `ScreencastInfo`**

```typescript
// src/engine/types.ts — update ScreencastInfo
export interface ScreencastInfo {
    port: number
    // The run browser's CDP remote-debugging port, so the run companion's
    // chrome-devtools-mcp can attach to the SAME browser (--browserUrl).
    cdpPort: number
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/engine/step-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Emit `cdpPort` from the run command**

In `src/cli/commands/run.ts`, the `onPage` closure creates the screencast server. It needs the handle's `cdpPort`. Because `onPage` receives only the `page`, capture the port from the handle instead: change the screencast emit to read from a variable set in `openBrowser`'s result. Simplest wiring — wrap `deps.openBrowser` to stash the port:

```typescript
// In runCommand, after building `deps` but before runEngine, capture the cdpPort:
let runCdpPort = 0
const baseOpenBrowser = deps.openBrowser
deps.openBrowser = async (env) => {
    const handle = await baseOpenBrowser(env)
    runCdpPort = handle.cdpPort ?? 0
    return handle
}

// And update the onPage screencast emit to include it:
const onPage = screencast
    ? async (page: Page) => {
          server = await ScreencastServer.start(page)
          process.stdout.write(screencastLine({ port: server.port, cdpPort: runCdpPort }))
      }
    : undefined
```

> `onPage` runs AFTER `openBrowser` in `runEngine` (openBrowser → onPage), so `runCdpPort` is set by the time the screencast line is written. Confirm ordering in `run.ts` (`handle = await deps.openBrowser(...)` precedes `await deps.onPage?.(page)`).

Ensure `onPage` and the wrapped `openBrowser` are assembled into the final `deps` object (adjust the existing `const deps = { ...base, onPage, ...controlDeps }` so the wrapper is applied — e.g. wrap after `base` is built and before spreading).

- [ ] **Step 6: Typecheck + run**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/engine/types.ts src/cli/commands/run.ts tests/engine/step-stream.test.ts
git commit -m "feat: emit run browser cdpPort on the screencast envelope"
```

---

## Task 4: Build and persist live run-state to the bundle

**Files:**
- Create: `src/engine/run-state.ts`
- Modify: `src/engine/types.ts` (`RunState` type)
- Modify: `src/engine/paths.ts` (`runStatePath`)
- Modify: `src/engine/run.ts` (`onBundleDir`/`onRunState` sinks in `RunDeps` + emit calls)
- Modify: `src/cli/commands/run.ts` (write run-state on each step + result)
- Test: `tests/engine/run-state.test.ts`, `tests/engine/run.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/engine/run-state.test.ts
import { describe, it, expect } from 'vitest'
import { buildRunState } from '@/engine/run-state'
import type { StepEvent, RunResult } from '@/engine/types'

const step = (over: Partial<StepEvent>): StepEvent =>
    ({ name: 'X', status: 'running', ...over } as StepEvent)

describe('buildRunState', () => {
    it('collapses running→resolved into one entry per position, preserving order', () => {
        const events: StepEvent[] = [
            step({ name: 'A', status: 'running' }),
            step({ name: 'A', status: 'passed', screenshot: 'screenshots/01-a.png' }),
            step({ name: 'B', status: 'running' }),
            step({ name: 'B', status: 'failed', error: 'boom' }),
        ]
        const rs = buildRunState(events)
        expect(rs.steps.map((s) => [s.name, s.status])).toEqual([
            ['A', 'passed'],
            ['B', 'failed'],
        ])
        expect(rs.steps[0].screenshot).toBe('screenshots/01-a.png')
        expect(rs.steps[1].error).toBe('boom')
        expect(rs.result).toBeUndefined()
        expect(rs.running).toBe(true)
    })

    it('includes the final result and marks running=false when given one', () => {
        const result = { ok: false, steps: [], bundleDir: '/tmp/b', failureCategory: 'app-assertion' } as unknown as RunResult
        const rs = buildRunState([], result)
        expect(rs.result?.ok).toBe(false)
        expect(rs.running).toBe(false)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/engine/run-state.test.ts`
Expected: FAIL — `Cannot find module '@/engine/run-state'`.

- [ ] **Step 3: Add the `RunState` type**

```typescript
// src/engine/types.ts — add near RunResult
// A JSON snapshot of a run in progress OR finished, persisted to
// <bundleDir>/run-state.json so the run companion (Claude) can read it.
export interface RunState {
    // One entry per executed position, latest status (running collapsed into passed/failed).
    steps: StepEvent[]
    // Present once the run has finished.
    result?: RunResult
    // True while the run is still going (no result yet).
    running: boolean
}
```

- [ ] **Step 4: Write `buildRunState`**

```typescript
// src/engine/run-state.ts
import type { StepEvent, RunResult, RunState } from '@/engine/types'

// Collapse the append-only step stream into one entry per executed position
// (same rule as the GUI's stepsByIndex): a 'running' opens a position; its
// resolution replaces it in place. Positional so repeated step names don't merge.
export function buildRunState(events: StepEvent[], result?: RunResult): RunState {
    const steps: StepEvent[] = []
    for (const e of events) {
        if (e.status === 'running') steps.push(e)
        else if (steps.length > 0) steps[steps.length - 1] = e
        else steps.push(e)
    }
    return { steps, result, running: result === undefined }
}
```

- [ ] **Step 5: Add `runStatePath` to paths.ts**

```typescript
// src/engine/paths.ts — add
import path from 'node:path' // (if not already imported)

// The live run-state JSON the run companion reads. One filename, one place.
export function runStatePath(bundleDir: string): string {
    return path.join(bundleDir, 'run-state.json')
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run tests/engine/run-state.test.ts`
Expected: PASS.

- [ ] **Step 7: Add two engine sinks — `onBundleDir` (early) and `onRunState` (per step + final)**

The run-state file must be written DURING the run (so the companion can read it at a pause/error), which means the bundle dir must be known before the result. `recorder.bundleDir` is available the moment the recorder is constructed, so expose it via `onBundleDir`, and stream snapshots via `onRunState`.

In `src/engine/run.ts`, add both optional sinks to `RunDeps`:

```typescript
// src/engine/run.ts — in the RunDeps interface, add:
    // Called ONCE with the run's bundle dir, right after the recorder is created
    // (before any step) — so a live consumer knows where to write run-state.json.
    onBundleDir?: (dir: string) => void
    // Called with the accumulated snapshot after each step event AND once with the
    // final result. The CLI persists it to <bundleDir>/run-state.json.
    onRunState?: (state: RunState) => void
```

Add `RunState` to the existing `@/engine/types` import at the top of `run.ts`, and import the builder:

```typescript
// src/engine/run.ts — top of file
import { buildRunState } from '@/engine/run-state'
import type { /* ...existing... */ RunState } from '@/engine/types'
```

Emit the bundle dir right after the recorder is constructed:

```typescript
// src/engine/run.ts — immediately after `const recorder = new Recorder(...)`:
    deps.onBundleDir?.(recorder.bundleDir)
```

Emit a run-state snapshot inside the recorder's event callback (where `events.push(e)` / `deps.onStep?.(e)` already run):

```typescript
// src/engine/run.ts — inside the recorder event callback, after deps.onStep?.(e):
            deps.onRunState?.(buildRunState(events))
```

Emit the final snapshot with the result, just before `runEngine` returns `result`:

```typescript
// src/engine/run.ts — right before `return result`:
    deps.onRunState?.(buildRunState(events, result))
```

- [ ] **Step 7b: Persist run-state to disk from the run command**

In `src/cli/commands/run.ts`, capture the bundle dir and write the file on each snapshot (best-effort):

```typescript
// src/cli/commands/run.ts — imports
import { writeFileSync } from 'node:fs'
import { runStatePath } from '@/engine/paths'
import type { RunState } from '@/engine/types'

// ...near the other deps wiring, before assembling `deps`:
let bundleDirForState: string | undefined
const onBundleDir = (dir: string) => {
    bundleDirForState = dir
}
const onRunState = (state: RunState) => {
    if (!bundleDirForState) return
    try {
        writeFileSync(runStatePath(bundleDirForState), JSON.stringify(state, null, 2))
    } catch {
        /* best-effort: persisting run-state must never fail the run */
    }
}

// include both sinks in the deps object (alongside onPage/controlDeps):
const deps = { ...base, onPage, onBundleDir, onRunState, ...controlDeps }
```

> Note: `onBundleDir` fires before any step (Task 4 test asserts this ordering), so `bundleDirForState` is set by the time the first `onRunState` lands — live per-step writes work, not just the final one.

- [ ] **Step 8: Add a run.ts test for the sink ordering**

```typescript
// tests/engine/run.test.ts — new test
it('emits onBundleDir before steps and onRunState with a final result', async () => {
    const seen: string[] = []
    let finalRunning: boolean | undefined
    const deps = makeFakeDeps({
        onBundleDir: () => seen.push('bundle'),
        onStep: () => seen.push('step'),
        onRunState: (s) => { finalRunning = s.running },
    })
    await runEngine({ suite: 'signin', env: 'qa', role: 'admin', envConfig: fakeEnv() }, deps)
    expect(seen[0]).toBe('bundle')          // bundle dir known before any step
    expect(seen).toContain('step')
    expect(finalRunning).toBe(false)         // last onRunState has the result
})
```

> Adapt `makeFakeDeps`/`fakeEnv` to the file's real helpers.

- [ ] **Step 9: Run tests + typecheck**

Run: `pnpm vitest run tests/engine/run-state.test.ts tests/engine/run.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/engine/run-state.ts src/engine/types.ts src/engine/paths.ts src/engine/run.ts src/cli/commands/run.ts tests/engine/run-state.test.ts tests/engine/run.test.ts
git commit -m "feat: persist live run-state.json to the run bundle"
```

---

## Task 5: Go — spawn the run companion PTY

**Files:**
- Modify: `gui/app.go` (new `StartRunCompanion`; teardown reuse)
- Test: `gui/app_companion_test.go` (new — pure-logic test of the prompt/args builder)

Extract the companion prompt + claude args into pure helpers so they're testable without spawning a real PTY.

- [ ] **Step 1: Write the failing Go test**

```go
// gui/app_companion_test.go
package main

import (
	"strings"
	"testing"
)

func TestComposeCompanionPrompt(t *testing.T) {
	got := composeCompanionPrompt("create-study")
	if !strings.Contains(got, "/qa-run-companion") {
		t.Fatalf("prompt should invoke the companion skill, got: %q", got)
	}
	if !strings.Contains(got, "create-study") {
		t.Fatalf("prompt should name the suite, got: %q", got)
	}
}

func TestCompanionClaudeArgs(t *testing.T) {
	args := companionClaudeArgs("/tmp/mcp.json", "/repo")
	joined := strings.Join(args, " ")
	for _, want := range []string{"--allowedTools", "--mcp-config", "/tmp/mcp.json", "--add-dir", "/repo"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q; got %v", want, args)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && go test ./... -run TestCompanion -run TestComposeCompanion`
Expected: FAIL — undefined `composeCompanionPrompt` / `companionClaudeArgs`.

- [ ] **Step 3: Implement the helpers + `StartRunCompanion`**

```go
// gui/app.go — add near composeAuthoringPrompt

// composeCompanionPrompt is the companion Claude's first message: invoke the
// qa-run-companion skill for the suite whose run is on screen. The browser is the
// live run browser (driven by the engine; Claude drives it only when idle).
func composeCompanionPrompt(suite string) string {
	return fmt.Sprintf(
		"/qa-run-companion You are attached to a live run of the '%s' suite. "+
			"Read <bundleDir>/run-state.json for the run's steps and result. "+
			"Only drive the browser when the run is paused or errored.",
		suite,
	)
}

// companionClaudeArgs builds the claude flags for the run companion. Same scoped
// allowlist as authoring (browser MCP + qar + file edit under the repo); the MCP
// config points chrome-devtools-mcp at the RUN's CDP port.
func companionClaudeArgs(mcpPath, repo string) []string {
	return []string{
		"--permission-mode", "default",
		"--allowedTools", strings.Join(authoringAllowedTools, ","),
		"--add-dir", repo,
		"--mcp-config", mcpPath,
	}
}

// StartRunCompanion (bound) lazily spawns the run companion against an
// already-running run's browser. cdpPort is the run browser's CDP port (from the
// screencast envelope, forwarded by the React run screen). One companion at a time.
func (a *App) StartRunCompanion(cdpPort int, suite string) error {
	// Reuse the session teardown so a prior companion/authoring PTY is cleared.
	a.teardownSession()

	mcpPath, err := writeSessionMcpConfig(cdpPort)
	if err != nil {
		return err
	}
	a.sessionMu.Lock()
	a.sessionMcpPath = mcpPath
	a.sessionMu.Unlock()

	if err := a.pty.start(a, repoDir(), withGuiPath(), companionClaudeArgs(mcpPath, repoDir())); err != nil {
		a.StopSession()
		return err
	}
	go func() {
		time.Sleep(2 * time.Second)
		_ = a.submitToPty(composeCompanionPrompt(suite))
	}()
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && go test ./... -run 'TestCompanion|TestComposeCompanion'`
Expected: PASS.

- [ ] **Step 5: Full Go build + tests**

Run: `cd gui && go vet ./... && go test ./...`
Expected: builds, all tests pass.

- [ ] **Step 6: Regenerate Wails bindings for the new method**

Run: `cd gui && wails generate module` (or the project's binding-gen step; if bindings are generated by `wails dev`/`build`, note it — the JS binding for `StartRunCompanion` must exist in `frontend/src/lib/wailsjs/go/main/App.js`).
Expected: `StartRunCompanion` appears in the generated bindings.

> If `wails generate module` isn't available in this environment, add the binding by hand to `frontend/src/lib/wailsjs/go/main/App.js` and `App.d.ts` mirroring an existing method (e.g. `StopSession`), taking `(arg1: number, arg2: string)`.

- [ ] **Step 7: Commit**

```bash
git add gui/app.go gui/app_companion_test.go gui/frontend/src/lib/wailsjs/go/main/App.js gui/frontend/src/lib/wailsjs/go/main/App.d.ts
git commit -m "feat: Go spawns a run companion PTY against the run's CDP port"
```

---

## Task 6: React — thread `cdpPort` and add the companion drawer

**Files:**
- Modify: `gui/frontend/src/lib/stepStream.ts` (`ScreencastEnvelope.cdpPort`)
- Modify: `gui/frontend/src/lib/ipc.ts` (bind `StartRunCompanion`)
- Create: `gui/frontend/src/components/CompanionDrawer.tsx`
- Modify: `gui/frontend/src/components/RunScreen.tsx` (capture cdpPort, render drawer)

- [ ] **Step 1: Add `cdpPort` to the frontend screencast envelope**

```typescript
// gui/frontend/src/lib/stepStream.ts
export type ScreencastEnvelope = { type: 'screencast'; port: number; cdpPort: number }
```

(The `parse()` allow-list already includes `'screencast'`; no change there.)

- [ ] **Step 2: Bind `StartRunCompanion` in ipc.ts**

Inspect `gui/frontend/src/lib/ipc.ts` for how existing bound methods (e.g. `startAuthoringSession`, `stopSession`) are wrapped, and add:

```typescript
// gui/frontend/src/lib/ipc.ts — mirror the existing wrapper style
import { StartRunCompanion as _StartRunCompanion } from './wailsjs/go/main/App'
export const startRunCompanion = (cdpPort: number, suite: string) => _StartRunCompanion(cdpPort, suite)
```

> Match the file's actual import/export convention (it may re-export directly). `stopSession` already exists and is reused to tear the companion down.

- [ ] **Step 3: Write the CompanionDrawer component (Mantine `<Drawer position="bottom">`)**

Uses Mantine v9's `<Drawer>` with `position="bottom"` — it slides up from the bottom, but with **no overlay and no close-on-click-outside**, so the user can keep interacting with the run screen (click steps, watch/scroll the live browser) while Claude is open. The trigger is the "Ask Claude" toggle button; the drawer body hosts the companion `<Terminal>`.

Non-modal drawer props: `withOverlay={false}` (no dim backdrop), `closeOnClickOutside={false}` (only the toggle / Hide / Esc closes it), plus `trapFocus={false}` and `lockScroll={false}` — without these last two, a Mantine Drawer still traps focus and locks body scroll, which would block interaction with the page behind it even when the overlay is off.

Two details this handles:
- **xterm sizing after the slide-in.** The `<Terminal>` (xterm) measures its container to size the PTY. Mantine's Drawer portals + animates its panel, so on first open the container height isn't settled — xterm would fit to a collapsed box. We mount the `<Terminal>` only once the drawer's open transition has entered (`transitionProps.onEntered`), and give its wrapper a fixed height so `fit()` sees a real size. (The existing `Terminal` already re-fits via `ResizeObserver` + `requestAnimationFrame`, so once mounted at full height it settles correctly.)
- **Lazy spawn + teardown.** The companion PTY spawns on first open only; `stopSession()` tears it down when the drawer component unmounts (run screen gone / new run starts).

```tsx
// gui/frontend/src/components/CompanionDrawer.tsx
import { useEffect, useRef, useState } from 'react'
import { Button, Drawer } from '@mantine/core'
import { Terminal } from './Terminal'
import { startRunCompanion, stopSession } from '../lib/ipc'

// The "Ask Claude" run companion. A bottom Mantine Drawer that slides up over the
// run screen. Lazily spawns the companion PTY on first open (never before),
// attached to the run's CDP port. `idle` = the engine isn't mid-step (run is
// paused, errored, or finished) — only then can Claude drive the browser;
// otherwise it's read-only (answers from run-state.json).
export function CompanionDrawer({
    cdpPort,
    suite,
    idle,
    emphasize,
}: {
    cdpPort: number | null
    suite: string
    idle: boolean
    emphasize: boolean
}) {
    const [open, setOpen] = useState(false)
    // The Terminal mounts only after the slide-in finishes, so xterm fits to the
    // final panel height (not the mid-animation collapsed height).
    const [entered, setEntered] = useState(false)
    const spawned = useRef(false)

    // Spawn once, on first open, when we actually have a CDP port.
    useEffect(() => {
        if (open && !spawned.current && cdpPort) {
            spawned.current = true
            void startRunCompanion(cdpPort, suite)
        }
    }, [open, cdpPort, suite])

    // Tear the companion down when the drawer component unmounts (run screen gone
    // / new run). Closing the drawer keeps the PTY alive so reopening resumes the
    // same conversation.
    useEffect(() => {
        return () => {
            if (spawned.current) void stopSession()
        }
    }, [])

    return (
        <>
            <Button
                variant={emphasize ? 'filled' : 'light'}
                color="teal"
                size="sm"
                disabled={!cdpPort}
                onClick={() => setOpen(true)}
                style={emphasize ? { boxShadow: '0 6px 18px rgba(12,107,94,0.28)' } : undefined}
            >
                {emphasize ? '💬 Ask Claude about this' : 'Ask Claude'}
            </Button>
            <Drawer
                opened={open}
                onClose={() => setOpen(false)}
                position="bottom"
                size="55%"
                // Non-modal: no backdrop, and the user can still click the run
                // screen (steps, live browser) with the drawer open. Only the
                // toggle / Hide / Esc closes it.
                withOverlay={false}
                closeOnClickOutside={false}
                trapFocus={false}
                lockScroll={false}
                title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span className="kicker">Claude — run companion</span>
                        <span className="mono st-dim" style={{ fontSize: 12 }}>
                            {idle
                                ? 'run is idle — Claude can drive the browser'
                                : 'read-only while a step is running — pause or stop to let Claude drive'}
                        </span>
                    </div>
                }
                // Mount Terminal only after the panel finishes sliding in, so xterm
                // fits the final height; unmount-flag reset on full exit.
                transitionProps={{ transition: 'slide-up', duration: 200 }}
                onTransitionEnd={() => setEntered(open)}
                keepMounted={false}
                styles={{ body: { height: 'calc(100% - 60px)', background: '#0f1419', padding: 8 } }}
            >
                {entered ? (
                    <div style={{ width: '100%', height: '100%' }}>
                        <Terminal />
                    </div>
                ) : null}
            </Drawer>
        </>
    )
}
```

> Mantine v9's `Drawer` doesn't expose a direct `onEntered`; `onTransitionEnd` on the Drawer fires when the slide finishes. If in practice the terminal still initializes too small, fall back to gating on a short `setTimeout(() => setEntered(true), 220)` in an effect keyed on `open` (duration slightly longer than the 200ms transition). Either way the goal is: Terminal mounts at full panel height.

- [ ] **Step 4: Capture `cdpPort` in RunScreen and render the drawer**

In `gui/frontend/src/components/RunScreen.tsx`:

1. Add state: `const [cdpPort, setCdpPort] = useState<number | null>(null)`.
2. In the envelope loop, where `env.type === 'screencast'` sets the port, also capture cdpPort:

```tsx
// existing: else if (env.type === 'screencast') setPort(env.port)
else if (env.type === 'screencast') {
    setPort(env.port)
    setCdpPort(env.cdpPort ?? null)
}
```

3. Reset `setCdpPort(null)` everywhere the other per-run fields reset (the two reset blocks that clear `setPort(null)`).

4. Compute idle + emphasize + the current step name, and derive the suite:

```tsx
// Engine is idle (Claude may drive) when paused, errored, or the run finished.
const engineIdle = Boolean(pausedAt) || Boolean(error) || Boolean(result)
// Emphasize the toggle when something needs attention: paused or errored.
const emphasizeClaude = Boolean(pausedAt) || (Boolean(error) && !running)
// The step title shown in the browser bar: the step we're paused before, else the
// most recent streamed step (the one the engine is on), else nothing.
const currentStepName = pausedAt ?? (steps.length > 0 ? steps[steps.length - 1].name : null)
const companionSuite = (result?.suite as string | undefined) ?? deriveSuiteFromSpec(spec)
```

5. Render the toggle **in the live-browser top bar**, to the right of the URL (this is the "gutter" strip with the live-dot + URL). Modify that bar (the flex row containing `<UrlBar>`), adding the current step title and the `CompanionDrawer` after the URL. The URL keeps `flex: 1`; the step title and toggle sit at the far right:

```tsx
// gui/frontend/src/components/RunScreen.tsx — the live-browser top bar
<div
    style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 16px',
        borderBottom: '1px solid var(--line)',
    }}
>
    {/* Pulsing teal status dot — the "live" indicator. */}
    <span className="live-dot" style={{ flex: 'none' }} title="Live browser" />
    {/* Current live URL: selectable + copyable. */}
    <div style={{ flex: 1, minWidth: 0 }}>
        <UrlBar url={url} />
    </div>
    {/* Current step title (paused-before, else the step the engine is on). */}
    {currentStepName ? (
        <span
            className="mono st-dim"
            style={{ flex: 'none', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={currentStepName}
        >
            {pausedAt ? '⏸ ' : ''}
            {currentStepName}
        </span>
    ) : null}
    {/* Ask Claude toggle: the button renders inline here; the Drawer it controls
        portals to the bottom of the screen regardless of this position. */}
    <CompanionDrawer
        cdpPort={cdpPort}
        suite={companionSuite}
        idle={engineIdle}
        emphasize={emphasizeClaude}
    />
</div>
```

> The toggle lives in the top bar, which only renders in the LIVE-browser view (not the snapshot/recording views). That's correct: the companion is about the live/paused/errored run browser. The button stays enabled the whole run (cdpPort arrives at start) and is emphasized when idle. When the run finishes, the right panel flips to the recording view (no top bar) — if you want the toggle available on a *finished* run's recording too, that's a follow-up (see note below).

> **Finished-run note:** on a finished run the right panel shows `RecordingPanel` (no live-browser top bar), so the toggle isn't visible there. Per the design, the companion's browser-driving value is at pause/error (engine idle mid-run); reading run-state on a finished run is still possible but there's no bar to host the toggle. If a finished-run companion is wanted, add the toggle to the RecordingPanel header in a follow-up task — out of scope here.

6. Add a helper to get the suite name from the run spec (the `--suite <name>` arg) for the pre-result case:

```tsx
// top-level in RunScreen.tsx
function deriveSuiteFromSpec(spec: RunSpec | null): string {
    if (!spec || spec.kind !== 'engine') return ''
    const i = spec.args.indexOf('--suite')
    return i >= 0 ? spec.args[i + 1] ?? '' : ''
}
```

7. Import the drawer: `import { CompanionDrawer } from './CompanionDrawer'`.

- [ ] **Step 5: Typecheck the frontend**

Run: `cd gui/frontend && pnpm tsc --noEmit` (or the project's `pnpm typecheck` if it covers the frontend).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add gui/frontend/src/lib/stepStream.ts gui/frontend/src/lib/ipc.ts gui/frontend/src/components/CompanionDrawer.tsx gui/frontend/src/components/RunScreen.tsx
git commit -m "feat: Ask Claude drawer on the run screen (lazy companion spawn)"
```

---

## Task 7: The `qa-run-companion` skill

**Files:**
- Create: `.claude/skills/qa-run-companion/SKILL.md`

- [ ] **Step 1: Write the skill file**

```markdown
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
```

- [ ] **Step 2: Verify the skill is discoverable**

Run: `ls .claude/skills/qa-run-companion/SKILL.md`
Expected: the file exists. (No code test; the skill is prose. Its invocation is exercised manually in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/qa-run-companion/SKILL.md
git commit -m "feat: add qa-run-companion skill"
```

---

## Task 8: End-to-end manual verification

**Files:** none (manual smoke test).

- [ ] **Step 1: Full automated checks**

Run: `pnpm test && pnpm typecheck`
Expected: all vitest tests pass, no type errors.

Run: `cd gui && go test ./...`
Expected: all Go tests pass.

- [ ] **Step 2: CLI smoke — run-state + cdpPort exist**

Run: `pnpm qar run --suite signin --role admin --env qa --json --screencast`
Expected: a `{"type":"screencast","port":<n>,"cdpPort":<m>}` line appears in stdout; after the run, a `run-state.json` exists in the printed `bundleDir`. Inspect it:

Run: `cat <bundleDir>/run-state.json`
Expected: JSON with `steps[]` (names/status) and a `result` with `ok`.

- [ ] **Step 3: GUI smoke — companion attaches to the run browser**

Start the GUI per CLAUDE.md ("Running the GUI app in a browser"):
```
cd gui && nohup wails dev > "$TMPDIR/wails-dev.log" 2>&1 &
```
Wait for `Using DevServer URL: http://localhost:34115`, open it, go to the Suites tab, pick a suite, mark a step "pause before", press Run. When it pauses:
- Click **Ask Claude** → the drawer opens, the companion terminal spawns.
- Ask: *"why are we paused and what's on the page?"* — Claude should read run-state.json and (since idle) snapshot the frozen browser.
- Ask Claude to tweak a selector in the suite; confirm it edits `src/suites/<name>.ts` and tells you to press Run.
- Press Run again → the normal run screen re-runs with the edit.

Expected: no orphaned browser/claude after Stop; the read-only hint shows while a step is actively running.

- [ ] **Step 4: Commit any fixes found during smoke test**

```bash
git add -A && git commit -m "fix: run companion smoke-test adjustments"
```

---

## Self-review notes

- **Spec coverage:** Answer questions (Task 4 run-state + Task 7 skill); debug interactively (Task 2 CDP port + Task 5/6 companion + Task 7 idle rule); fix/edit suite (Task 7); add steps (Task 7); idle=drivable safety model (Task 6 `engineIdle`/read-only hint + Task 7 rule); lazy spawn (Task 6 CompanionDrawer); launch-flag not proxy (Task 1/2); hand-back-to-Run re-run loop (Task 7). All covered.
- **Types:** `cdpPort` optional on `BrowserHandle` (Task 2), required on `ScreencastInfo`/`ScreencastEnvelope` (Task 3/6), `RunState` (Task 4). `StartRunCompanion(cdpPort:number, suite:string)` consistent across Go (Task 5), ipc (Task 6), drawer (Task 6). `buildRunState` used in run.ts + tests. `runStatePath` single source.
- **Out of scope (per spec):** no tab merge, no auto-run-on-save, no persistent cross-run companion, no concurrent driving.
```

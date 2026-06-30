# QA Runner GUI — Wails (Go) Shell Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tauri (Rust) desktop shell with a Wails v2 (Go) shell so the Go team can maintain it, while keeping the existing React frontend, the TypeScript engine/CLI, and the qa-explore skill exactly as they are.

**Architecture:** The shell is thin: it spawns the `qar` CLI / `claude` as child processes, streams their stdout (NDJSON) to the webview as events, and runs a few git/gh commands. Only two things are Tauri-specific — the Go/Rust backend (3 command handlers) and `gui/src/lib/ipc.ts` (the JS bridge). We rewrite the backend in Go (Wails) and reimplement `ipc.ts`'s bodies against the Wails runtime **while keeping its exported function signatures byte-for-byte identical** — so every React component imports the same API and needs zero changes.

**Tech Stack:** Wails v2 (Go backend + OS webview), Go (`os/exec`, `bufio.Scanner`, goroutines), the existing React + TypeScript + Vite frontend, the existing TS/Playwright engine + `qar` CLI (unchanged).

---

## Scope

This plan swaps ONLY the desktop shell. Explicitly unchanged (do not touch): `bin/`, `src/` (engine, cli, codegen, suites), `config/`, `tests/`, `.claude/skills/qa-explore/`, and the React components under `gui/src/components/`. The frontend reuse hinges on keeping `gui/src/lib/ipc.ts`'s exported signatures identical.

Reference: the Tauri implementation in `gui/src-tauri/` (being replaced) and the GUI spec `docs/superpowers/specs/2026-06-29-qa-gui-design.md` (the behavior is unchanged; only the shell tech changes).

**Decision (made):** Wails **v2** (stable), keep the **React** frontend (not Go templates).

### The contract being preserved

`gui/src/lib/ipc.ts` currently exports exactly these (Tauri bodies):
- `runProcess(program: string, args: string[], cwd: string): Promise<void>`
- `onStdoutLine(cb: (line: string) => void): Promise<UnlistenFn>`
- `onExit(cb: (code: number | null) => void): Promise<UnlistenFn>`
- `gitPull(cwd: string): Promise<string>`
- `promoteSuite(cwd: string, name: string, tracePath: string): Promise<string>`

These signatures MUST stay identical. `UnlistenFn` is currently `@tauri-apps/api/event`'s type (`() => void`); after the swap it becomes a locally-defined `type UnlistenFn = () => void`. The components only use these as `() => void`, so that's compatible.

The Go backend must expose methods + emit events that `ipc.ts` maps onto:
- A `RunProcess(program, args, cwd)` method → emits `stdout-line` (string) per line and `proc-exit` (int) on exit.
- A `GitPull(cwd)` method → returns stdout string.
- A `PromoteSuite(cwd, name, tracePath)` method → returns the PR output string.

## File Structure

```
qatest/
  gui/
    # REMOVED:
    src-tauri/                 (entire Tauri/Rust shell — deleted)
    # NEW (Wails Go shell):
    main.go                    Wails app entry: wails.Run with the App struct
    app.go                     App struct + methods: RunProcess, GitPull, PromoteSuite
    app_test.go                Go unit tests for GitPull/PromoteSuite arg-building + RunProcess line splitting
    wails.json                 Wails project config (frontend dir, build commands)
    go.mod / go.sum            Go module
    # CHANGED:
    src/lib/ipc.ts             same exports, Wails runtime bodies
    package.json               drop @tauri-apps/*, keep React/Vite; Wails calls `vite build`
    # UNCHANGED:
    src/components/*.tsx        all 7 components — NO changes
    src/lib/stepStream.ts       unchanged
    src/main.tsx, src/App.tsx   unchanged
    index.html, vite.config.ts, tsconfig.json   unchanged (Wails serves the vite build)
```

Wails v2 convention: Go backend at `gui/` root, frontend under `gui/frontend/` BY DEFAULT — but `wails.json` lets us point `frontend:dir` at the existing layout. To minimize churn we keep the React app where it is (`gui/src`, `gui/index.html`) and configure `wails.json` accordingly.

---

## Task 1: Remove the Tauri shell

**Files:**
- Delete: `gui/src-tauri/` (entire directory)
- Modify: `gui/package.json` (remove Tauri deps + scripts)

**Context:** Clean removal first so the Wails scaffold lands without leftover Rust. The React frontend and its build (`vite`) stay. We keep `gui/.gitignore` but will add Go/Wails artifacts to it later.

- [ ] **Step 1: Delete the Tauri directory**

```bash
cd /Users/nas/code/si/qatest && git rm -r gui/src-tauri
```

- [ ] **Step 2: Edit `gui/package.json`** — remove the `@tauri-apps/*` dependencies and the `tauri` script. The result should be:

```json
{
  "name": "qa-runner-gui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

(Keep whatever exact versions are already pinned; only REMOVE `@tauri-apps/api` and `@tauri-apps/cli` and the `"tauri"` script.)

- [ ] **Step 3: Reinstall to drop the Tauri packages**

Run: `cd /Users/nas/code/si/qatest/gui && pnpm install`
Expected: succeeds; `@tauri-apps/*` gone from the lockfile.

- [ ] **Step 4: Confirm the frontend still builds (it will fail typecheck on ipc.ts — that's expected and fixed in Task 4)**

Run: `cd /Users/nas/code/si/qatest/gui && pnpm build`
Expected: `vite build` itself emits `dist/` (vite doesn't typecheck). If it errors on the `@tauri-apps/api` import in `ipc.ts`, that's expected — Task 4 replaces it. Note the error and proceed; do NOT fix ipc.ts here.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/code/si/qatest && git add gui/ && git commit -m "chore: remove Tauri shell ahead of Wails swap"
```

---

## Task 2: Scaffold the Wails v2 Go module

**Files:**
- Create: `gui/go.mod`
- Create: `gui/wails.json`
- Create: `gui/main.go`
- Create: `gui/app.go` (minimal stub; methods added in Task 3)
- Modify: `gui/.gitignore` (add Go/Wails artifacts)

**Context:** Stand up a minimal Wails v2 app that opens a window loading the existing vite frontend. Wails v2 embeds the built frontend via `embed.FS`. We point `wails.json` at the existing frontend layout. This task's gate: `go build ./...` compiles (the full `wails build` needs the Wails CLI + toolchain, validated in the live task).

- [ ] **Step 1: Create `gui/wails.json`**

```json
{
  "$schema": "https://wails.io/schemas/config.v2.json",
  "name": "qa-runner",
  "outputfilename": "qa-runner",
  "frontend:install": "pnpm install",
  "frontend:build": "pnpm build",
  "frontend:dev:watcher": "pnpm dev",
  "frontend:dev:serverUrl": "http://localhost:1420",
  "wailsjsdir": "./src/lib"
}
```

(`wailsjsdir` is where Wails generates JS bindings; pointing it at `src/lib` keeps them next to `ipc.ts`. `frontend:dev:serverUrl` matches vite's port 1420 from `vite.config.ts`.)

- [ ] **Step 2: Create `gui/go.mod`**

```
module qa-runner

go 1.22

require github.com/wailsapp/wails/v2 v2.9.2
```

(The exact patch version is resolved by `go mod tidy` in Step 6; v2.9.x is current stable.)

- [ ] **Step 3: Create `gui/app.go` (stub — real methods in Task 3)**

```go
package main

import "context"

// App is the Wails backend. Its exported methods are callable from the frontend
// via the generated bindings; it emits events the frontend listens to.
type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

// startup stores the Wails runtime context (needed to emit events).
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}
```

- [ ] **Step 4: Create `gui/main.go`**

```go
package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:  "SafeInsights QA Runner",
		Width:  1100,
		Height: 720,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
```

(`//go:embed all:dist` embeds the vite build output at `gui/dist`. The frontend must be built before `go build`/`wails build`; `wails.json`'s `frontend:build` handles that under `wails build`.)

- [ ] **Step 5: Add Go/Wails artifacts to `gui/.gitignore`**

Append to `gui/.gitignore`:
```
build/bin/
*.exe
# Go build cache artifacts are outside the repo; nothing else to ignore here.
```
(Keep the existing `node_modules/`, `dist/` entries. Note: `dist/` is gitignored AND embedded at build time — that's fine; the build step regenerates it. For `go build` to succeed standalone, `dist/` must exist; Step 6 handles that.)

- [ ] **Step 6: Resolve deps + verify Go compiles**

Run:
```bash
cd /Users/nas/code/si/qatest/gui && pnpm build && go mod tidy && go build ./...
```
Expected: `pnpm build` emits `dist/` (so `//go:embed all:dist` has something to embed); `go mod tidy` writes `go.sum`; `go build ./...` compiles with no errors.

IMPORTANT: If `go` is not installed, report BLOCKED with that fact (the Go team's environment will have it). If the Wails module fails to download (network/sandbox), retry; if still blocked, report DONE_WITH_CONCERNS noting the dep fetch was blocked.

- [ ] **Step 7: Commit**

```bash
cd /Users/nas/code/si/qatest && git add gui/ && git commit -m "feat: scaffold Wails v2 Go shell (window loads the vite frontend)"
```

---

## Task 3: Go backend methods — RunProcess, GitPull, PromoteSuite

**Files:**
- Modify: `gui/app.go`
- Test: `gui/app_test.go`

**Context:** Port the three Tauri command handlers to Go App methods. `RunProcess` spawns a child, scans stdout line-by-line in a goroutine, emits `stdout-line` per line and `proc-exit` on completion (mirrors the Rust). `GitPull` runs `git pull` and returns stdout. `PromoteSuite` runs the branch→codegen→add→commit→push→`gh pr create` sequence, stopping on first failure, returning the PR output. We unit-test the pure helpers (arg building, line handling) without spawning real processes where possible.

- [ ] **Step 1: Write the failing test** — create `gui/app_test.go`:

```go
package main

import (
	"reflect"
	"testing"
)

func TestPromoteArgsSequence(t *testing.T) {
	got := promoteSteps("admin-invites", "/repo/results/x/trace.json")
	want := [][]string{
		{"git", "checkout", "-b", "qa/admin-invites"},
		{"pnpm", "qar", "codegen", "--trace", "/repo/results/x/trace.json"},
		{"git", "add", "src/suites"},
		{"git", "commit", "-m", "test: add admin-invites suite (AI-generated, review selectors)"},
		{"git", "push", "-u", "origin", "qa/admin-invites"},
		{"gh", "pr", "create", "--fill"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("promoteSteps mismatch:\n got=%v\nwant=%v", got, want)
	}
}

func TestSplitLinesHandlesPartialAndComplete(t *testing.T) {
	// scanLines splits a buffer into complete lines + a remainder.
	lines, rest := scanLines("a\nb\npar")
	if !reflect.DeepEqual(lines, []string{"a", "b"}) {
		t.Fatalf("lines=%v", lines)
	}
	if rest != "par" {
		t.Fatalf("rest=%q", rest)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/nas/code/si/qatest/gui && go test ./...`
Expected: FAIL — `promoteSteps`/`scanLines` undefined.

- [ ] **Step 3: Implement `gui/app.go`** — replace the file with:

```go
package main

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// RunProcess spawns `program args...` in cwd, emitting "stdout-line" (string)
// for each stdout line and "proc-exit" (int exit code) when it finishes. Mirrors
// the previous Tauri run_process command. Runs the scan in a goroutine so the
// call returns immediately; the frontend drives the UI off the events.
func (a *App) RunProcess(program string, args []string, cwd string) error {
	cmd := exec.Command(program, args...)
	cmd.Dir = cwd
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout // fold stderr into the same stream (stray lines are ignored by the parser)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // allow long NDJSON lines
		for scanner.Scan() {
			runtime.EventsEmit(a.ctx, "stdout-line", scanner.Text())
		}
		code := 0
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		runtime.EventsEmit(a.ctx, "proc-exit", code)
	}()
	return nil
}

// GitPull runs `git pull` in cwd and returns combined output.
func (a *App) GitPull(cwd string) (string, error) {
	cmd := exec.Command("git", "pull")
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// promoteSteps is the ordered command sequence for promoting a trace to a suite
// PR. Pure (no I/O) so it is unit-testable.
func promoteSteps(name, tracePath string) [][]string {
	branch := "qa/" + name
	return [][]string{
		{"git", "checkout", "-b", branch},
		{"pnpm", "qar", "codegen", "--trace", tracePath},
		{"git", "add", "src/suites"},
		{"git", "commit", "-m", fmt.Sprintf("test: add %s suite (AI-generated, review selectors)", name)},
		{"git", "push", "-u", "origin", branch},
		{"gh", "pr", "create", "--fill"},
	}
}

// PromoteSuite runs the promote sequence in cwd, stopping on the first failure,
// and returns the final step's output (the PR URL from `gh pr create`).
func (a *App) PromoteSuite(cwd, name, tracePath string) (string, error) {
	var last string
	for _, step := range promoteSteps(name, tracePath) {
		cmd := exec.Command(step[0], step[1:]...)
		cmd.Dir = cwd
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("%s failed: %s", strings.Join(step, " "), string(out))
		}
		last = string(out)
	}
	return last, nil
}

// scanLines splits buf into complete lines and a trailing remainder (the partial
// last line). Pure helper kept for unit testing the line-splitting contract.
func scanLines(buf string) ([]string, string) {
	parts := strings.Split(buf, "\n")
	rest := parts[len(parts)-1]
	return parts[:len(parts)-1], rest
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/code/si/qatest/gui && go test ./...`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the whole module still compiles**

Run: `cd /Users/nas/code/si/qatest/gui && pnpm build && go build ./...`
Expected: exit 0 (dist present, Go compiles).

- [ ] **Step 6: Commit**

```bash
cd /Users/nas/code/si/qatest && git add gui/app.go gui/app_test.go && git commit -m "feat: Wails Go backend (RunProcess/GitPull/PromoteSuite)"
```

---

## Task 4: Rewire `ipc.ts` to the Wails runtime (same signatures)

**Files:**
- Modify: `gui/src/lib/ipc.ts`

**Context:** This is the linchpin. Keep the EXACT exported signatures so no component changes. Replace the Tauri `invoke`/`listen` bodies with Wails: generated method bindings (`window.go.main.App.*`) for the methods, and `EventsOn`/`EventsOff` from `@wailsio/runtime`... in Wails v2 the runtime is exposed at `window.runtime` and bindings at `window.go`. To avoid depending on generated-file timing, call these via the global `window` with typed wrappers. Events return an unsubscribe function.

- [ ] **Step 1: Replace `gui/src/lib/ipc.ts` with:**

```typescript
// Bridge to the Wails (Go) backend. Exported signatures are intentionally
// identical to the previous Tauri bridge so the React components need no changes.
// Wails exposes bound Go methods at window.go.main.App.* and the event runtime at
// window.runtime.EventsOn/EventsOff.

export type UnlistenFn = () => void

interface WailsApp {
    RunProcess(program: string, args: string[], cwd: string): Promise<void>
    GitPull(cwd: string): Promise<string>
    PromoteSuite(cwd: string, name: string, tracePath: string): Promise<string>
}

interface WailsRuntime {
    EventsOn(event: string, cb: (...data: unknown[]) => void): () => void
    EventsOff(event: string): void
}

declare global {
    interface Window {
        go?: { main?: { App?: WailsApp } }
        runtime?: WailsRuntime
    }
}

function app(): WailsApp {
    const a = window.go?.main?.App
    if (!a) throw new Error('Wails bindings not ready (window.go.main.App missing)')
    return a
}

function rt(): WailsRuntime {
    const r = window.runtime
    if (!r) throw new Error('Wails runtime not ready (window.runtime missing)')
    return r
}

export async function runProcess(program: string, args: string[], cwd: string): Promise<void> {
    await app().RunProcess(program, args, cwd)
}

export async function onStdoutLine(cb: (line: string) => void): Promise<UnlistenFn> {
    return rt().EventsOn('stdout-line', (...data) => cb(String(data[0])))
}

export async function onExit(cb: (code: number | null) => void): Promise<UnlistenFn> {
    return rt().EventsOn('proc-exit', (...data) => cb(typeof data[0] === 'number' ? data[0] : null))
}

export async function gitPull(cwd: string): Promise<string> {
    return app().GitPull(cwd)
}

export async function promoteSuite(cwd: string, name: string, tracePath: string): Promise<string> {
    return app().PromoteSuite(cwd, name, tracePath)
}
```

Note: `EventsOn` in Wails v2 returns an unsubscribe function — that matches the components' use of the returned `UnlistenFn`. We type it locally; no `@tauri-apps/*` import remains.

- [ ] **Step 2: Verify the frontend typechecks now (the Tauri import is gone)**

Run: `cd /Users/nas/code/si/qatest/gui && pnpm exec tsc --noEmit`
Expected: exit 0. (Previously this failed on the missing `@tauri-apps/api` import; now resolved.)

- [ ] **Step 3: Verify the components are untouched + still typecheck together**

Run: `cd /Users/nas/code/si/qatest/gui && grep -rl '@tauri' src/ || echo "no tauri refs remain"`
Expected: `no tauri refs remain`.

- [ ] **Step 4: Build the frontend**

Run: `cd /Users/nas/code/si/qatest/gui && pnpm build`
Expected: exit 0; `dist/` built.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/code/si/qatest && git add gui/src/lib/ipc.ts && git commit -m "feat: ipc.ts bridges to Wails runtime (signatures unchanged, components untouched)"
```

---

## Task 5: Verify components still pass their unit test + the whole project is green

**Files:** none (verification)

**Context:** The GUI's only frontend unit test is `tests/gui/stepStream.test.ts` (run from the root). The components themselves have no separate unit tests (they're presentational; validated at the live run). Confirm nothing regressed across BOTH the root project and the gui frontend.

- [ ] **Step 1: Root unit suite + typecheck (engine/CLI unaffected, must stay green)**

Run: `cd /Users/nas/code/si/qatest && pnpm test && pnpm typecheck`
Expected: all root tests pass (48); typecheck exit 0. (The shell swap touches nothing under `src/`/`bin/`, so this is a regression guard.)

- [ ] **Step 2: GUI frontend typecheck + build**

Run: `cd /Users/nas/code/si/qatest/gui && pnpm exec tsc --noEmit && pnpm build`
Expected: exit 0.

- [ ] **Step 3: Go module test + build**

Run: `cd /Users/nas/code/si/qatest/gui && go test ./... && go build ./...`
Expected: PASS + compile.

- [ ] **Step 4: Confirm no Tauri remnants anywhere**

Run: `cd /Users/nas/code/si/qatest && grep -rl 'tauri' gui/src gui/*.go gui/package.json 2>/dev/null || echo "clean"`
Expected: `clean` (no Tauri references in the live shell/frontend; the spec/plan docs may still mention it historically — that's fine).

- [ ] **Step 5: Commit (if any incidental fixes were needed)**

```bash
cd /Users/nas/code/si/qatest && git add -A && git commit -m "chore: verify Wails swap — root + gui + go all green" || echo "nothing to commit"
```

---

## Task 6: Live validation (manual — needs the Go/Wails toolchain + display)

**Files:** none (validation)

**Context:** Run the actual Wails app and confirm the three flows work, same as the Tauri live task. Requires: Go, the Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`), a display, `.env`, Chromium, `claude` on PATH, `gh` auth.

- [ ] **Step 1: Install the Wails CLI (one-time, on the Go dev's machine)**

Run: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
Then: `wails doctor`
Expected: `wails doctor` reports the environment is ready (webview2/webkit present). Note any missing system deps it flags.

- [ ] **Step 2: Launch the app in dev mode**

Run: `cd /Users/nas/code/si/qatest/gui && wails dev`
Expected: the desktop window opens showing "SafeInsights QA Runner" with Suites/Exploratory tabs + Pull-latest. (First run compiles Go + builds the frontend.)

- [ ] **Step 3: Run a curated suite**

Suites tab: PR # `839`, Role `admin`, Suite `signin`, Run.
Expected: a visible Chromium window opens and drives login; the checklist ticks ✓ from the NDJSON stream; the result panel shows PASSED and plays the video. (This proves RunProcess streaming → EventsEmit → onStdoutLine → checklist works end-to-end in Go.)

- [ ] **Step 4: Run create-study and observe cleanup status**

Suite `create-study`, Role `researcher`, PR # `839`, Run.
Expected: steps pass; result shows the cleanup status (a warning if the endpoint still 500s) — confirming cleanup status surfaces through the Go shell.

- [ ] **Step 5: Run an exploratory test + promote**

Exploratory tab: PR # `839`, Role `admin`, instruction "log in and confirm the dashboard is visible", Run. Then name it `dashboard-smoke` and Save as suite → PR.
Expected: the skill drives the browser; checklist ticks; result PASSED. Save-as-suite branches, runs codegen, pushes, and shows a PR URL. (Validates `PromoteSuite` Go path + the skill's `bundleDir`/`trace.json` contract.)

- [ ] **Step 6: Commit any fixes**

```bash
cd /Users/nas/code/si/qatest && git add -A && git commit -m "chore: validate Wails QA Runner end-to-end against pr839" || echo "nothing to commit"
```

---

## Self-Review notes (resolved during writing)

- **Contract preserved:** `ipc.ts` keeps all 5 exported signatures identical (`runProcess`/`onStdoutLine`/`onExit`/`gitPull`/`promoteSuite`); only the bodies change (Tauri `invoke`/`listen` → Wails `window.go.main.App.*` + `window.runtime.EventsOn`). The 7 React components import only from `ipc.ts`, so they need zero edits (Task 4 Step 3 asserts no `@tauri` refs remain). `UnlistenFn` becomes a local `type` instead of the Tauri import — both are `() => void`.
- **Event names unchanged:** Go emits `stdout-line`/`proc-exit`, the same names the previous Rust used and the same `ipc.ts` subscribes to — so the streaming contract is identical end to end.
- **Behavior parity for promote:** `promoteSteps` is the exact same git/codegen/gh sequence as the Rust `promote_suite` (branch → codegen → add → commit → push → gh pr create, stop on first failure, return PR output) — unit-tested in `app_test.go` so the sequence can't silently drift.
- **What stays untouched:** the entire `src/` engine+CLI+codegen+suites, `config/`, `tests/` (root), and `.claude/skills/qa-explore/` — the shell swap does not touch them, and Task 5 Step 1 is the regression guard (root 48 tests must stay green).
- **No placeholders:** every Go/TS file is shown in full; the only "manual" task (6) is the live run, explicitly flagged as needing the Go/Wails toolchain + display (same boundary as the Tauri live task).
- **Known carry-overs (not introduced by this swap):** the exploratory-mode `claude -p` flag-forwarding assumption and the live-unverified UI flows remain exactly as in the Tauri version — the swap is shell-only and doesn't change those risks. The skill's `bundleDir`/`trace.json` contract fix already landed and is shell-agnostic.
- **Type consistency:** Go method names (`RunProcess`/`GitPull`/`PromoteSuite`) match the `WailsApp` interface in `ipc.ts`; event names match between `app.go` and `ipc.ts`; `promoteSteps` signature matches its test.
```

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
	cmd.Stderr = cmd.Stdout // fold stderr into the same stream (stray lines ignored by the parser)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // allow long NDJSON lines
		for scanner.Scan() {
			runtime.EventsEmit(a.ctx, "stdout-line", scanner.Text())
		}
		if err := scanner.Err(); err != nil {
			// A scan error (e.g. a line exceeding the buffer) would otherwise be
			// swallowed, leaving the UI thinking output ended cleanly. Surface it.
			runtime.EventsEmit(a.ctx, "stdout-line", fmt.Sprintf("[qa-runner] output read error: %v", err))
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
		{"pnpm", "qatest", "codegen", "--trace", tracePath},
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

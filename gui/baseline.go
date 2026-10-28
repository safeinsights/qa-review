package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The release run's baseline: release-happy-path, run on the run session's streamed
// browser (startSessionBaseline). Go starts it, not Claude: a `qar run` inside the
// Claude session put a long browser run under the sandbox and behind a permission
// prompt. The session only reads the summary file it leaves.

const baselineSuite = "release-happy-path"

// BaselineSummary is .tmp/release/<tag>/baseline-<env>.json, the source of the run
// session's BASELINE line.
type BaselineSummary struct {
	Passed     bool   `json:"passed"`
	Steps      int    `json:"steps"`
	FailedStep string `json:"failedStep"`
	Error      string `json:"error"`
	ReportPath string `json:"reportPath"`
	FinishedAt string `json:"finishedAt"`
}

type baselineStep struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// baselineTracker folds the engine's JSON lines into step progress and a summary.
// Steps are counted by position, not name: study-happy-path repeats its
// account-switch step names.
type baselineTracker struct {
	index      int
	failedStep string
	err        string
	resultSeen bool
	resultOK   bool
	bundleDir  string
	lastStray  string
}

// Control replies for the engine's holds. Nobody is at the Testing tab's Retry
// button during a baseline, so a held browser would wait forever: give up on a
// failed step, and release an error hold, so the run finishes and reports.
const (
	replyGiveUp = `{"type":"give-up"}`
	replyResume = `{"type":"resume"}`
)

// feed reads one output line. It returns the step progress to emit (nil when the
// line is not a step) and the control line to write back to the engine ("" for none).
func (t *baselineTracker) feed(line string) (*baselineStep, string) {
	trimmed := strings.TrimSpace(line)
	var env struct {
		Type      string `json:"type"`
		Name      string `json:"name"`
		Status    string `json:"status"`
		Error     string `json:"error"`
		StepName  string `json:"stepName"`
		OK        bool   `json:"ok"`
		BundleDir string `json:"bundleDir"`
	}
	if !strings.HasPrefix(trimmed, "{") || json.Unmarshal([]byte(trimmed), &env) != nil {
		if trimmed != "" {
			t.lastStray = trimmed
		}
		return nil, ""
	}
	switch env.Type {
	case "step":
		if env.Status == "running" || t.index == 0 {
			t.index++
		}
		if env.Status == "failed" && t.failedStep == "" {
			t.failedStep = env.Name
			t.err = env.Error
		}
		return &baselineStep{Index: t.index, Name: env.Name, Status: env.Status}, ""
	case "step-failed":
		if t.failedStep == "" {
			t.failedStep = env.StepName
			t.err = env.Error
		}
		return nil, replyGiveUp
	case "error-hold":
		if t.err == "" {
			t.err = env.Error
		}
		return nil, replyResume
	case "result":
		t.resultSeen = true
		t.resultOK = env.OK
		t.bundleDir = env.BundleDir
	}
	return nil, ""
}

// summary is the file's content once the engine has exited. Passing needs both a
// zero exit and a result line that says ok: a stopped engine exits 0 with no result.
func (t *baselineTracker) summary(exitCode int, finishedAt time.Time) BaselineSummary {
	s := BaselineSummary{
		Passed:     exitCode == 0 && t.resultSeen && t.resultOK,
		Steps:      t.index,
		FailedStep: t.failedStep,
		Error:      t.err,
		FinishedAt: finishedAt.UTC().Format(time.RFC3339),
	}
	if t.bundleDir != "" {
		s.ReportPath = filepath.Join(t.bundleDir, "report.html")
	}
	if !s.Passed && s.Error == "" {
		switch {
		case !t.resultSeen && t.lastStray != "":
			s.Error = t.lastStray
		case !t.resultSeen:
			s.Error = fmt.Sprintf("the engine exited (code %d) without a result; was it stopped?", exitCode)
		default:
			s.Error = fmt.Sprintf("the engine exited with code %d", exitCode)
		}
	}
	return s
}

func baselineSummaryPath(dir, env string) string {
	return filepath.Join(dir, "baseline-"+env+".json")
}

// writeBaselineSummary is atomic so the session never reads a half-written file.
func writeBaselineSummary(dir, env string, s BaselineSummary) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := baselineSummaryPath(dir, env) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, baselineSummaryPath(dir, env))
}

// baselineStepCount is the suite's step total for "step N/total". 0 when the list
// cannot be read; the UI then shows the step without a total.
func baselineStepCount() int {
	out, err := runToolFull(qarShim(), "list")
	if err != nil {
		return 0
	}
	var v struct {
		Suites []struct {
			Name  string   `json:"name"`
			Steps []string `json:"steps"`
		} `json:"suites"`
	}
	if json.Unmarshal([]byte(lastLine(out)), &v) != nil {
		return 0
	}
	for _, s := range v.Suites {
		if s.Name == baselineSuite {
			return len(s.Steps)
		}
	}
	return 0
}

// startSessionBaseline runs release-happy-path INSIDE the release run session, on
// its streamed browser, so every step shows in the GUI's browser pane. It used to
// run in a browser of its own before the session started: ten or more minutes of a
// blank terminal and no browser, with the testing off screen.
//
// The session prints the suite's step lines on its stdout (sessionLineHook feeds
// them to the tracker); `qar session-run-suite` is the client that asks for the run
// and waits for it. When the client exits, the summary is written for the session's
// Phase 2 and baseline-done is emitted.
func (a *App) startSessionBaseline(tag, env, dir string) error {
	// A summary from an earlier run must not be read as this one's.
	a.sessionMu.Lock()
	live := a.sessionCmd != nil
	a.sessionMu.Unlock()
	if !live {
		return errors.New("the run session is not running")
	}
	_ = os.Remove(baselineSummaryPath(dir, env))
	total := baselineStepCount()
	var mu sync.Mutex
	t := &baselineTracker{}
	hook := func(line string) {
		mu.Lock()
		step, _ := t.feed(line)
		mu.Unlock()
		if step != nil {
			runtime.EventsEmit(a.ctx, "baseline-step", map[string]any{
				"tag": tag, "env": env, "index": step.Index, "name": step.Name,
				"status": step.Status, "total": total,
			})
		}
	}
	cmd := engineCmd("session-run-suite", "--suite", baselineSuite, "--role", "researcher")
	cmd.Env = append(cmd.Env, guiPidEnv())
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var out strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &out

	a.sessionMu.Lock()
	if a.sessionCmd == nil {
		a.sessionMu.Unlock()
		return errors.New("the run session is not running")
	}
	a.sessionLineHook = hook
	a.sessionMu.Unlock()
	if err := cmd.Start(); err != nil {
		a.sessionMu.Lock()
		a.sessionLineHook = nil
		a.sessionMu.Unlock()
		logDiag("engine", "FAIL could not start the baseline: %v", err)
		return err
	}
	a.sessionMu.Lock()
	a.baselineCmd = cmd
	a.sessionMu.Unlock()
	logDiag("engine", "start: baseline %s %s (in the session browser)", tag, env)
	runtime.EventsEmit(a.ctx, "baseline-step", map[string]any{
		"tag": tag, "env": env, "index": 0, "name": "", "status": "starting", "total": total,
	})
	go a.finishSessionBaseline(tag, env, dir, cmd, &out, t, &mu)
	return nil
}

func (a *App) finishSessionBaseline(
	tag, env, dir string, cmd *exec.Cmd, out *strings.Builder, t *baselineTracker, mu *sync.Mutex,
) {
	code := 0
	if err := cmd.Wait(); err != nil {
		code = -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		}
	}
	a.sessionMu.Lock()
	owned := a.baselineCmd == cmd
	if owned {
		a.baselineCmd = nil
		a.sessionLineHook = nil
	}
	a.sessionMu.Unlock()
	// The session tore down (Stop, or a new session): nobody reads this baseline.
	if !owned {
		return
	}
	mu.Lock()
	s := sessionBaselineSummary(t, code, out.String(), time.Now())
	mu.Unlock()
	if err := writeBaselineSummary(dir, env, s); err != nil {
		logDiag("engine", "FAIL could not write the baseline summary: %v", err)
		s.Passed = false
		s.Error = "could not write " + baselineSummaryPath(dir, env) + ": " + err.Error()
	}
	logDiag("engine", "baseline %s %s: passed=%v exit=%d %s", tag, env, s.Passed, code, s.Error)
	runtime.EventsEmit(a.ctx, "baseline-done", map[string]any{
		"tag": tag, "env": env, "passed": s.Passed, "failedStep": s.FailedStep, "error": s.Error,
	})
}

// sessionBaselineSummary folds the client's own answer into the tracker's. The
// client's last line ({"ok","bundleDir"}) is the authority on the outcome: the
// session's result line can still be in flight on the other pipe when the client
// exits. A client that failed (no session, a timeout) has no such line; its output
// is then the error.
func sessionBaselineSummary(t *baselineTracker, exitCode int, clientOut string, finishedAt time.Time) BaselineSummary {
	var answer struct {
		OK        bool   `json:"ok"`
		BundleDir string `json:"bundleDir"`
	}
	last := lastLine(clientOut)
	if exitCode == 0 && json.Unmarshal([]byte(last), &answer) == nil {
		t.resultSeen = true
		t.resultOK = answer.OK
		if answer.BundleDir != "" {
			t.bundleDir = answer.BundleDir
		}
	} else if last != "" {
		t.lastStray = last
	}
	return t.summary(exitCode, finishedAt)
}

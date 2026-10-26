package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The release run's baseline: release-happy-path, run by Go the way the Testing tab
// runs a suite. It used to be a `qar run` inside the Claude session, which put a
// 10-minute browser run under the sandbox and behind a permission prompt; here it
// runs outside both, and the session only reads the summary file it leaves.

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

// RunBaseline starts release-happy-path against env and returns once it is running.
// It emits baseline-step per step and baseline-done at the end, after writing the
// summary file. It takes the one tracked-run slot, so it is refused while a Testing
// tab run is live (and the reverse), and StopRun stops it.
func (a *App) RunBaseline(tag, env string) error {
	dir, err := releaseDir(tag)
	if err != nil {
		return err
	}
	if env != "staging" && env != "production" {
		return errors.New("a release runs against staging or production")
	}
	cmd := engineCmd("run", "--suite", baselineSuite, "--role", "researcher", "--env", env, "--json")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	// Own process group, as streamCmd does, so StopRun reaches the engine's helpers.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	a.runMu.Lock()
	if a.runCmd != nil {
		a.runMu.Unlock()
		return ErrRunInProgress
	}
	a.runCmd = &exec.Cmd{}
	a.runMu.Unlock()
	// A summary from an earlier run must not be read as this one's.
	_ = os.Remove(baselineSummaryPath(dir, env))
	if err := cmd.Start(); err != nil {
		a.runMu.Lock()
		a.runCmd = nil
		a.runMu.Unlock()
		_ = stdin.Close()
		logDiag("engine", "FAIL could not start the baseline: %v", err)
		return err
	}
	a.runMu.Lock()
	a.runCmd = cmd
	a.runStdin = stdin
	a.runMu.Unlock()
	logDiag("engine", "start: baseline %s %s", tag, env)
	go a.followBaseline(tag, env, dir, cmd, stdout, stdin)
	return nil
}

func (a *App) followBaseline(tag, env, dir string, cmd *exec.Cmd, stdout io.Reader, stdin io.Writer) {
	total := baselineStepCount()
	t := &baselineTracker{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		step, reply := t.feed(scanner.Text())
		if reply != "" {
			_, _ = io.WriteString(stdin, reply+"\n")
		}
		if step != nil {
			runtime.EventsEmit(a.ctx, "baseline-step", map[string]any{
				"tag": tag, "env": env, "index": step.Index, "name": step.Name,
				"status": step.Status, "total": total,
			})
		}
	}
	code := 0
	if err := cmd.Wait(); err != nil {
		code = -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		}
	}
	a.runMu.Lock()
	if a.runCmd == cmd {
		a.runCmd = nil
		if a.runStdin != nil {
			_ = a.runStdin.Close()
			a.runStdin = nil
		}
	}
	a.runMu.Unlock()
	s := t.summary(code, time.Now())
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

package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func feedAll(t *testing.T, lines []string) (*baselineTracker, []baselineStep, []string) {
	t.Helper()
	tr := &baselineTracker{}
	var steps []baselineStep
	var replies []string
	for _, l := range lines {
		step, reply := tr.feed(l)
		if step != nil {
			steps = append(steps, *step)
		}
		if reply != "" {
			replies = append(replies, reply)
		}
	}
	return tr, steps, replies
}

func TestBaselineSummaryFromAFailingStream(t *testing.T) {
	lines := []string{
		"> qa-review qar run",
		`{"type":"step","name":"Switch to the reviewer account","status":"running","at":1}`,
		`{"type":"step","name":"Switch to the reviewer account","status":"passed","at":2}`,
		`{"type":"step","name":"Switch to the reviewer account","status":"running","at":3}`,
		`{"type":"step","name":"Switch to the reviewer account","status":"failed","at":4,"error":"timeout 30000ms"}`,
		`{"type":"step-failed","index":1,"stepName":"Switch to the reviewer account","error":"timeout 30000ms"}`,
		`{"type":"result","ok":false,"bundleDir":"/r/b1","steps":[]}`,
	}
	tr, steps, replies := feedAll(t, lines)
	// Repeated names are distinct steps: the index is positional.
	if len(steps) != 4 || steps[2].Index != 2 || steps[3].Status != "failed" {
		t.Fatalf("steps = %+v", steps)
	}
	if len(replies) != 1 || replies[0] != replyGiveUp {
		t.Fatalf("a failed step must be given up, got %v", replies)
	}

	dir := t.TempDir()
	when := time.Date(2026, 10, 26, 14, 5, 0, 0, time.UTC)
	if err := writeBaselineSummary(dir, "staging", tr.summary(1, when)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "baseline-staging.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got BaselineSummary
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	want := BaselineSummary{
		Passed:     false,
		Steps:      2,
		FailedStep: "Switch to the reviewer account",
		Error:      "timeout 30000ms",
		ReportPath: filepath.Join("/r/b1", "report.html"),
		FinishedAt: "2026-10-26T14:05:00Z",
	}
	if got != want {
		t.Fatalf("summary = %+v, want %+v", got, want)
	}
}

func TestBaselineSummaryPassesOnlyWithAnOkResult(t *testing.T) {
	ok, _, _ := feedAll(t, []string{
		`{"type":"step","name":"a","status":"running"}`,
		`{"type":"step","name":"a","status":"passed"}`,
		`{"type":"result","ok":true,"bundleDir":"/r/b2"}`,
	})
	if s := ok.summary(0, time.Now()); !s.Passed || s.Steps != 1 || s.Error != "" {
		t.Fatalf("summary = %+v", s)
	}
	// A stopped engine exits 0 with no result line.
	stopped, _, _ := feedAll(t, []string{`{"type":"step","name":"a","status":"running"}`})
	if s := stopped.summary(0, time.Now()); s.Passed || s.Error == "" {
		t.Fatalf("a run with no result must not pass: %+v", s)
	}
}

func TestBaselineSummaryNamesACrashBeforeTheFirstStep(t *testing.T) {
	tr, _, replies := feedAll(t, []string{
		"Error: Missing required secret: RESEARCHER_PASSWORD_PRODUCTION",
	})
	if s := tr.summary(1, time.Now()); s.Error != "Error: Missing required secret: RESEARCHER_PASSWORD_PRODUCTION" {
		t.Fatalf("error = %q", s.Error)
	}
	if len(replies) != 0 {
		t.Fatalf("no reply expected, got %v", replies)
	}
	held, _, replies := feedAll(t, []string{`{"type":"error-hold","error":"sign-in failed"}`})
	if len(replies) != 1 || replies[0] != replyResume || held.summary(1, time.Now()).Error != "sign-in failed" {
		t.Fatalf("an error hold must be released and its error kept: %v", replies)
	}
}

func TestRunBaselineRefusesWhileARunIsLive(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", t.TempDir())
	a := &App{}
	a.runCmd = &exec.Cmd{}
	if err := a.RunBaseline("v1", "staging"); err != ErrRunInProgress {
		t.Fatalf("err = %v, want ErrRunInProgress", err)
	}
	if err := a.RunBaseline("v1", "qa"); err == nil {
		t.Fatal("qa is not a release env")
	}
}

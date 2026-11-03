package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func feedAll(t *testing.T, lines []string) (*baselineTracker, []baselineStep) {
	t.Helper()
	tr := &baselineTracker{}
	var steps []baselineStep
	for _, l := range lines {
		if step := tr.feed(l); step != nil {
			steps = append(steps, *step)
		}
	}
	return tr, steps
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
	tr, steps := feedAll(t, lines)
	// Repeated names are distinct steps: the index is positional.
	if len(steps) != 4 || steps[2].Index != 2 || steps[3].Status != "failed" {
		t.Fatalf("steps = %+v", steps)
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
	ok, _ := feedAll(t, []string{
		`{"type":"step","name":"a","status":"running"}`,
		`{"type":"step","name":"a","status":"passed"}`,
		`{"type":"result","ok":true,"bundleDir":"/r/b2"}`,
	})
	if s := ok.summary(0, time.Now()); !s.Passed || s.Steps != 1 || s.Error != "" {
		t.Fatalf("summary = %+v", s)
	}
	// A stopped engine exits 0 with no result line.
	stopped, _ := feedAll(t, []string{`{"type":"step","name":"a","status":"running"}`})
	if s := stopped.summary(0, time.Now()); s.Passed || s.Error == "" {
		t.Fatalf("a run with no result must not pass: %+v", s)
	}
}

func TestBaselineSummaryNamesACrashBeforeTheFirstStep(t *testing.T) {
	tr, _ := feedAll(t, []string{
		"Error: Missing required secret: RESEARCHER_PASSWORD_PRODUCTION",
	})
	if s := tr.summary(1, time.Now()); s.Error != "Error: Missing required secret: RESEARCHER_PASSWORD_PRODUCTION" {
		t.Fatalf("error = %q", s.Error)
	}
	held, _ := feedAll(t, []string{`{"type":"error-hold","error":"sign-in failed"}`})
	if got := held.summary(1, time.Now()).Error; got != "sign-in failed" {
		t.Fatalf("an error hold's error must be kept, got %q", got)
	}
}

func TestSessionBaselineSummaryTakesTheClientsAnswer(t *testing.T) {
	// The session's step lines, as sessionLineHook feeds them; its result line has
	// not arrived yet when the client exits.
	tr, _ := feedAll(t, []string{
		`{"type":"step","name":"Sign in as admin","status":"running"}`,
		`{"type":"step","name":"Sign in as admin","status":"passed"}`,
	})
	s := sessionBaselineSummary(tr, 0, "$ tsx bin/qar.ts session-run-suite\n{\"ok\":true,\"bundleDir\":\"/r/b\"}\n", time.Now())
	if !s.Passed || s.Steps != 1 || s.ReportPath != "/r/b/report.html" {
		t.Fatalf("summary = %+v", s)
	}

	failed, _ := feedAll(t, []string{
		`{"type":"step","name":"Sign in as researcher","status":"running"}`,
		`{"type":"step","name":"Sign in as researcher","status":"failed","error":"Invalid code"}`,
	})
	s = sessionBaselineSummary(failed, 0, `{"ok":false,"bundleDir":"/r/c"}`, time.Now())
	if s.Passed || s.FailedStep != "Sign in as researcher" || s.Error != "Invalid code" {
		t.Fatalf("a failed suite: %+v", s)
	}
}

func TestSessionBaselineSummaryWhenTheRequestFails(t *testing.T) {
	tr := &baselineTracker{}
	s := sessionBaselineSummary(tr, 1, "Error: timed out waiting for the session to run release-happy-path — is a `qar session` running?", time.Now())
	if s.Passed || !strings.Contains(s.Error, "timed out waiting for the session") {
		t.Fatalf("summary = %+v", s)
	}
}

func TestStartSessionBaselineNeedsASession(t *testing.T) {
	a := &App{}
	if err := a.startSessionBaseline("v1", "staging", t.TempDir()); err == nil {
		t.Fatal("a baseline with no run session must be refused")
	}
}

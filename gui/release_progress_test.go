package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeRunFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const runLines = `{"lines":[
 {"id":"BASELINE","title":"Run release-happy-path","section":"baseline"},
 {"id":"1.1","title":"HSTS header","section":"changes","role":"admin","needs":"none"},
 {"id":"4.2","title":"Own edit","section":"changes","role":"researcher","needs":"proposal-draft"},
 {"id":"S-1","title":"Probe","section":"security"}]}`

func TestRunProgressBeforeTheRunStarts(t *testing.T) {
	dir := t.TempDir()
	p, err := runProgress(dir, "staging", time.Now())
	if err != nil || p.Started || p.Total != 0 {
		t.Fatalf("no plan lines yet: got %+v, %v", p, err)
	}
	writeRunFile(t, dir, "run-plan-lines-staging.json", runLines)
	p, err = runProgress(dir, "staging", time.Now())
	if err != nil || p.Started || p.Total != 4 {
		t.Fatalf("lines but no progress file: got %+v, %v", p, err)
	}
}

func TestRunProgressNamesTheLineAndCountsResults(t *testing.T) {
	dir := t.TempDir()
	writeRunFile(t, dir, "run-plan-lines-staging.json", runLines)
	writeRunFile(t, dir, "progress-staging.json",
		`{"line":"4.2","step":"","note":"Editing the draft","startedAt":"2026-10-27T10:00:00Z","at":"2026-10-27T10:20:00Z"}`)
	writeRunFile(t, dir, "results-staging.jsonl",
		`{"id":"BASELINE","result":"FAIL"}
{"id":"1.1","result":"PASS"}
{"id":"1.1","result":"FAIL"}
{"id":"4.2","resu`)
	p, err := runProgress(dir, "staging", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !p.Started || p.Line == nil || p.Line.ID != "4.2" || p.Position != 3 || p.Note != "Editing the draft" {
		t.Fatalf("current line: %+v", p)
	}
	if p.Line.Group != "4 · Researcher · study: proposal draft" {
		t.Errorf("group = %q", p.Line.Group)
	}
	// The retest of 1.1 replaces its PASS; the half-written 4.2 is not counted yet.
	if p.Done != 2 || p.Counts["FAIL"] != 2 || p.Counts["PASS"] != 0 {
		t.Errorf("done %d counts %v", p.Done, p.Counts)
	}
}

func TestRunGroupLabels(t *testing.T) {
	cases := map[string]RunLine{
		"Baseline":                             RunLine{ID: "BASELINE", Section: "baseline"},
		"Security":                             RunLine{ID: "S-3", Section: "security"},
		"1 · Admin · no study":                 RunLine{ID: "1.4", Section: "changes", Role: "admin", Needs: "none"},
		"9 · Reviewer · study: code submitted": RunLine{ID: "9.1", Section: "changes", Role: "reviewer", Needs: "code-submitted"},
	}
	for want, line := range cases {
		if got := runGroup(line); got != want {
			t.Errorf("runGroup(%s) = %q, want %q", line.ID, got, want)
		}
	}
}

func TestRemainingEstimate(t *testing.T) {
	start := "2026-10-27T10:00:00Z"
	now, _ := time.Parse(time.RFC3339, "2026-10-27T10:10:00Z")
	if got := remainingEstimate(start, 0, 4, 100, now); got != 0 {
		t.Errorf("too few lines for a pace: got %d", got)
	}
	// 10 lines in 600 s is 60 s a line; 90 lines left.
	if got := remainingEstimate(start, 0, 10, 100, now); got != 5400 {
		t.Errorf("got %d, want 5400", got)
	}
	if got := remainingEstimate(start, 0, 100, 100, now); got != 0 {
		t.Errorf("a finished run has nothing left: got %d", got)
	}
	if got := remainingEstimate("not a time", 0, 10, 100, now); got != 0 {
		t.Errorf("a bad start time gives no estimate: got %d", got)
	}
}

func TestRemainingEstimateAfterAResume(t *testing.T) {
	resumed := "2026-10-28T09:00:00Z"
	now, _ := time.Parse(time.RFC3339, "2026-10-28T09:10:00Z")
	// 79 lines came from the earlier session; 4 since the resume is too few for a pace.
	if got := remainingEstimate(resumed, 79, 83, 316, now); got != 0 {
		t.Errorf("too few lines since the resume: got %d", got)
	}
	// 10 lines in 600 s since the resume is 60 s a line; 227 lines left.
	if got := remainingEstimate(resumed, 79, 89, 316, now); got != 227*60 {
		t.Errorf("got %d, want %d", got, 227*60)
	}
}

func TestRunProgressUsesTheResumeForThePace(t *testing.T) {
	dir := t.TempDir()
	writeRunFile(t, dir, "run-plan-lines-staging.json", runLines)
	writeRunFile(t, dir, "progress-staging.json",
		`{"line":"","step":"setup","note":"Run resumed","startedAt":"2026-10-01T10:00:00Z","at":"2026-10-28T09:00:00Z","resumedAt":"2026-10-28T09:00:00Z","doneAtResume":2}`)
	writeRunFile(t, dir, "results-staging.jsonl", `{"id":"BASELINE","result":"PASS"}
{"id":"1.1","result":"PASS"}
`)
	p, err := runProgress(dir, "staging", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// Days since the first start, but no line since the resume: no estimate.
	if p.Done != 2 || p.RemainingSec != 0 {
		t.Errorf("done %d remaining %d", p.Done, p.RemainingSec)
	}
}

func TestRunProgressIgnoresAResultForAnotherTitle(t *testing.T) {
	dir := t.TempDir()
	writeRunFile(t, dir, "run-plan-lines-staging.json", runLines)
	writeRunFile(t, dir, "progress-staging.json", `{"line":"","step":"setup","startedAt":"2026-10-27T10:00:00Z"}`)
	writeRunFile(t, dir, "results-staging.jsonl", `{"id":"1.1","result":"PASS","title":"HSTS header"}
{"id":"4.2","result":"PASS","title":"A check the plan no longer has"}
`)
	p, err := runProgress(dir, "staging", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if p.Done != 1 || p.Counts["PASS"] != 1 {
		t.Errorf("done %d counts %v", p.Done, p.Counts)
	}
}

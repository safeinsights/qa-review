package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestPlanHashIsStable(t *testing.T) {
	if planHash("a") != planHash("a") || planHash("a") == planHash("b") {
		t.Fatal("planHash must be a function of the text")
	}
	if len(planHash("")) != 64 {
		t.Fatalf("expected sha256 hex, got %q", planHash(""))
	}
}

func TestWriteThenReadPlanRoundTrips(t *testing.T) {
	repo := t.TempDir()
	t.Setenv("QAR_REPO_DIR", repo)
	a := &App{}
	hash, err := a.WritePlan("v1", "## Summary\nhi\n")
	if err != nil {
		t.Fatal(err)
	}
	got, err := a.ReadPlan("v1")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Exists || got.Text != "## Summary\nhi\n" || got.Hash != hash {
		t.Fatalf("round trip lost data: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(repo, ".tmp", "release", "v1", "plan.md")); err != nil {
		t.Fatal("plan.md not where the engine expects it")
	}
}

func TestReadPlanMissing(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", t.TempDir())
	got, err := (&App{}).ReadPlan("none")
	if err != nil || got.Exists {
		t.Fatalf("a missing plan is Exists=false, not an error: %+v %v", got, err)
	}
}

func TestWritePlanRejectsBadTag(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", t.TempDir())
	if _, err := (&App{}).WritePlan("../x", "t"); err == nil {
		t.Fatal("a tag with a path separator must be refused")
	}
}

func TestReleasePromptsHaveNoPlaceholders(t *testing.T) {
	for _, p := range []string{
		composeReleasePlanPrompt("v1.6.9"),
		composeReleaseRunPrompt("v1.6.9", "staging"),
	} {
		if strings.Contains(p, "{{") || strings.HasSuffix(p, "\n") {
			t.Fatalf("bad prompt: %q", p)
		}
	}
	if !strings.Contains(composeReleaseRunPrompt("v1", "production"), "--env production") {
		t.Fatal("run prompt must carry the env")
	}
}

func TestWritePlanConcurrentLeavesOneWholeFile(t *testing.T) {
	repo := t.TempDir()
	t.Setenv("QAR_REPO_DIR", repo)
	a := &App{}
	texts := map[string]bool{}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		text := strings.Repeat(string(rune('a'+i)), 5000)
		texts[text] = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := a.WritePlan("v1", text); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	dir := filepath.Join(repo, ".tmp", "release", "v1")
	data, err := os.ReadFile(filepath.Join(dir, "plan.md"))
	if err != nil || !texts[string(data)] {
		t.Fatalf("plan.md is not exactly one written text (err=%v, len=%d)", err, len(data))
	}
	if tmps, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(tmps) != 0 {
		t.Fatalf("temp files left behind: %v", tmps)
	}
}

func TestWatchPlanSecondStartClosesFirst(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", t.TempDir())
	a := &App{ctx: context.Background()}
	if err := a.WatchPlan("v1"); err != nil {
		t.Fatal(err)
	}
	a.sessionMu.Lock()
	first := a.stopPlanWatch
	a.sessionMu.Unlock()
	if err := a.WatchPlan("v1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-first:
	default:
		t.Fatal("the first watcher was orphaned, not stopped")
	}
	a.UnwatchPlan()
}

func TestReleaseSavedWatchSecondStartClosesFirst(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", t.TempDir())
	a := &App{ctx: context.Background()}
	a.startReleaseSavedWatch()
	a.sessionMu.Lock()
	first := a.stopReleaseSavedWatch
	a.sessionMu.Unlock()
	a.startReleaseSavedWatch()
	select {
	case <-first:
	default:
		t.Fatal("the first watcher was orphaned, not stopped")
	}
	a.stopReleaseSavedWatcher()
}

func TestPlanLinesProblems(t *testing.T) {
	want := "plan-lines found 2 problem(s):\nR-1-1: duplicate id\nmissing section \"Security\""
	packaged := "Error: " + want
	dev := "> qa-review@1.0.0 qar /repo\n> tsx bin/qar.ts \"plan-lines\"\n\n" + packaged + "\n\n ELIFECYCLE  Command failed with exit code 1."
	for name, in := range map[string]string{"packaged": packaged, "dev": dev} {
		if got := planLinesProblems(in); got != want {
			t.Fatalf("%s: got %q", name, got)
		}
	}
}

func TestFailureTextFallsBackToError(t *testing.T) {
	if got := failureText("", os.ErrNotExist); got != os.ErrNotExist.Error() {
		t.Fatalf("got %q", got)
	}
	if got := failureText("boom", os.ErrNotExist); got != "boom" {
		t.Fatalf("got %q", got)
	}
}

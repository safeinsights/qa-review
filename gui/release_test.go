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

func TestReleasePlanOpeningRetriesGenerationWithoutAPlan(t *testing.T) {
	generate := composeReleasePlanPrompt("v1")
	edit := composeReleasePlanEditPrompt("v1")
	cases := []struct {
		regenerate, exists bool
		want               string
	}{
		{true, true, generate},
		{true, false, generate},
		// A session that died before writing plan.md: Retry generates again.
		{false, false, generate},
		{false, true, edit},
	}
	for _, c := range cases {
		if got := releasePlanOpening("v1", c.regenerate, c.exists); got != c.want {
			t.Errorf("regenerate=%v exists=%v: got %q", c.regenerate, c.exists, got)
		}
	}
}

// The release sessions must not inherit the Validation set's broad entries: every
// Jira tool (comments, transitions), every gh command, and every qar command.
func TestReleaseAllowlistsAreNarrow(t *testing.T) {
	lists := map[string][]string{
		"plan": releasePlanAllowedTools,
		"run":  releaseRunAllowedTools,
	}
	for name, list := range lists {
		joined := "," + strings.Join(list, ",") + ","
		for _, banned := range []string{"mcp__jira-atlassian", "Bash(gh:*)", "Bash(qar:*)", "Bash(pnpm qar:*)"} {
			if strings.Contains(joined, ","+banned+",") {
				t.Errorf("%s list contains %s", name, banned)
			}
		}
		for _, server := range knownJiraServers {
			if !strings.Contains(joined, ","+mcpToolName(server, "jira_get_issue")+",") {
				t.Errorf("%s list lacks jira_get_issue for %q", name, server)
			}
		}
	}
	plan := "," + strings.Join(releasePlanAllowedTools, ",") + ","
	run := "," + strings.Join(releaseRunAllowedTools, ",") + ","
	if !strings.Contains(plan, ",Agent,") || strings.Contains(run, ",Agent,") {
		t.Error("Agent belongs to the plan session only")
	}
	for _, tool := range []string{"mcp__chrome-devtools", "Bash(qar session-login:*)", "Bash(qar jira-create-issue:*)"} {
		if !strings.Contains(run, ","+tool+",") || strings.Contains(plan, ","+tool+",") {
			t.Errorf("%s belongs to the run session only", tool)
		}
	}
}

// Auto mode lets its classifier approve a tool that is off the allowlist, so the
// writes a release session must never make itself are denied by name.
func TestReleaseSessionsDenyDirectWrites(t *testing.T) {
	args := releaseClaudeArgs(releaseRunAllowedTools, "/tmp/mcp.json")
	denied := ""
	for i, a := range args {
		if a == "--disallowedTools" && i+1 < len(args) {
			denied = "," + args[i+1] + ","
		}
	}
	if denied == "" {
		t.Fatal("release session args lack --disallowedTools")
	}
	want := []string{"Bash(gh release:*)", "Bash(gh api:*)", "Bash(gh pr merge:*)", "Bash(gh pr close:*)", "Bash(gh issue:*)"}
	for _, server := range knownJiraServers {
		for _, tool := range []string{"jira_add_comment", "jira_update_issue", "jira_transition_issue", "jira_create_issue"} {
			want = append(want, mcpToolName(server, tool))
		}
	}
	if !strings.Contains(denied, ",mcp__jira-atlassian__jira_add_comment,") {
		t.Error("jira-atlassian's comment tool is not denied")
	}
	for _, tool := range want {
		if !strings.Contains(denied, ","+tool+",") {
			t.Errorf("%s is not denied", tool)
		}
	}
	for name, list := range map[string][]string{"plan": releasePlanAllowedTools, "run": releaseRunAllowedTools} {
		for _, tool := range list {
			if strings.Contains(denied, ","+tool+",") {
				t.Errorf("%s list allows denied tool %s", name, tool)
			}
		}
	}
	if !strings.Contains(","+strings.Join(releaseRunAllowedTools, ",")+",", ",Bash(qar jira-create-issue:*),") {
		t.Error("the run session must keep qar jira-create-issue")
	}
}

package main

import (
	"os"
	"path/filepath"
	"strings"
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

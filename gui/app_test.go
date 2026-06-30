package main

import (
	"reflect"
	"testing"
)

func TestPromoteArgsSequence(t *testing.T) {
	got := promoteSteps("admin-invites", "/repo/results/x/trace.json")
	want := [][]string{
		{"git", "checkout", "-b", "qa/admin-invites"},
		{"pnpm", "qatest", "codegen", "--trace", "/repo/results/x/trace.json"},
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
	lines, rest := scanLines("a\nb\npar")
	if !reflect.DeepEqual(lines, []string{"a", "b"}) {
		t.Fatalf("lines=%v", lines)
	}
	if rest != "par" {
		t.Fatalf("rest=%q", rest)
	}
}

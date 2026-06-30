package main

import (
	"reflect"
	"testing"
)

func TestPromoteArgsSequence(t *testing.T) {
	got := promoteSteps("admin-invites")
	want := [][]string{
		{"qar", "build-suites"},
		{"git", "add", "--", "src/suites/admin-invites.ts", "suites-compiled/admin-invites.mjs"},
		{"git", "commit", "-m", "test: add admin-invites suite (authored interactively, review selectors)", "--", "src/suites/admin-invites.ts", "suites-compiled/admin-invites.mjs"},
		{"git", "push", "-u", "origin", "qa/admin-invites"},
		{"gh", "pr", "create", "--fill"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("promoteSteps mismatch:\n got=%v\nwant=%v", got, want)
	}
}

func TestStripANSI(t *testing.T) {
	cases := map[string]string{
		"\x1b[31mred\x1b[0m":      "red",          // SGR color codes
		"a\x1b[2Kb":               "ab",           // erase-line CSI
		"line1\r\nline2":          "line1\nline2", // CRLF normalized
		"over\rwrite":             "over\nwrite",  // bare CR -> newline
		"\x1b]0;title\x07visible": "visible",      // OSC title sequence
		"plain text":              "plain text",   // untouched
	}
	for in, want := range cases {
		if got := stripANSI(in); got != want {
			t.Errorf("stripANSI(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidSuiteName(t *testing.T) {
	n40 := "abcdefghij_abcdefghij-abcdefghij_abcdefg" // exactly 40 chars
	n41 := n40 + "x"                                  // 41 chars
	ok := []string{"signin", "create-study", "create_study", "Lab1", "a", n40}
	bad := []string{"", "has space", "slash/name", "dot.name", n41, "weird!"}
	for _, n := range ok {
		if !validSuiteName.MatchString(n) {
			t.Errorf("expected %q (len %d) to be a valid suite name", n, len(n))
		}
	}
	for _, n := range bad {
		if validSuiteName.MatchString(n) {
			t.Errorf("expected %q (len %d) to be rejected", n, len(n))
		}
	}
}

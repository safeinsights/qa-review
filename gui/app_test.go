package main

import (
	"reflect"
	"testing"
)

func TestControlLines(t *testing.T) {
	if got := resumeControlLine(); got != `{"type":"resume"}` {
		t.Errorf("resumeControlLine = %q", got)
	}
	if got := pauseSetControlLine([]string{"A", "B"}); got != `{"type":"pause-set","steps":["A","B"]}` {
		t.Errorf("pauseSetControlLine = %q", got)
	}
	if got := pauseSetControlLine(nil); got != `{"type":"pause-set","steps":null}` {
		t.Errorf("pauseSetControlLine(nil) = %q", got)
	}
}

func TestSendToRunNoActiveRun(t *testing.T) {
	a := NewApp()
	// No run in flight → runStdin is nil → SendToRun must be a safe no-op.
	if err := a.SendToRun(resumeControlLine()); err != nil {
		t.Errorf("SendToRun with no active run returned %v, want nil", err)
	}
}

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

func TestPrefixSuite(t *testing.T) {
	cases := []struct{ suite, name, want string }{
		{"signin", "trace.zip", "signin-trace.zip"},
		{"create-study", "01-dashboard.png", "create-study-01-dashboard.png"},
		{"log in as researcher", "trace.zip", "log-in-as-researcher-trace.zip"}, // spaces collapse to dashes
		{"weird!!name", "trace.zip", "weird-name-trace.zip"},                    // unsafe chars collapse
		{"", "trace.zip", "trace.zip"},                                          // blank suite → name as-is
		{"---", "trace.zip", "trace.zip"},                                       // all-unsafe → name as-is
	}
	for _, c := range cases {
		if got := prefixSuite(c.suite, c.name); got != c.want {
			t.Errorf("prefixSuite(%q, %q) = %q, want %q", c.suite, c.name, got, c.want)
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

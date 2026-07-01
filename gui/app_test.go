package main

import (
	"errors"
	"os/exec"
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

func TestTerminateRunNoActiveRun(t *testing.T) {
	a := NewApp()
	// No run in flight → terminateRun (and StopRun) must be safe no-ops that
	// return promptly rather than blocking on a nonexistent process.
	a.terminateRun()
	if err := a.StopRun(); err != nil {
		t.Errorf("StopRun with no active run returned %v, want nil", err)
	}
}

func TestRejectSecondRunWhileActive(t *testing.T) {
	a := NewApp()
	if a.IsRunning() {
		t.Fatal("fresh App reports a run in progress")
	}
	// Simulate an active tracked run by reserving the slot (as streamCmd does).
	a.runMu.Lock()
	a.runCmd = &exec.Cmd{}
	a.runMu.Unlock()

	if !a.IsRunning() {
		t.Error("IsRunning() = false while a run is reserved, want true")
	}
	// A second tracked run must be rejected, not superseded.
	if err := a.streamCmd(&exec.Cmd{}, "qar run", true); !errors.Is(err, ErrRunInProgress) {
		t.Errorf("second tracked streamCmd err = %v, want ErrRunInProgress", err)
	}
	// The active run must be untouched by the rejection.
	if !a.IsRunning() {
		t.Error("active run was cleared by a rejected second run")
	}
}

func TestIsTrackedRun(t *testing.T) {
	// Only `run` is the tracked, one-at-a-time, stoppable run.
	tracked := [][]string{
		{"run", "--json", "--suite", "signin"},
		{"session", "--role", "admin"},
		{}, // no args → treat as tracked (fail safe: don't leave it un-stoppable)
	}
	for _, args := range tracked {
		if !isTrackedRun(args) {
			t.Errorf("isTrackedRun(%v) = false, want true", args)
		}
	}
	// `list` is a throwaway query — must NOT be tracked.
	if isTrackedRun([]string{"list"}) {
		t.Error("isTrackedRun([list]) = true, want false")
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

func TestResolveEditor(t *testing.T) {
	const p = "/repo/src/suites/signin.ts"
	never := func(string) bool { return false }
	always := func(string) bool { return true }

	t.Run("EDITOR wins and keeps flags", func(t *testing.T) {
		t.Setenv("VISUAL", "")
		t.Setenv("EDITOR", "code --wait")
		prog, args := resolveEditor(p, never)
		if prog != "code" || len(args) != 2 || args[0] != "--wait" || args[1] != p {
			t.Fatalf("got prog=%q args=%v", prog, args)
		}
	})

	t.Run("VISUAL takes precedence over EDITOR", func(t *testing.T) {
		t.Setenv("VISUAL", "vim")
		t.Setenv("EDITOR", "code")
		prog, args := resolveEditor(p, always)
		if prog != "vim" || len(args) != 1 || args[0] != p {
			t.Fatalf("got prog=%q args=%v", prog, args)
		}
	})

	t.Run("known GUI editor on PATH when no env set", func(t *testing.T) {
		t.Setenv("VISUAL", "")
		t.Setenv("EDITOR", "")
		prog, args := resolveEditor(p, always) // first candidate (code) resolves
		if prog != "code" || len(args) != 1 || args[0] != p {
			t.Fatalf("got prog=%q args=%v", prog, args)
		}
	})

	t.Run("falls back to open when nothing resolves", func(t *testing.T) {
		t.Setenv("VISUAL", "")
		t.Setenv("EDITOR", "")
		prog, args := resolveEditor(p, never)
		if prog != "open" || len(args) != 1 || args[0] != p {
			t.Fatalf("got prog=%q args=%v", prog, args)
		}
	})
}

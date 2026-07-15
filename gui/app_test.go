package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
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
		{"git", "add", "--", "src/suites/admin-invites.ts"},
		{"git", "commit", "-m", "test: add admin-invites suite (authored interactively, review selectors)", "--", "src/suites/admin-invites.ts"},
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

// TestGuiResolveFinderPath reproduces the Finder-launch bug: a macOS app launched
// from Finder inherits a minimal process PATH (/usr/bin:/bin), so exec.Command with
// a bare name — which resolves via LookPath against the PROCESS PATH, not cmd.Env —
// fails to find Homebrew tools even when withGuiPath() puts them on the child's env.
// guiResolve must return the absolute path so the exec succeeds regardless.
func TestGuiResolveFinderPath(t *testing.T) {
	// A Homebrew-like dir holding a tool, and a fake tool binary inside it.
	brewDir := t.TempDir()
	tool := filepath.Join(brewDir, "faketool")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Point guiPathDirs at our brew-like dir (withGuiPath prepends these).
	orig := guiPathDirs
	guiPathDirs = []string{brewDir, "/usr/bin", "/bin"}
	t.Cleanup(func() { guiPathDirs = orig })

	// Simulate the Finder/launchd process PATH: no brew dir at all.
	t.Setenv("PATH", "/usr/bin:/bin")

	t.Run("bare name resolves to absolute path via augmented PATH", func(t *testing.T) {
		got := guiResolve("faketool")
		if got != tool {
			t.Fatalf("guiResolve(faketool) = %q, want %q", got, tool)
		}
	})

	t.Run("resolved absolute path actually executes", func(t *testing.T) {
		// The whole point: exec.Command(bare) would fail here (not on process PATH),
		// but exec.Command(guiResolve(...)) runs.
		out, err := exec.Command(guiResolve("faketool")).CombinedOutput()
		if err != nil {
			t.Fatalf("exec failed: %v (out=%q)", err, out)
		}
	})

	t.Run("already-absolute name passes through unchanged", func(t *testing.T) {
		if got := guiResolve(tool); got != tool {
			t.Fatalf("guiResolve(abs) = %q, want %q", got, tool)
		}
	})

	t.Run("unresolvable name returned as-is for exec to surface", func(t *testing.T) {
		if got := guiResolve("definitely-not-a-real-tool"); got != "definitely-not-a-real-tool" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestPreflightScopedToClone(t *testing.T) {
	// Setup only clones the repo (gh + git), so preflight must NOT gate on claude
	// or Chrome — those are validated later by the Setup Doctor. A dir with just gh
	// and git present should yield an empty missing-list even with no claude.
	binDir := t.TempDir()
	for _, tool := range []string{"gh", "git"} {
		if err := os.WriteFile(filepath.Join(binDir, tool), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	orig := guiPathDirs
	guiPathDirs = []string{binDir}
	t.Cleanup(func() { guiPathDirs = orig })
	t.Setenv("PATH", binDir)

	if missing := preflightMissing(); len(missing) != 0 {
		t.Fatalf("preflightMissing() = %v, want empty (gh+git present, claude/Chrome not gated)", missing)
	}

	// Removing gh must surface it — proving the gate still works for its real deps.
	if err := os.Remove(filepath.Join(binDir, "gh")); err != nil {
		t.Fatal(err)
	}
	if missing := preflightMissing(); len(missing) != 1 || missing[0] != "gh" {
		t.Fatalf("preflightMissing() = %v, want [gh]", missing)
	}
}

func TestDebugReportProbesTools(t *testing.T) {
	// A brew-like dir with a fake `claude` that prints a version, exactly the
	// Finder-PATH bug shape: present only in an augmented dir, not on process PATH.
	brewDir := t.TempDir()
	claude := filepath.Join(brewDir, "claude")
	if err := os.WriteFile(claude, []byte("#!/bin/sh\necho 'claude 1.2.3'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := guiPathDirs
	guiPathDirs = []string{brewDir, "/usr/bin", "/bin"}
	t.Cleanup(func() { guiPathDirs = orig })
	t.Setenv("PATH", "/usr/bin:/bin")

	report := (&App{}).DebugReport()

	var probe *ToolProbe
	for i := range report.Tools {
		if report.Tools[i].Name == "claude" {
			probe = &report.Tools[i]
		}
	}
	if probe == nil {
		t.Fatal("claude probe missing from report")
	}
	if !probe.Found || probe.ResolvedAt != claude {
		t.Fatalf("claude probe = %+v, want Found + ResolvedAt=%q", *probe, claude)
	}
	if probe.Version != "claude 1.2.3" {
		t.Fatalf("claude version = %q, want %q", probe.Version, "claude 1.2.3")
	}
	// The searched dirs are the diagnostic payload — the brew-like dir must appear.
	if !containsStr(report.SearchDirs, brewDir) {
		t.Fatalf("SearchDirs %v missing %q", report.SearchDirs, brewDir)
	}
	// Markdown mirrors the structured data (used for copy-to-clipboard + issue body).
	if !strings.Contains(report.Markdown, claude) {
		t.Fatalf("markdown missing resolved path:\n%s", report.Markdown)
	}
}

func containsStr(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func TestDebugMarkdownFormatsNotFound(t *testing.T) {
	md := debugMarkdown(DebugReport{
		AppVersion: "dev",
		Tools: []ToolProbe{
			{Name: "gh", Found: true, ResolvedAt: "/opt/homebrew/bin/gh", Version: "gh 2.0"},
			{Name: "claude", Found: false},
		},
	})
	if !strings.Contains(md, "✓ gh — /opt/homebrew/bin/gh (gh 2.0)") {
		t.Fatalf("found-tool line wrong:\n%s", md)
	}
	if !strings.Contains(md, "✗ claude — not found") {
		t.Fatalf("not-found line wrong:\n%s", md)
	}
}

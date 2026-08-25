package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
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
	// Must match jumpToLine() in src/cli/step-stream.ts — the engine's parser
	// requires a non-negative integer `index`.
	if got := jumpToControlLine(0); got != `{"type":"jump-to","index":0}` {
		t.Errorf("jumpToControlLine(0) = %q", got)
	}
	if got := jumpToControlLine(7); got != `{"type":"jump-to","index":7}` {
		t.Errorf("jumpToControlLine(7) = %q", got)
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

func TestParseAccessStatus(t *testing.T) {
	raw := []byte(`{"state":"pr-open","branch":"access/ada","publicKey":"age1x","name":"Ada","pr":{"number":21,"state":"OPEN","url":"https://x/pull/21"},"githubReachable":true,"note":""}`)
	got, err := parseAccessStatus(raw)
	if err != nil {
		t.Fatalf("parseAccessStatus: %v", err)
	}
	if got.State != "pr-open" || got.Branch != "access/ada" {
		t.Fatalf("unexpected status: %+v", got)
	}
	if got.PR == nil || got.PR.Number != 21 {
		t.Fatalf("expected PR 21, got %+v", got.PR)
	}
}

func TestParseAccessStatusRejectsGarbage(t *testing.T) {
	if _, err := parseAccessStatus([]byte("not json")); err == nil {
		t.Fatal("expected an error for malformed engine output")
	}
}

// TestAccessStatusNonFatalFallback pins the task's central safety requirement: a
// user with a pending access request must never be told they have no request just
// because `qar access-status` failed to run or produced garbage. accessStatus must
// swallow both failure modes into a note, never an error, so CheckKeyringAccess can
// still return the local decrypt-based answer.
func TestAccessStatusNonFatalFallback(t *testing.T) {
	origOutput := accessStatusOutput
	t.Cleanup(func() { accessStatusOutput = origOutput })

	t.Run("engine command fails to run", func(t *testing.T) {
		accessStatusOutput = func() ([]byte, error) {
			return nil, errors.New("exec: \"qar\": executable file not found in $PATH")
		}
		a := &App{}
		status, note := a.accessStatus()
		if note == "" {
			t.Fatal("expected a non-empty note when the engine command fails")
		}
		if status != (engineAccessStatus{}) {
			t.Fatalf("expected a zero-value status on failure, got %+v", status)
		}
	})

	t.Run("engine exits non-zero", func(t *testing.T) {
		accessStatusOutput = func() ([]byte, error) {
			return []byte(""), &exec.ExitError{}
		}
		a := &App{}
		status, note := a.accessStatus()
		if note == "" {
			t.Fatal("expected a non-empty note when the engine exits non-zero")
		}
		if status != (engineAccessStatus{}) {
			t.Fatalf("expected a zero-value status on failure, got %+v", status)
		}
	})

	t.Run("engine prints unparsable output", func(t *testing.T) {
		accessStatusOutput = func() ([]byte, error) {
			return []byte("not json"), nil
		}
		a := &App{}
		status, note := a.accessStatus()
		if note == "" {
			t.Fatal("expected a non-empty note when the engine output can't be parsed")
		}
		if status != (engineAccessStatus{}) {
			t.Fatalf("expected a zero-value status on parse failure, got %+v", status)
		}
	})

	t.Run("engine prints valid JSON", func(t *testing.T) {
		accessStatusOutput = func() ([]byte, error) {
			return []byte(`{"state":"pr-open","branch":"access/ada","pr":{"number":21,"state":"OPEN","url":"https://x/pull/21"},"githubReachable":true,"note":""}`), nil
		}
		a := &App{}
		status, note := a.accessStatus()
		if note != "" {
			t.Fatalf("expected no note on success, got %q", note)
		}
		if status.State != "pr-open" || status.Branch != "access/ada" || !status.GithubReachable {
			t.Fatalf("fields not folded through: %+v", status)
		}
		if status.PR == nil || status.PR.Number != 21 {
			t.Fatalf("expected PR 21, got %+v", status.PR)
		}
	})
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

// Inferring the Jira card from a PR is what lets a tester validate by PR number
// alone. The field ORDER matters: title and branch are where the team puts the key,
// while a body often quotes other tickets ("related to OTTER-99").
func TestInferJiraCardFrom(t *testing.T) {
	cases := []struct {
		name                string
		title, branch, body string
		want                string
	}{
		{"from the title", "OTTER-640 add CSV export", "feature/csv", "", "OTTER-640"},
		{"from the branch", "Add CSV export", "nas/OTTER-641-csv", "", "OTTER-641"},
		{"from the description as a last resort", "Add CSV export", "csv", "Implements OTTER-642.", "OTTER-642"},
		{"the title wins over the branch and description", "OTTER-1 a", "x/OTTER-2", "OTTER-3", "OTTER-1"},
		{"the branch wins over the description", "Add CSV export", "x/OTTER-2", "OTTER-3", "OTTER-2"},
		{"lowercase is normalized", "otter-644 fix", "", "", "OTTER-644"},
		{"a space separator is accepted", "OTTER 645 add export", "", "", "OTTER-645"},
		{"a second board is recognized", "SHRIMP-263 tweak", "", "", "SHRIMP-263"},
		{"the SHRMP typo maps to SHRIMP", "SHRMP-249 tweak", "", "", "SHRIMP-249"},
		{"a Jira URL in the description resolves", "Add export", "csv", "See https://openstax.atlassian.net/browse/OTTER-646", "OTTER-646"},
		{"no key anywhere", "Add CSV export", "csv-export", "no ticket here", ""},
		{"all fields empty", "", "", "", ""},

		// Ticket-SHAPED noise that actually occurs in management-app history. A
		// generic \w+-\d+ pattern turns each of these into a bogus card, which
		// would send the validator chasing a ticket that doesn't exist.
		{"a bare PR-ish number is not a key", "Fix flake", "fix-1234", "see #1234", ""},
		{"'fixes-2026' is not a key", "fixes-2026 cleanup", "", "", ""},
		{"'node-7' is not a key", "bump to node-7", "", "", ""},
		{"'haiku-4' is not a key", "use haiku-4", "", "", ""},
		{"'pages-6' is not a key", "pages-6 layout", "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := inferJiraCardFrom(c.title, c.branch, c.body); got != c.want {
				t.Fatalf("inferJiraCardFrom(%q,%q,%q) = %q, want %q",
					c.title, c.branch, c.body, got, c.want)
			}
		})
	}
}

func TestInferJiraCardNoPR(t *testing.T) {
	// A blank PR must not shell out to gh at all.
	if got := inferJiraCard("   "); got != "" {
		t.Fatalf("blank PR should infer nothing, got %q", got)
	}
}

// jenkins/actions build rollup entries in the two shapes GitHub actually returns:
// third-party commit statuses (StatusContext: Context + State, no Status field)
// and GitHub Actions checks (CheckRun: Name + Status + Conclusion).
func jenkins(context, state string) ciRollupEntry {
	return ciRollupEntry{TypeName: "StatusContext", Context: context, State: state}
}

func actions(name, status, conclusion string) ciRollupEntry {
	return ciRollupEntry{
		TypeName: "CheckRun", Name: name, Status: status, Conclusion: conclusion,
	}
}

func TestClassifyCIRollup(t *testing.T) {
	const head = ciContextPrefix + "jenkins/pr-head"
	const branch = ciContextPrefix + "jenkins/branch"

	cases := []struct {
		name    string
		entries []ciRollupEntry
		want    string
	}{
		{
			name:    "all deployment checks green",
			entries: []ciRollupEntry{jenkins(head, "SUCCESS"), jenkins(branch, "SUCCESS")},
			want:    "ok",
		},
		{
			name:    "a deployment check still running blocks",
			entries: []ciRollupEntry{jenkins(head, "PENDING"), jenkins(branch, "SUCCESS")},
			want:    "pending",
		},
		{
			name:    "a failed deployment check blocks",
			entries: []ciRollupEntry{jenkins(head, "FAILURE")},
			want:    "failed",
		},
		{
			name:    "an errored deployment check blocks",
			entries: []ciRollupEntry{jenkins(head, "ERROR")},
			want:    "failed",
		},
		{
			// Jenkins hasn't reported at all: the preview isn't built, which is
			// exactly the case a tester must not validate against.
			name:    "no matching check at all blocks",
			entries: []ciRollupEntry{actions("lint", "COMPLETED", "SUCCESS")},
			want:    "none",
		},
		{
			// The Actions checks don't build the preview, so their state is
			// irrelevant to whether the deployed code is current.
			name: "failing Actions checks are ignored",
			entries: []ciRollupEntry{
				jenkins(head, "SUCCESS"),
				actions("lint", "COMPLETED", "FAILURE"),
				actions("e2e", "IN_PROGRESS", ""),
			},
			want: "ok",
		},
		{
			// GitHub returns one entry per run; the latest is the one that
			// reflects the current commit, so a passing re-run must win.
			name:    "a re-run supersedes an earlier failure of the same check",
			entries: []ciRollupEntry{jenkins(head, "FAILURE"), jenkins(head, "SUCCESS")},
			want:    "ok",
		},
		{
			name:    "a failing re-run supersedes an earlier success",
			entries: []ciRollupEntry{jenkins(head, "SUCCESS"), jenkins(head, "FAILURE")},
			want:    "failed",
		},
		{
			// Worst state wins: one red check is not redeemed by a green one.
			name:    "failure outranks pending",
			entries: []ciRollupEntry{jenkins(head, "PENDING"), jenkins(branch, "FAILURE")},
			want:    "failed",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := classifyCIRollup(c.entries)
			if got.State != c.want {
				t.Fatalf("classifyCIRollup() = %q, want %q (warning: %s)",
					got.State, c.want, got.Warning)
			}
			if c.want != "ok" && got.Warning == "" {
				t.Fatal("a non-ok status must carry a warning for the UI")
			}
		})
	}
}

func TestPrCIStatusBlocking(t *testing.T) {
	blocking := map[string]bool{
		"ok": false, "pending": true, "failed": true, "none": true,
		// Not being able to ASK GitHub is our problem, not evidence of a stale
		// deployment — blocking on it would strand a tester with no way forward.
		"unknown": false,
	}
	for state, want := range blocking {
		if got := (PrCIStatus{State: state}).Blocking(); got != want {
			t.Fatalf("PrCIStatus{%q}.Blocking() = %v, want %v", state, got, want)
		}
	}
}

func TestPrCIStatusNoPR(t *testing.T) {
	// Validating a Jira card with no PR has no preview deployment to gate on, and
	// must not shell out to gh.
	if got := prCIStatus("  "); got.State != "ok" {
		t.Fatalf("blank PR should not gate, got %q", got.State)
	}
}

func TestComposeValidationPrompt(t *testing.T) {
	t.Run("appends user instructions as a final paragraph", func(t *testing.T) {
		p := composeValidationPrompt("qa", "", "OTTER-1", "Focus on the mobile layout.")
		if !strings.Contains(p, "/qa-validate") || !strings.Contains(p, "OTTER-1") {
			t.Fatalf("base prompt missing:\n%s", p)
		}
		if !strings.Contains(p, "\n\nAdditional instructions from the user:\nFocus on the mobile layout.") {
			t.Fatalf("instructions not appended as a paragraph:\n%s", p)
		}
	})

	t.Run("omits the instructions paragraph when blank/whitespace", func(t *testing.T) {
		p := composeValidationPrompt("qa", "", "OTTER-1", "   ")
		if strings.Contains(p, "Additional instructions") {
			t.Fatalf("blank instructions should not add a paragraph:\n%s", p)
		}
	})

	t.Run("a PR target overrides env", func(t *testing.T) {
		p := composeValidationPrompt("qa", "42", "OTTER-1", "")
		if !strings.Contains(p, "--pr 42") || strings.Contains(p, "--env qa") {
			t.Fatalf("PR target not used:\n%s", p)
		}
	})

	// Validating by PR alone: the card couldn't be inferred, so Claude is told to
	// identify the ticket from the PR rather than being handed a key.
	t.Run("with no card, asks Claude to identify the ticket from the PR", func(t *testing.T) {
		p := composeValidationPrompt("qa", "42", "", "")
		for _, want := range []string{
			"/qa-validate",
			"Validate PR 42 of safeinsights/management-app",
			"identify the Jira ticket",
		} {
			if !strings.Contains(p, want) {
				t.Fatalf("by-PR prompt missing %q:\n%s", want, p)
			}
		}
	})

	t.Run("the by-PR prompt still carries the PR caveat and instructions", func(t *testing.T) {
		p := composeValidationPrompt("qa", "42", "", "Check the CSV export.")
		caveat := strings.Index(p, "PR preview environment")
		instructions := strings.Index(p, "Additional instructions from the user:")
		if caveat < 0 || instructions < 0 || instructions < caveat {
			t.Fatalf("caveat/instructions wrong on a by-PR prompt:\n%s", p)
		}
	})

	// A PR preview has empty dashboards and no compute backend. Without saying so,
	// the validator reads an empty dashboard as a regression and waits on results
	// that will never arrive.
	t.Run("a PR target explains the empty dashboards and missing execution", func(t *testing.T) {
		p := composeValidationPrompt("qa", "42", "OTTER-1", "")
		for _, want := range []string{
			"PR preview environment",
			"No studies are preloaded",
			"do NOT actually run code",
		} {
			if !strings.Contains(p, want) {
				t.Fatalf("PR caveat missing %q:\n%s", want, p)
			}
		}
	})

	// The caveat names the PR + repo so the validator hands `pr-review` an explicit
	// target. A bare `gh pr view 839` would resolve against the qa-review checkout
	// the session runs in, not the repo actually under test.
	t.Run("the PR caveat names the PR and repo for the pr-review skill", func(t *testing.T) {
		p := composeValidationPrompt("qa", "839", "OTTER-1", "")
		for _, want := range []string{
			"deployment of PR 839 of safeinsights/management-app",
			"/pr-review 839 --repo safeinsights/management-app",
			"show the user the returned review URL",
		} {
			if !strings.Contains(p, want) {
				t.Fatalf("PR caveat missing %q:\n%s", want, p)
			}
		}
		if strings.Contains(p, "{{") {
			t.Fatalf("unsubstituted placeholder in the PR caveat:\n%s", p)
		}
	})

	t.Run("the PR caveat is absent on a plain env run", func(t *testing.T) {
		p := composeValidationPrompt("qa", "", "OTTER-1", "")
		if strings.Contains(p, "PR preview environment") {
			t.Fatalf("PR caveat should not appear for --env qa:\n%s", p)
		}
	})

	// The user's own instructions must stay the LAST paragraph, so they aren't
	// buried above a wall of boilerplate.
	t.Run("user instructions still come last on a PR run", func(t *testing.T) {
		p := composeValidationPrompt("qa", "42", "OTTER-1", "Check the CSV export.")
		caveat := strings.Index(p, "PR preview environment")
		instructions := strings.Index(p, "Additional instructions from the user:")
		if caveat < 0 || instructions < 0 || instructions < caveat {
			t.Fatalf("instructions should follow the PR caveat:\n%s", p)
		}
	})
}

// A missing email or token is "not set up yet", not "broken" — the doctor must say
// which field is absent and must NOT make a network call to find out.
func TestJiraCheckMissingFields(t *testing.T) {
	for _, tc := range []struct {
		name, wantDetail string
		cfg              JiraCfg
	}{
		{"both empty", "not configured", JiraCfg{}},
		{"no username", "no JIRA_USERNAME", JiraCfg{Token: "tok"}},
		{"no token", "no JIRA_API_TOKEN", JiraCfg{Username: "qa@example.com"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// A URL that would fail loudly if the check tried to dial it.
			tc.cfg.URL = "http://127.0.0.1:1"
			got := jiraCheck(tc.cfg)
			if got.OK {
				t.Fatalf("jiraCheck(%+v).OK = true, want false", tc.cfg)
			}
			if !strings.Contains(got.Detail, tc.wantDetail) {
				t.Fatalf("Detail = %q, want it to mention %q", got.Detail, tc.wantDetail)
			}
			if got.Hint == "" {
				t.Fatal("a failing check must carry a Hint")
			}
		})
	}
}

// jiraStub serves both endpoints the check calls: /myself and /mypermissions. grants
// maps a permission key to whether the account holds it; a key absent from the map is
// served as havePermission:false.
func jiraStub(t *testing.T, grants map[string]bool) (*httptest.Server, *[]string) {
	t.Helper()
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/rest/api/3/mypermissions" {
			perms := map[string]map[string]bool{}
			// Echo back only what was ASKED for, as real Jira does — so a test can't
			// pass by the stub volunteering a permission the check never requested.
			for _, k := range strings.Split(r.URL.Query().Get("permissions"), ",") {
				if k == "" {
					continue
				}
				perms[k] = map[string]bool{"havePermission": grants[k]}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"permissions": perms})
			return
		}
		_, _ = w.Write([]byte(`{"displayName":"QA Bot","emailAddress":"qa@example.com"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &paths
}

func allJiraGrants() map[string]bool {
	return map[string]bool{"ADD_COMMENTS": true, "CREATE_ATTACHMENTS": true, "TRANSITION_ISSUES": true}
}

// Fully configured, Jira accepts, and the account can write: the check passes and
// names the authenticated account, so the user can spot a token belonging to the
// WRONG account.
func TestJiraCheckAuthenticates(t *testing.T) {
	var gotUser, gotPass string
	srv, paths := jiraStub(t, allJiraGrants())
	// Wrap to capture the credentials the check actually sends.
	inner := srv.Config.Handler
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, _ = r.BasicAuth()
		inner.ServeHTTP(w, r)
	})

	got := jiraCheck(JiraCfg{URL: srv.URL, Username: "qa@example.com", Token: "tok-123"})
	if !got.OK {
		t.Fatalf("jiraCheck() failed against a healthy server: %s", got.Detail)
	}
	if !strings.Contains(got.Detail, "QA Bot") {
		t.Fatalf("Detail = %q, want the authenticated account name", got.Detail)
	}
	// Same endpoints + Basic scheme the engine's jira.ts uses, so a pass here really
	// does predict that `qar jira-comment` can authenticate AND write.
	want := []string{"/rest/api/3/myself", "/rest/api/3/mypermissions"}
	if !reflect.DeepEqual(*paths, want) {
		t.Fatalf("probed %v, want %v", *paths, want)
	}
	if gotUser != "qa@example.com" || gotPass != "tok-123" {
		t.Fatalf("basic auth = %q:%q, want the configured email:token", gotUser, gotPass)
	}
}

// THE failure this check exists for: the credentials are valid and /myself succeeds,
// but the account can't write. A read-only token would otherwise pass the doctor and
// then fail at the end of a validation, which is the worst moment to find out.
func TestJiraCheckMissingWritePermission(t *testing.T) {
	for _, tc := range []struct {
		name, revoke, wantVerb string
	}{
		{"cannot comment", "ADD_COMMENTS", "post comments"},
		{"cannot attach", "CREATE_ATTACHMENTS", "attach screenshots"},
		{"cannot transition", "TRANSITION_ISSUES", "transition issues"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			grants := allJiraGrants()
			grants[tc.revoke] = false
			srv, _ := jiraStub(t, grants)

			got := jiraCheck(JiraCfg{URL: srv.URL, Username: "qa@example.com", Token: "tok"})
			if got.OK {
				t.Fatalf("jiraCheck() passed without %s", tc.revoke)
			}
			if !strings.Contains(got.Detail, tc.wantVerb) {
				t.Fatalf("Detail = %q, want it to name %q", got.Detail, tc.wantVerb)
			}
			// Authentication SUCCEEDED here — saying otherwise would send the user to
			// re-check a token that is fine.
			if !strings.Contains(got.Detail, "QA Bot") {
				t.Fatalf("Detail = %q, want it to confirm who authenticated", got.Detail)
			}
		})
	}
}

// Every write permission missing: all three are named, not just the first.
func TestJiraCheckReportsEveryMissingPermission(t *testing.T) {
	srv, _ := jiraStub(t, map[string]bool{})

	got := jiraCheck(JiraCfg{URL: srv.URL, Username: "qa@example.com", Token: "tok"})
	if got.OK {
		t.Fatal("jiraCheck() passed with no write permissions at all")
	}
	for _, verb := range []string{"post comments", "attach screenshots", "transition issues"} {
		if !strings.Contains(got.Detail, verb) {
			t.Fatalf("Detail = %q, want it to name %q", got.Detail, verb)
		}
	}
}

// A permission probe that can't RUN is not evidence of a missing permission. Report it
// as unverified rather than failing a user whose access is actually fine.
func TestJiraCheckPermissionProbeUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/api/3/mypermissions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"displayName":"QA Bot"}`))
	}))
	defer srv.Close()

	got := jiraCheck(JiraCfg{URL: srv.URL, Username: "qa@example.com", Token: "tok"})
	if got.OK {
		t.Fatal("jiraCheck() passed when write access could not be verified")
	}
	if !strings.Contains(got.Detail, "couldn't verify") {
		t.Fatalf("Detail = %q, want it to say write access is unverified", got.Detail)
	}
	// Must not claim a permission is missing when we simply couldn't ask.
	if strings.Contains(got.Detail, "cannot ") {
		t.Fatalf("Detail = %q, must not assert a missing permission it never observed", got.Detail)
	}
}

// The failure a presence-only check can't catch: every field is filled in, but the
// token is expired/revoked. The detail must say so rather than blaming the settings.
func TestJiraCheckRejectsBadToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	got := jiraCheck(JiraCfg{URL: srv.URL, Username: "qa@example.com", Token: "stale"})
	if got.OK {
		t.Fatal("jiraCheck() passed with a 401 from Jira")
	}
	if !strings.Contains(got.Detail, "expired") && !strings.Contains(got.Detail, "revoked") {
		t.Fatalf("Detail = %q, want it to point at the token", got.Detail)
	}
}

// An unreachable host must fail as a connectivity problem, not hang or panic.
func TestJiraCheckUnreachable(t *testing.T) {
	got := jiraCheck(JiraCfg{URL: "http://127.0.0.1:1", Username: "qa@example.com", Token: "tok"})
	if got.OK {
		t.Fatal("jiraCheck() passed against an unreachable host")
	}
	if !strings.Contains(got.Detail, "can't reach") {
		t.Fatalf("Detail = %q, want a reachability message", got.Detail)
	}
}

// killGroupsNow must reap a process group SYNCHRONOUSLY, including children that
// ignore SIGTERM. teardownSession only SIGTERMs and defers the SIGKILL to goroutines
// that fire 2-3s later; at app quit the process exits before those run, orphaning
// anything still alive. `npx` wrappers and the chrome-devtools-mcp telemetry watchdog
// are exactly that shape — orphans pinned to long-dead CDP ports were found
// accumulating on a real machine.
func TestKillGroupsNowReapsSigtermIgnoringChild(t *testing.T) {
	// A `sh` trap doesn't reliably survive under exec.Command, so use the test binary
	// itself as the child: TestHelperIgnoresSigterm explicitly ignores SIGTERM, which
	// is the behavior that has to be exercised.
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperIgnoresSigterm", "-test.v")
	cmd.Env = append(os.Environ(), "GO_HELPER_IGNORE_SIGTERM=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting child: %v", err)
	}
	// Wait for the child to announce it is running: signalling before signal.Ignore
	// takes effect kills it during test-binary startup and proves nothing.
	if _, err := stdout.Read(make([]byte, 64)); err != nil {
		t.Fatalf("child produced no output: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	pid := cmd.Process.Pid
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()

	// A SIGTERM alone must NOT kill it — otherwise this test proves nothing.
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	select {
	case <-done:
		t.Fatal("child died on SIGTERM; it cannot exercise the escalation path")
	case <-time.After(500 * time.Millisecond):
	}

	killGroupsNow([]int{pid})

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		t.Fatal("killGroupsNow returned but the child survived; it would be orphaned at quit")
	}
}

// No live session must not panic or stall the quit path.
func TestKillGroupsNowNoSession(t *testing.T) {
	start := time.Now()
	killGroupsNow(nil)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("killGroupsNow(nil) took %s; quitting with no session must be instant", elapsed)
	}
}

// TestHelperIgnoresSigterm is not a real test: it is the child process spawned by
// TestKillGroupsNowReapsSigtermIgnoringChild. Guarded by an env var so it no-ops
// during a normal run. It ignores SIGTERM and blocks, so only a SIGKILL ends it.
func TestHelperIgnoresSigterm(t *testing.T) {
	if os.Getenv("GO_HELPER_IGNORE_SIGTERM") != "1" {
		t.Skip("helper process; not a standalone test")
	}
	signal.Ignore(syscall.SIGTERM)
	time.Sleep(30 * time.Second)
}

// The order of guiPathDirs is a PRIORITY RANKING, and prepending its entries one at
// a time reversed it — each prepend pushed the previous one back. prependPathDirs
// builds the result in a single pass instead. See issue #36.
func TestPrependPathDirsHonorsPriorityOverInherited(t *testing.T) {
	// The user's inherited PATH already contains /usr/local/bin.
	got := prependPathDirs("/usr/local/bin:/usr/bin:/bin", []string{
		"/Users/x/.local/bin", "/Users/x/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
	})
	dirs := strings.Split(got, ":")

	idx := func(want string) int {
		for i, d := range dirs {
			if d == want {
				return i
			}
		}
		t.Fatalf("%q missing from %q", want, got)
		return -1
	}
	if idx("/opt/homebrew/bin") > idx("/usr/local/bin") {
		t.Fatalf("Homebrew must outrank /usr/local/bin, got %q", got)
	}
	// No duplicates: an inherited dir is relocated, not repeated.
	seen := map[string]bool{}
	for _, d := range dirs {
		if seen[d] {
			t.Fatalf("duplicate %q in %q", d, got)
		}
		seen[d] = true
	}
	// Inherited-only entries survive.
	if !strings.Contains(got, "/usr/bin") {
		t.Fatalf("inherited dirs were dropped: %q", got)
	}
}

// The Doctor showed a green "✓ Node.js v21.1.0" while every session came up with no
// browser tools: it only checked that node RAN, never that npx could run the MCP
// servers on it. Versions here are chrome-devtools-mcp's declared engines.
func TestNodeVersionProblem(t *testing.T) {
	unsupported := []string{
		"v21.1.0",  // issue #36: predates import.meta.dirname; crashes at import
		"v21.7.3",  // no 21.x satisfies the range
		"v20.11.0", // has import.meta.dirname but below the ^20.19.0 floor
		"v22.11.0", // below the ^22.12.0 floor
		"v18.20.4",
	}
	for _, v := range unsupported {
		if nodeVersionProblem(v) == "" {
			t.Errorf("nodeVersionProblem(%q) = ok, want a problem", v)
		}
	}
	for _, v := range []string{"v20.19.0", "v22.12.0", "v22.21.0", "v23.0.0", "v26.1.0"} {
		if why := nodeVersionProblem(v); why != "" {
			t.Errorf("nodeVersionProblem(%q) = %q, want ok", v, why)
		}
	}
	// An unrecognized format must NOT be reported as a problem — a doctor that cries
	// wolf on an unexpected version string is worse than one that stays quiet.
	for _, v := range []string{"", "not-a-version", "v22"} {
		if why := nodeVersionProblem(v); why != "" {
			t.Errorf("nodeVersionProblem(%q) = %q, want silence on unparseable input", v, why)
		}
	}
}

// The end-to-end guard for issue #36: withGuiPath() itself must rank Homebrew ahead
// of /usr/local/bin even when the inherited PATH already contains /usr/local/bin.
// TestPrependPathDirsHonorsPriorityOverInherited covers the helper in isolation, but
// only this exercises the code path that actually built the user's broken PATH.
func TestWithGuiPathRanksHomebrewOverUsrLocal(t *testing.T) {
	// The PATH a Finder-launched app inherits: neither Homebrew nor /usr/local/bin is
	// present, so the old loop prepended each in turn and EVERY prepend pushed the
	// previous one back — reversing guiPathDirs and leaving Homebrew last among them.
	// This input reproduces the reporter's PATH exactly, /usr/sbin:/sbin tail included.
	t.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
	t.Setenv("QAR_REPO_DIR", t.TempDir())

	var pathVal string
	for _, e := range withGuiPath() {
		if strings.HasPrefix(e, "PATH=") {
			pathVal = strings.TrimPrefix(e, "PATH=")
		}
	}
	dirs := strings.Split(pathVal, ":")
	pos := func(want string) int {
		for i, d := range dirs {
			if d == want {
				return i
			}
		}
		t.Fatalf("%q missing from PATH %q", want, pathVal)
		return -1
	}
	if pos("/opt/homebrew/bin") > pos("/usr/local/bin") {
		t.Fatalf("PATH puts /usr/local/bin ahead of Homebrew, so npx picks the wrong node: %q", pathVal)
	}
}

// The doctor row is advisory: git with no user.name/user.email usually still
// commits (auto-detected `<username>@<hostname>`), which makes for poor keyring
// attribution — and when auto-detection also fails, the commit is refused
// outright. Either way the doctor should name the unset config up front.
func TestGitIdentityCheck(t *testing.T) {
	for _, tc := range []struct {
		name, gitName, gitEmail, wantDetail string
		wantOK                              bool
	}{
		{"both set", "Ada Lovelace", "ada@x.com", "Ada Lovelace <ada@x.com>", true},
		{"neither set", "", "", "no user.name or user.email", false},
		{"no name", "", "ada@x.com", "no user.name", false},
		{"no email", "Ada Lovelace", "", "no user.email", false},
		// `git config user.name ""` yields a blank line, not an error — treating that
		// as configured would report a green row for an identity git won't use.
		{"whitespace only", "  ", "\t", "no user.name or user.email", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := gitIdentityCheck(tc.gitName, tc.gitEmail)
			if got.OK != tc.wantOK {
				t.Fatalf("gitIdentityCheck(%q, %q).OK = %v, want %v", tc.gitName, tc.gitEmail, got.OK, tc.wantOK)
			}
			if !strings.Contains(got.Detail, tc.wantDetail) {
				t.Fatalf("Detail = %q, want it to mention %q", got.Detail, tc.wantDetail)
			}
			if !tc.wantOK && got.Hint == "" {
				t.Fatal("a failing git identity check must carry a hint with the fix")
			}
		})
	}
}

// The figma row is parsed from `claude mcp list`, whose health check is the same
// view a session gets (the per-session --mcp-config is additive, not exclusive).
// "Connected" doubles as the access check: an unauthenticated remote figma server
// reports "Needs authentication", never "Connected".
func TestFigmaMcpCheck(t *testing.T) {
	// Real `claude mcp list` output shape, figma via the Claude Code plugin.
	healthy := "Checking MCP server health…\n\n" +
		"chrome-devtools: npx chrome-devtools-mcp@1.6.0 - ✔ Connected\n" +
		"plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected\n" +
		"jira-atlassian: uvx mcp-atlassian - ✔ Connected"

	for _, tc := range []struct {
		name, out, wantDetail, wantHint string
		err                             error
		wantOK                          bool
	}{
		{name: "plugin connected", out: healthy, wantOK: true, wantDetail: "plugin:figma:figma"},
		{
			name:       "needs authentication",
			out:        "plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ⚠ Needs authentication",
			wantOK:     false,
			wantDetail: "Needs authentication",
			wantHint:   "/mcp",
		},
		{
			name:       "failed to connect",
			out:        "figma: https://mcp.figma.com/mcp (HTTP) - ✘ Failed to connect",
			wantOK:     false,
			wantDetail: "Failed to connect",
			wantHint:   "/mcp",
		},
		{
			name:       "no figma server",
			out:        "chrome-devtools: npx chrome-devtools-mcp@1.6.0 - ✔ Connected",
			wantOK:     false,
			wantDetail: "no figma server",
			wantHint:   "claude mcp add",
		},
		{
			// Only the server NAME may match: a command line that mentions figma (a
			// wrapper script, a proxy) is not a figma server.
			name:       "figma only in the command",
			out:        "designproxy: npx figma-proxy - ✔ Connected",
			wantOK:     false,
			wantDetail: "no figma server",
		},
		{
			name:       "claude mcp list fails",
			out:        "some error output",
			err:        errors.New("exit status 1"),
			wantOK:     false,
			wantDetail: "`claude mcp list` failed",
		},
		{
			// Two figma entries where one is healthy: the connected one wins — the
			// stale/broken duplicate shouldn't fail a working setup.
			name: "one of two connected",
			out: "figma-old: npx old-figma-mcp - ✘ Failed to connect\n" +
				"plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected",
			wantOK:     true,
			wantDetail: "plugin:figma:figma",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := figmaMcpCheck(tc.out, tc.err)
			if got.OK != tc.wantOK {
				t.Fatalf("figmaMcpCheck().OK = %v, want %v (detail: %s)", got.OK, tc.wantOK, got.Detail)
			}
			if !strings.Contains(got.Detail, tc.wantDetail) {
				t.Fatalf("Detail = %q, want it to mention %q", got.Detail, tc.wantDetail)
			}
			if tc.wantHint != "" && !strings.Contains(got.Hint, tc.wantHint) {
				t.Fatalf("Hint = %q, want it to mention %q", got.Hint, tc.wantHint)
			}
			if !tc.wantOK && got.Hint == "" {
				t.Fatal("a failing figma check must carry a Hint with the fix")
			}
		})
	}
}

// A Finder-launched .app inherits NO TERM (launchd sets none — only a shell does),
// so `claude` saw a capability-less terminal and emitted plain text: the embedded
// xterm rendered black-and-white. Under `wails dev` the launching shell's TERM leaked
// in, which is why it only reproduced in the packaged app. withGuiPath() must declare
// the terminal itself so both paths behave identically.
func TestWithGuiPathDeclaresColorTerminal(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", t.TempDir())

	get := func(env []string, key string) (string, bool) {
		var val string
		var found bool
		// Last assignment wins, matching how exec applies a duplicated env key.
		for _, e := range env {
			if strings.HasPrefix(e, key+"=") {
				val, found = strings.TrimPrefix(e, key+"="), true
			}
		}
		return val, found
	}

	t.Run("sets TERM and COLORTERM when the parent has none", func(t *testing.T) {
		os.Unsetenv("TERM")
		os.Unsetenv("COLORTERM")
		env := withGuiPath()
		if term, ok := get(env, "TERM"); !ok || term != "xterm-256color" {
			t.Fatalf("TERM = %q (found=%v), want xterm-256color", term, ok)
		}
		if ct, ok := get(env, "COLORTERM"); !ok || ct != "truecolor" {
			t.Fatalf("COLORTERM = %q (found=%v), want truecolor", ct, ok)
		}
	})

	// Under `wails dev` the shell's TERM is inherited. A dumb/unset-capability value
	// must not survive, or dev and packaged would render differently.
	t.Run("overrides an inherited TERM rather than passing it through", func(t *testing.T) {
		t.Setenv("TERM", "dumb")
		env := withGuiPath()
		if term, _ := get(env, "TERM"); term != "xterm-256color" {
			t.Fatalf("inherited TERM=dumb survived as %q", term)
		}
		for _, e := range env {
			if e == "TERM=dumb" {
				t.Fatal("stale TERM=dumb still present in env")
			}
		}
	})

	// NO_COLOR overrides TERM entirely, so a user who exports it for their shell would
	// get a monochrome embedded terminal with no indication why.
	t.Run("drops an inherited NO_COLOR", func(t *testing.T) {
		t.Setenv("NO_COLOR", "1")
		env := withGuiPath()
		if _, ok := get(env, "NO_COLOR"); ok {
			t.Fatal("NO_COLOR survived into the child env; the terminal would be monochrome")
		}
	})
}

// The orphan this guards against: a `qar run` started at 09:14:51 outlived the
// 09:23:59 app quit, which logged "0 session group(s) reaped", and was still
// running four days later holding a Chrome, an esbuild service and an ffmpeg.
// shutdown reaped only the session and the PTY; the run was never in the list.
func TestLivePidsIncludesInFlightRun(t *testing.T) {
	a := NewApp()
	if got := a.livePids(); len(got) != 0 {
		t.Fatalf("fresh App livePids() = %v, want none", got)
	}

	// A reserved-but-unstarted run has no Process yet (streamCmd claims the slot
	// before Start), so it must contribute no pid rather than panicking.
	a.runMu.Lock()
	a.runCmd = &exec.Cmd{}
	a.runMu.Unlock()
	if got := a.livePids(); len(got) != 0 {
		t.Fatalf("livePids() with a reserved run = %v, want none", got)
	}

	cmd := exec.Command("sleep", "30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting stand-in run: %v", err)
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_, _ = cmd.Process.Wait()
	}()
	a.runMu.Lock()
	a.runCmd = cmd
	a.runMu.Unlock()

	got := a.livePids()
	if len(got) != 1 || got[0] != cmd.Process.Pid {
		t.Fatalf("livePids() = %v, want [%d] (the in-flight run)", got, cmd.Process.Pid)
	}
}

// Quitting with a run in flight must actually kill it. Before the fix the process
// survived shutdown and was reparented to init.
func TestShutdownReapsInFlightRun(t *testing.T) {
	a := NewApp()
	// Long enough that a natural exit can never be mistaken for a successful kill.
	cmd := exec.Command("sleep", "120")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting stand-in run: %v", err)
	}
	pid := cmd.Process.Pid
	// Reap in the background: Wait blocks while the process is alive, so calling it
	// inline would stall until `sleep` exits on its own and report a pass no matter
	// what shutdown did. Waiting off-thread turns "did it die" into a race we can
	// bound, and reaps the child so it never lingers as a zombie.
	exited := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		// Mimic streamCmd's reader goroutine, which clears a.runCmd once the process
		// is reaped. Without this the test still passes, but only because
		// terminateRun's poll loop never sees the clear and burns its whole 3s window
		// down to the last-resort SIGKILL — so the SIGTERM path this PR argues is
		// load-bearing (it is what disposes of the detached Chromium) would go
		// unexercised, and a regression to a straight SIGKILL would stay green.
		a.runMu.Lock()
		if a.runCmd == cmd {
			a.runCmd = nil
		}
		a.runMu.Unlock()
		close(exited)
	}()
	defer func() { _ = syscall.Kill(-pid, syscall.SIGKILL) }()
	a.runMu.Lock()
	a.runCmd = cmd
	a.runMu.Unlock()

	// No session and no PTY, so StopSession is a no-op and never emits on a nil ctx.
	start := time.Now()
	a.shutdown(context.Background())
	elapsed := time.Since(start)

	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatalf("run pid %d still alive after shutdown — it would be orphaned to init", pid)
	}

	// SIGTERM alone should end `sleep` well inside the 1.5s escalation window. A
	// shutdown that takes longer means the poll loop ran to its deadline and the
	// process died to a SIGKILL instead — the regression this test exists to catch.
	if elapsed >= 1500*time.Millisecond {
		t.Fatalf("shutdown took %v — the run died to SIGKILL escalation, not the SIGTERM that disposes of the browser", elapsed)
	}
}

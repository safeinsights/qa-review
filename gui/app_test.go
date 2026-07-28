package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
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

// Fully configured + Jira accepts: the check passes and names the authenticated
// account, so the user can spot a token belonging to the WRONG account.
func TestJiraCheckAuthenticates(t *testing.T) {
	var gotUser, gotPass, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, _ = r.BasicAuth()
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"displayName":"QA Bot","emailAddress":"qa@example.com"}`))
	}))
	defer srv.Close()

	got := jiraCheck(JiraCfg{URL: srv.URL, Username: "qa@example.com", Token: "tok-123"})
	if !got.OK {
		t.Fatalf("jiraCheck() failed against a healthy server: %s", got.Detail)
	}
	if !strings.Contains(got.Detail, "QA Bot") {
		t.Fatalf("Detail = %q, want the authenticated account name", got.Detail)
	}
	// Same endpoint + Basic scheme the engine's jira.ts uses, so a pass here really
	// does predict that `qar jira-comment` can authenticate.
	if gotPath != "/rest/api/3/myself" {
		t.Fatalf("probed %q, want /rest/api/3/myself", gotPath)
	}
	if gotUser != "qa@example.com" || gotPass != "tok-123" {
		t.Fatalf("basic auth = %q:%q, want the configured email:token", gotUser, gotPass)
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

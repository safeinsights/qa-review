package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// In dev mode (`wails dev` — no packaged Resources bundle) and with no explicit
// QAR_REPO_DIR, repoDir() must resolve to the live dev checkout (the tree
// containing bin/qar.ts), NOT the ~/Library/.../qa-runner clone. This is what
// lets the GUI read+run uncommitted suites straight from the working tree. The
// go test binary runs without a Resources bundle, so resourcesDir() == "" here,
// exercising exactly the dev path.
func TestRepoDirUsesDevCheckoutInDevMode(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", "") // ensure no explicit override
	os.Unsetenv("QAR_REPO_DIR")

	if resourcesDir() != "" {
		t.Skip("not running in dev mode (a Resources bundle is present)")
	}
	got := repoDir()
	if _, err := os.Stat(filepath.Join(got, "bin", "qar.ts")); err != nil {
		t.Fatalf("dev-mode repoDir()=%q is not the dev checkout (no bin/qar.ts): %v", got, err)
	}
}

// An explicit QAR_REPO_DIR always wins, even in dev mode (operator/test override).
func TestRepoDirRespectsExplicitOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QAR_REPO_DIR", dir)
	if got := repoDir(); got != dir {
		t.Fatalf("repoDir()=%q, want explicit override %q", got, dir)
	}
}

// In dev mode there is no Resources bundle, so qarBinValue() is empty and the
// bin/qar shim falls back to `pnpm qar`. (Packaged mode returns the node+bundle
// paths; that path can't be exercised without a real .app.)
func TestQarBinValueEmptyInDevMode(t *testing.T) {
	if resourcesDir() != "" {
		t.Skip("not running in dev mode (a Resources bundle is present)")
	}
	node, bundle := qarBinValue()
	if node != "" || bundle != "" {
		t.Fatalf("dev-mode qarBinValue()=(%q, %q), want both empty", node, bundle)
	}
	if env := qarBinEnv(); env != nil {
		t.Fatalf("dev-mode qarBinEnv()=%v, want nil", env)
	}
}

// The packaged app installs to "/Applications/SI QA Runner.app" — a path with a
// SPACE. QAR_NODE/QAR_BUNDLE must therefore each be a single value the shim can
// quote; regressing to one packed "<node> --import tsx <bundle>" string reintroduces
// the `/Applications/SI: No such file or directory` 127 at every bare `qar` call.
// Asserting each var round-trips a spaced path intact is what pins that apart.
func TestQarBinEnvKeepsSpacedPathsIntact(t *testing.T) {
	res := filepath.Join("/Applications", "SI QA Runner.app", "Contents", "Resources")

	node, bundle := qarBinValueIn(res)
	if node == "" || bundle == "" {
		t.Fatalf("qarBinValueIn(%q)=(%q, %q), want both populated", res, node, bundle)
	}

	env := qarBinEnvIn(res)
	got := map[string]string{}
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		got[k] = v
	}
	// Each var holds exactly one path, spaces and all — no shell tokens spliced in.
	if got["QAR_NODE"] != node {
		t.Fatalf("QAR_NODE=%q, want the node path %q", got["QAR_NODE"], node)
	}
	if got["QAR_BUNDLE"] != bundle {
		t.Fatalf("QAR_BUNDLE=%q, want the bundle path %q", got["QAR_BUNDLE"], bundle)
	}
	if strings.Contains(got["QAR_NODE"], " --import") {
		t.Fatalf("QAR_NODE=%q packs a command line; it must be the node path alone", got["QAR_NODE"])
	}
	if !strings.Contains(got["QAR_NODE"], "SI QA Runner.app") {
		t.Fatalf("QAR_NODE=%q lost the spaced .app path segment", got["QAR_NODE"])
	}
}

// withGuiPath() must put the repo's bin dir (holding the committed `qar` shim) on
// PATH so a bare `qar` resolves in the Claude PTY, and — in dev — must NOT set
// QAR_NODE/QAR_BUNDLE (empty qarBinValue), so the shim falls through to `pnpm qar`.
func TestWithGuiPathExportsBinDirAndOmitsQarBinInDev(t *testing.T) {
	if resourcesDir() != "" {
		t.Skip("not running in dev mode (a Resources bundle is present)")
	}
	dir := t.TempDir()
	t.Setenv("QAR_REPO_DIR", dir)

	env := withGuiPath()
	var pathVal string
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			pathVal = strings.TrimPrefix(e, "PATH=")
		}
		if strings.HasPrefix(e, "QAR_NODE=") || strings.HasPrefix(e, "QAR_BUNDLE=") {
			t.Fatalf("dev-mode withGuiPath() set %q; it must be unset in dev", e)
		}
	}
	wantBin := filepath.Join(dir, "bin")
	if !strings.Contains(pathVal, wantBin) {
		t.Fatalf("withGuiPath() PATH=%q does not contain repo bin dir %q", pathVal, wantBin)
	}
}

// A STALE inherited QAR_NODE/QAR_BUNDLE must not survive withGuiPath(). This is the
// state behind a real report: QAR_REPO_DIR was set (it is appended unconditionally)
// while the QAR_* engine pair was not (qarBinEnv returns nil when resourcesDir() is
// ""), so the `bin/qar` shim took its `pnpm qar` dev fallback inside a packaged
// install — where node_modules is a symlink into the .app and every pnpm route
// dead-ends on an unrelated-looking node-version error.
//
// TestWithGuiPathExportsBinDirAndOmitsQarBinInDev above passes only because the
// ambient env happens to be clean; it cannot catch a leak. This sets them first.
func TestWithGuiPathDropsInheritedQarBin(t *testing.T) {
	if resourcesDir() != "" {
		t.Skip("not running in dev mode (a Resources bundle is present)")
	}
	t.Setenv("QAR_REPO_DIR", t.TempDir())
	t.Setenv("QAR_NODE", "/Applications/Stale.app/Contents/Resources/runtime/node")
	t.Setenv("QAR_BUNDLE", "/Applications/Stale.app/Contents/Resources/engine/qar.bundle.mjs")

	for _, e := range withGuiPath() {
		if strings.HasPrefix(e, "QAR_NODE=") || strings.HasPrefix(e, "QAR_BUNDLE=") {
			t.Fatalf("withGuiPath() leaked inherited %q into a dev child", e)
		}
	}
}

// isolateAppSupport points appSupportDir() at a per-test temp dir so tests that
// write the diagnostic log neither see each other's entries nor touch the real one.
//
// Redirecting HOME alone is NOT enough: os.UserConfigDir() prefers $XDG_CONFIG_HOME
// on Unix and only falls back to $HOME/.config. CI sets XDG_CONFIG_HOME, so a
// HOME-only override left every test writing to one shared real path — which failed
// TestRecentDiagLogMarkdownAbsent (it found another test's entries) and, worse, wrote
// into the developer's actual config dir on Linux.
func isolateAppSupport(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, ".config"))
}

// readMcpServers reads a written MCP config file back into its mcpServers map.
func readMcpServers(t *testing.T, path string) map[string]map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read mcp config: %v", err)
	}
	var cfg struct {
		McpServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("parse mcp config: %v", err)
	}
	return cfg.McpServers
}

// With a Jira token, the validation MCP config carries BOTH chrome-devtools (so
// Claude drives the shared browser) and the jira-atlassian (uvx) server.
func TestWriteValidationMcpConfigWithJira(t *testing.T) {
	path, err := writeValidationMcpConfig(9222, JiraCfg{
		URL:      "https://example.atlassian.net",
		Username: "qa@example.com",
		Token:    "tok-123",
	})
	if err != nil {
		t.Fatalf("writeValidationMcpConfig: %v", err)
	}
	defer os.Remove(path)

	servers := readMcpServers(t, path)
	if _, ok := servers["chrome-devtools"]; !ok {
		t.Fatal("chrome-devtools server missing")
	}
	jira, ok := servers["jira-atlassian"]
	if !ok {
		t.Fatal("jira-atlassian server missing when token is set")
	}
	if jira["command"] != "uvx" {
		t.Fatalf("jira command = %v, want uvx", jira["command"])
	}
	env, ok := jira["env"].(map[string]any)
	if !ok {
		t.Fatal("jira env missing")
	}
	if env["JIRA_URL"] != "https://example.atlassian.net" ||
		env["JIRA_USERNAME"] != "qa@example.com" ||
		env["JIRA_API_TOKEN"] != "tok-123" {
		t.Fatalf("jira env = %v, want URL/username/token populated", env)
	}
	if tools, _ := env["ENABLED_TOOLS"].(string); !strings.Contains(tools, "jira_add_comment") {
		t.Fatalf("ENABLED_TOOLS = %q, want jira_add_comment included", tools)
	}
}

// Without a Jira token, the config carries ONLY chrome-devtools (no jira-atlassian
// server, so claude doesn't try to launch a broken uvx server with empty creds).
func TestWriteValidationMcpConfigNoJira(t *testing.T) {
	path, err := writeValidationMcpConfig(9222, JiraCfg{})
	if err != nil {
		t.Fatalf("writeValidationMcpConfig: %v", err)
	}
	defer os.Remove(path)

	servers := readMcpServers(t, path)
	if _, ok := servers["chrome-devtools"]; !ok {
		t.Fatal("chrome-devtools server missing")
	}
	if _, ok := servers["jira-atlassian"]; ok {
		t.Fatal("jira-atlassian server present without a token")
	}
}

// logDiag must write a timestamped, category-tagged line that recentDiagLogMarkdown
// can read back. HOME is redirected so the test never touches the real log.
func TestDiagLogRoundTrip(t *testing.T) {
	isolateAppSupport(t)

	logDiag("mcp", "chrome-devtools exited: %v", "boom")

	data, err := os.ReadFile(diagLogPath())
	if err != nil {
		t.Fatalf("reading diag log: %v", err)
	}
	if got := string(data); !strings.Contains(got, "[mcp]") || !strings.Contains(got, "chrome-devtools exited: boom") {
		t.Fatalf("diag log = %q, missing category tag or message", got)
	}
	if md := recentDiagLogMarkdown(); !strings.Contains(md, "chrome-devtools exited: boom") {
		t.Fatalf("recentDiagLogMarkdown() = %q, does not embed the entry", md)
	}
}

// An absent log must degrade to an explanatory note, not an error or empty section —
// an issue report always renders this block.
func TestRecentDiagLogMarkdownAbsent(t *testing.T) {
	isolateAppSupport(t)
	if md := recentDiagLogMarkdown(); !strings.Contains(md, "no diagnostic log") {
		t.Fatalf("recentDiagLogMarkdown() with no file = %q, want an explanatory note", md)
	}
}

// The log is embedded in GitHub issue bodies, so a secret passed to the engine must
// never reach the label built from its args.
func TestRedactArgsMasksSecretValues(t *testing.T) {
	got := strings.Join(redactArgs([]string{"set-secret", "--key", "QA_PASSWORD", "--value", "hunter2"}), " ")
	if strings.Contains(got, "hunter2") {
		t.Fatalf("redactArgs leaked the secret: %q", got)
	}
	for _, want := range []string{"--key QA_PASSWORD", "--value ***"} {
		if !strings.Contains(got, want) {
			t.Fatalf("redactArgs = %q, want it to contain %q", got, want)
		}
	}
	// A trailing secret flag with no value must not panic or corrupt the args.
	if got := strings.Join(redactArgs([]string{"run", "--value"}), " "); got != "run --value" {
		t.Fatalf("redactArgs on trailing flag = %q", got)
	}
}

// The probe's job is to leave a diagnosable record when the chrome-devtools MCP
// server cannot serve the session — the failure that is otherwise invisible, since
// the server is spawned by claude and its stderr is never seen. Pointed at a dead
// CDP port, it must log both the unreachable endpoint and a FAIL line. The exact
// failure varies by machine (no npx, no network, a broken @latest release), so this
// asserts a usable record exists rather than pinning one cause.
func TestProbeMcpServersLogsUnreachableBrowser(t *testing.T) {
	if testing.Short() {
		t.Skip("probe spawns npx and waits for it; skipped under -short")
	}
	isolateAppSupport(t)

	// Zero-value JiraCfg: this test exercises the unreachable-browser log path only,
	// and an unconfigured Jira is itself a case the probe has to tolerate.
	probeMcpServers(59999, JiraCfg{}) // nothing is listening here

	data, err := os.ReadFile(diagLogPath())
	if err != nil {
		t.Fatalf("probe wrote no log: %v", err)
	}
	got := string(data)
	if !strings.Contains(got, "session start: cdpPort=59999") {
		t.Fatalf("log missing the session header: %q", got)
	}
	// Without npx the probe returns before reaching the CDP check — a valid outcome
	// (CI runners and containers often lack node), and it must still say WHY. Asserting
	// the CDP line unconditionally made this fail wherever npx is absent.
	if strings.Contains(got, "npx not found") {
		return
	}
	// The dead browser must be called out separately from the MCP server, since
	// conflating the two is what sent the original bug report down the wrong path.
	if !strings.Contains(got, "CDP endpoint 127.0.0.1:59999 not answering") {
		t.Fatalf("log did not flag the unreachable CDP endpoint: %q", got)
	}
}

// The MCP server version must be PINNED, and the configs must use the same pin the
// probe tests. `@latest` re-resolves on every cold start, so an upstream release can
// break every session with no local change — and the failure is invisible (the
// session simply has no mcp__chrome-devtools__* tools). A probe that exercised a
// different version than the sessions use would report a healthy server while the
// real one failed, which is worse than no probe at all.
func TestChromeDevtoolsMcpVersionIsPinned(t *testing.T) {
	if strings.HasSuffix(chromeDevtoolsMcpPkg, "@latest") {
		t.Fatalf("chromeDevtoolsMcpPkg = %q; pin an explicit version", chromeDevtoolsMcpPkg)
	}
	if !strings.Contains(chromeDevtoolsMcpPkg, "@") {
		t.Fatalf("chromeDevtoolsMcpPkg = %q; want a name@version spec", chromeDevtoolsMcpPkg)
	}

	explore, err := writeSessionMcpConfig(9222)
	if err != nil {
		t.Fatalf("writeSessionMcpConfig: %v", err)
	}
	defer os.Remove(explore)
	validate, err := writeValidationMcpConfig(9222, JiraCfg{})
	if err != nil {
		t.Fatalf("writeValidationMcpConfig: %v", err)
	}
	defer os.Remove(validate)

	for _, path := range []string{explore, validate} {
		args, _ := readMcpServers(t, path)["chrome-devtools"]["args"].([]any)
		if len(args) == 0 || args[0] != chromeDevtoolsMcpPkg {
			t.Fatalf("%s: chrome-devtools args[0] = %v, want the pinned %q", path, args, chromeDevtoolsMcpPkg)
		}
	}
}

// The probe must reap its whole process tree. `npx` spawns three levels (npm exec ->
// the server -> a telemetry watchdog), so killing only cmd.Process orphans the real
// server — which keeps holding a CDP connection to the session browser. Orphans from
// prior sessions were observed accumulating on a real machine before this was fixed.
func TestProbeMcpServersLeavesNoOrphans(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns npx and waits out the probe window; skipped under -short")
	}
	isolateAppSupport(t)

	before := countMcpProcs()
	// Zero-value JiraCfg: this test counts spawned MCP processes, and an
	// unconfigured Jira is a case the probe has to tolerate regardless.
	probeMcpServers(59998, JiraCfg{}) // nothing listening; the server itself still starts
	time.Sleep(2 * time.Second)

	if after := countMcpProcs(); after > before {
		t.Fatalf("probe orphaned %d chrome-devtools-mcp process(es)", after-before)
	}
}

// countMcpProcs counts running instances of the PINNED chrome-devtools-mcp the
// probe spawns (0 if pgrep finds none). Matching the bare package name instead
// made this test count every unrelated MCP server on the machine — a developer's
// own editor/agent session runs `chrome-devtools-mcp@latest` — so one of those
// starting mid-test was misreported as an orphan leaked by the probe.
func countMcpProcs() int {
	out, _ := exec.Command("pgrep", "-f", chromeDevtoolsMcpPkg).Output()
	n := 0
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// qaReviewSlug is the GitHub repo the app clones on first launch via `gh repo
// clone`. (Leans on the user's gh auth, which staff are required to have installed
// + authenticated.)
const qaReviewSlug = "safeinsights/qa-review"

// repoDir is the single source of truth for where the cloned qa-review checkout
// lives — a user-writable dir, NOT inside the .app and NOT the old cwd="..".
// The engine receives this as QAR_REPO_DIR (see withGuiPath), and Go's settings
// reader (configDirFor) and git/engine spawns all key off it.
// appSupportDir is qa-runner's own writable dir (holds the repo-location pointer).
func appSupportDir() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, "Library", "Application Support")
	}
	return filepath.Join(base, "qa-runner")
}

// repoLocationFile persists the user's chosen clone location across launches.
func repoLocationFile() string {
	return filepath.Join(appSupportDir(), "repo-location.txt")
}

// defaultRepoDir is used when the user hasn't chosen a location.
func defaultRepoDir() string {
	return filepath.Join(appSupportDir(), "repo")
}

func repoDir() string {
	// QAR_REPO_DIR is the same override the engine reads (see src/engine/paths.ts),
	// so Go and the bundled engine agree on the repo location. An explicit value
	// always wins (lets an operator or tests point at any dir).
	if override := os.Getenv("QAR_REPO_DIR"); override != "" {
		return override
	}
	// Dev mode (`wails dev`, no packaged Resources bundle): use the live dev
	// checkout — the tree containing bin/qar.ts — as the repo. This makes the GUI
	// read config/suites (including UNCOMMITTED suites you're editing) straight
	// from your working tree, so `wails dev` never needs a commit+push+Sync round
	// trip. The packaged .app has Resources, so it skips this and uses the clone.
	if resourcesDir() == "" {
		if src := devSourceRepo(); src != "" {
			return src
		}
	}
	// Packaged app: a location the user picked at setup, if any.
	if data, err := os.ReadFile(repoLocationFile()); err == nil {
		if p := strings.TrimSpace(string(data)); p != "" {
			return p
		}
	}
	return defaultRepoDir()
}

// setRepoDir persists the user's chosen clone location for future launches.
func setRepoDir(dir string) error {
	if err := os.MkdirAll(appSupportDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(repoLocationFile(), []byte(dir), 0o644)
}

// repoReady reports whether the clone exists (has a .git dir).
func repoReady() bool {
	info, err := os.Stat(filepath.Join(repoDir(), ".git"))
	return err == nil && info.IsDir()
}

// verdictPostedPath mirrors the engine's verdictPostedPath() (src/engine/paths.ts):
// <repoDir>/results/verdict-posted.json. `qar verdict-posted` writes it (via the
// engine, which resolves the same repo via QAR_REPO_DIR); the validation session
// polls it here. Keep in sync with the TS path.
func verdictPostedPath() string {
	return filepath.Join(repoDir(), "results", "verdict-posted.json")
}

// resourcesDir returns the .app's Contents/Resources dir (where the engine bundle
// + shipped node + Playwright node_modules live), or "" when not running from an
// .app bundle (e.g. `wails dev`), in which case callers fall back to `pnpm qar`.
func resourcesDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	// Under `wails dev` the binary is built into gui/build/bin/<App>.app, which may
	// carry a STALE staged Resources bundle from a prior `make dmg`. Treat that as
	// dev (use the `pnpm qar` fallback) so dev always runs the live source.
	if strings.Contains(exe, filepath.Join("build", "bin")) {
		return ""
	}
	// <App>.app/Contents/MacOS/<bin> -> <App>.app/Contents/Resources
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	res := filepath.Join(contents, "Resources")
	if info, err := os.Stat(filepath.Join(res, "engine", "qar.bundle.mjs")); err == nil && !info.IsDir() {
		return res
	}
	return ""
}

// writeSessionMcpConfig writes a temp chrome-devtools MCP config whose server is
// pointed at the running session browser's CDP endpoint via --browserUrl, so
// claude drives THAT browser (the one streamed into the app) instead of launching
// its own. Returns the temp file path; the caller removes it at session teardown.
func writeSessionMcpConfig(cdpPort int) (string, error) {
	cfg := map[string]any{
		"mcpServers": map[string]any{
			"chrome-devtools": map[string]any{
				"command": "npx",
				"args": []string{
					chromeDevtoolsMcpPkg,
					fmt.Sprintf("--browserUrl=http://127.0.0.1:%d", cdpPort),
				},
			},
		},
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp("", "qar-explore-mcp-*.json")
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return "", err
	}
	return f.Name(), nil
}

// chromeDevtoolsMcpPkg pins the browser MCP server. It is PINNED, not `@latest`,
// because `@latest` re-resolves on every cold start: a new upstream release (or a
// failed fetch of one) breaks every session with no local change, and the failure is
// invisible — the session just comes up with no mcp__chrome-devtools__* tools. A
// pinned version also keeps the npx cache usable offline once warmed.
//
// Bumping it is a deliberate, testable change: update this constant, start a session,
// and confirm the probe logs "stayed up past" (see probeMcpServers).
const chromeDevtoolsMcpPkg = "chrome-devtools-mcp@1.6.0"

// diagLogPath is the app's append-only diagnostic log. It exists because this app's
// characteristic failure is SILENT: subprocesses (the engine, git/gh, claude, MCP
// servers) fail in ways that surface to the user only as an absence — no steps
// appear, a tool is missing, a button does nothing. The GUI folds engine stderr into
// a stdout parser that ignores non-JSON lines, MCP servers are spawned by `claude`
// where we never see their stderr, and per-session temp files are deleted at
// teardown. Without a durable record, a bug report carries no evidence at all.
func diagLogPath() string {
	return filepath.Join(appSupportDir(), "diagnostics.log")
}

// maxDiagLogBytes caps the on-disk log. When exceeded, the file is rotated to
// .log.1 (one generation kept) so a long-lived install can't grow without bound
// while a just-happened failure still survives the rotation.
const maxDiagLogBytes = 2 * 1024 * 1024

// logDiag appends one timestamped, category-tagged line to the diagnostic log.
// Best-effort by design: diagnostics must never break a session, so errors here are
// deliberately swallowed. `cat` is a short area tag ("mcp", "engine", "git") that
// makes the log greppable and groups related lines in an issue report.
func logDiag(cat, format string, args ...any) {
	_ = os.MkdirAll(appSupportDir(), 0o755)
	path := diagLogPath()
	if info, err := os.Stat(path); err == nil && info.Size() > maxDiagLogBytes {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%s] %s\n", time.Now().Format(time.RFC3339), cat, fmt.Sprintf(format, args...))
}

// logMcp records MCP session startup, the failure that motivated this log: a server
// that doesn't come up leaves the session with none of its mcp__* tools and no
// explanation, and nothing is recoverable from inside that session.
func logMcp(format string, args ...any) { logDiag("mcp", format, args...) }

// probeMcpServers records the environment facts that decide whether the chrome-devtools
// MCP server can start, and then actually STARTS it once to capture the failure.
//
// The two known failure modes are invisible at session start and look identical from
// inside the session (no mcp__chrome-devtools__* tools):
//   - `npx` is not on the GUI-augmented PATH (node installed via nvm/asdf/Volta, which
//     a Finder-launched app never searches — guiPathDirs only covers brew + /usr/local).
//   - The pinned chromeDevtoolsMcpPkg cannot be fetched (cold npx cache + no network)
//     or the pinned release is broken on this machine.
//
// The probe runs the real command and gives it a moment to fail. A healthy MCP server
// is a long-lived stdio process, so "still running when we look" IS the success signal;
// we kill it and let claude spawn its own. Exiting fast means it died — and its stderr
// is the diagnostic that is otherwise lost forever.
func probeMcpServers(cdpPort int) {
	logMcp("--- session start: cdpPort=%d", cdpPort)

	npx, err := exec.LookPath("npx")
	if err != nil {
		// Retry against the augmented PATH: LookPath uses the PARENT process PATH,
		// which for a Finder-launched app is just /usr/bin:/bin (see guiResolve).
		npx = guiResolve("npx")
		if npx == "npx" {
			logMcp("FAIL npx not found on PATH=%s", guiPath(withGuiPath()))
			logMcp("  chrome-devtools MCP cannot start; the session will have no browser tools.")
			return
		}
	}
	// Log the node npx will actually use, and flag it when unsupported. The crash it
	// causes (`The "path" argument must be of type string`) names neither node nor a
	// version, so without this the log shows a failure with no visible cause — which
	// is exactly what happened in issue #36.
	nodeVer, _ := runToolFull("node", "--version")
	if why := nodeVersionProblem(nodeVer); why != "" {
		logMcp("FAIL node %s is unsupported: %s", strings.TrimSpace(nodeVer), why)
		logMcp("  npx=%s will crash chrome-devtools-mcp at import; put a supported node FIRST on PATH", npx)
	} else {
		logMcp("ok npx=%s (node %s)", npx, strings.TrimSpace(nodeVer))
	}

	if _, err := probeCdp(cdpPort); err != nil {
		logMcp("warn CDP endpoint 127.0.0.1:%d not answering: %v", cdpPort, err)
	} else {
		logMcp("ok CDP endpoint 127.0.0.1:%d is live", cdpPort)
	}

	cmd := exec.Command(npx, chromeDevtoolsMcpPkg,
		fmt.Sprintf("--browserUrl=http://127.0.0.1:%d", cdpPort))
	cmd.Env = withGuiPath()
	// Own process group. `npx` spawns a THREE-level tree (npm exec -> the server ->
	// a telemetry watchdog); killing only cmd.Process reaps the npm wrapper and
	// leaves the real server orphaned, still holding a CDP connection to the session
	// browser. Signalling -pgid takes the whole tree, as pty.stop() does for claude.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	// Hold stdin OPEN. This is an stdio MCP server: with a closed stdin it sees EOF,
	// exits 0 immediately, and the probe would report a healthy server as a failure.
	// claude keeps the pipe open, so this makes the probe match real conditions.
	stdin, err := cmd.StdinPipe()
	if err != nil {
		logMcp("FAIL could not open stdin pipe: %v", err)
		return
	}
	defer stdin.Close()
	if err := cmd.Start(); err != nil {
		logMcp("FAIL could not spawn chrome-devtools-mcp: %v", err)
		return
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			// Exited 0 without being asked to. Not the expected shape for a long-lived
			// stdio server, but NOT an error either — don't cry wolf.
			logMcp("warn chrome-devtools-mcp exited cleanly (code 0) before %s", mcpProbeWait)
		} else {
			logMcp("FAIL chrome-devtools-mcp exited immediately: %v", err)
		}
		// This server writes a startup banner to stderr even when healthy, so label
		// it neutrally: on a real failure the cause is in these first lines, and npm's
		// output otherwise runs long enough to dominate the issue body it's embedded in.
		if s := strings.TrimSpace(stderr.String()); s != "" {
			logMcp("  output: %s", firstLines(s, 8))
		} else {
			logMcp("  (no output — likely a failed package fetch; check network/registry)")
		}
	case <-time.After(mcpProbeWait):
		logMcp("ok chrome-devtools-mcp stayed up past %s (healthy)", mcpProbeWait)
		killProcessGroup(cmd)
		<-done
	}
}

// killProcessGroup kills a Setpgid'd command's whole process tree. Falls back to the
// direct process if the pgid can't be resolved (the process already exited).
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return
	}
	_ = cmd.Process.Kill()
}

// mcpProbeWait is how long the probe waits for the MCP server to prove it survived
// startup. Long enough to cover a cold `npx` package fetch, short enough that it does
// not noticeably delay the session (it runs concurrently with claude spawning anyway).
const mcpProbeWait = 8 * time.Second

// probeCdp checks the session browser's CDP endpoint is answering, so the log can tell
// a dead MCP server apart from a dead browser — the report that motivated this logging
// confused the two, and the distinction decides who needs to fix what.
func probeCdp(port int) (string, error) {
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// diagLogTailBytes bounds how much of the log an issue report embeds — enough for
// several sessions, capped so a long-lived install can't bloat the issue body.
const diagLogTailBytes = 24 * 1024

// recentDiagLogMarkdown returns the tail of the diagnostic log as a fenced block for
// an issue report, or a note explaining an empty/absent log.
func recentDiagLogMarkdown() string {
	data, err := os.ReadFile(diagLogPath())
	if err != nil {
		return fmt.Sprintf("_(no diagnostic log at %s — nothing has been logged since this was added)_\n", diagLogPath())
	}
	if len(data) > diagLogTailBytes {
		// Drop the partial first line so the block starts at a real entry.
		data = data[len(data)-diagLogTailBytes:]
		if i := strings.IndexByte(string(data), '\n'); i >= 0 {
			data = data[i+1:]
		}
	}
	if strings.TrimSpace(string(data)) == "" {
		return "_(diagnostic log is empty)_\n"
	}
	return "```\n" + strings.TrimSpace(string(data)) + "\n```\n"
}

// JiraCfg is the per-user Jira MCP config (from the settings files). Token empty
// means "not configured" — the Jira server is then omitted from the MCP config.
type JiraCfg struct {
	URL      string
	Username string
	Token    string
}

// writeValidationMcpConfig writes the per-session MCP config for a Validation
// session: the same chrome-devtools server as writeSessionMcpConfig (so Claude
// drives the shared browser), PLUS a stdio jira-atlassian server (uvx mcp-atlassian)
// when a Jira token is configured. The Jira server reads the site/user/token from
// its env; ENABLED_TOOLS scopes it to the read + comment + attach tools the
// qa-validate skill uses. Returns the temp file path; the caller removes it at
// session teardown. NOTE: the file contains the token in plaintext (0600 from
// CreateTemp, removed at teardown).
func writeValidationMcpConfig(cdpPort int, jira JiraCfg) (string, error) {
	servers := map[string]any{
		"chrome-devtools": map[string]any{
			"command": "npx",
			"args": []string{
				chromeDevtoolsMcpPkg,
				fmt.Sprintf("--browserUrl=http://127.0.0.1:%d", cdpPort),
			},
		},
	}
	if strings.TrimSpace(jira.Token) != "" {
		servers["jira-atlassian"] = map[string]any{
			"command": "uvx",
			"args":    []string{"mcp-atlassian"},
			"env": map[string]string{
				"JIRA_URL":       jira.URL,
				"JIRA_USERNAME":  jira.Username,
				"JIRA_API_TOKEN": jira.Token,
				"ENABLED_TOOLS": "jira_get_issue,jira_search,jira_get_project_issues," +
					"jira_add_comment,jira_update_issue,jira_transition_issue,jira_get_transitions",
			},
		}
	}
	data, err := json.MarshalIndent(map[string]any{"mcpServers": servers}, "", "  ")
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp("", "qar-validate-mcp-*.json")
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return "", err
	}
	return f.Name(), nil
}

// devSourceRepo finds the live engine source tree (the dir containing bin/qar.ts)
// for the `wails dev` fallback, searching upward from the working dir and the
// executable. Returns "" if not found (e.g. a real packaged app).
func devSourceRepo() string {
	starts := []string{}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, start := range starts {
		dir := start
		for i := 0; i < 6; i++ { // walk up a few levels
			if _, err := os.Stat(filepath.Join(dir, "bin", "qar.ts")); err == nil {
				return dir
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

// qarBinValue is the single source of truth for how the `bin/qar` shim runs the
// bundled engine in a packaged .app: the node binary and the bundle path, as TWO
// values (QAR_NODE / QAR_BUNDLE) rather than one command string.
//
// They must stay separate because the .app path contains spaces
// ("/Applications/SI QA Runner.app/..."). A single packed string forces the shim to
// choose between word-splitting it — which shatters that path at the space and
// 127s — and quoting it, which makes the whole thing one unfindable "command".
// Two values need no quoting decision at all: each is exactly one word to the shim.
//
// Exported to the engine subprocess (engineCmd) and to the Claude PTY env
// (withGuiPath), where the shim consumes them so a bare `qar …` works. Under
// `wails dev` there is no Resources bundle, so both are "" and the shim falls back
// to `pnpm qar`.
func qarBinValue() (node, bundle string) {
	return qarBinValueIn(resourcesDir())
}

// qarBinValueIn is qarBinValue for an explicit Resources dir, so the spaced-path
// behavior is testable without a real .app on disk.
func qarBinValueIn(res string) (node, bundle string) {
	if res == "" {
		return "", ""
	}
	return filepath.Join(res, "runtime", "node"), filepath.Join(res, "engine", "qar.bundle.mjs")
}

// qarBinEnv returns the QAR_NODE/QAR_BUNDLE env entries for a packaged app, or nil
// under `wails dev`.
func qarBinEnv() []string {
	return qarBinEnvIn(resourcesDir())
}

func qarBinEnvIn(res string) []string {
	node, bundle := qarBinValueIn(res)
	if node == "" {
		return nil
	}
	return []string{"QAR_NODE=" + node, "QAR_BUNDLE=" + bundle}
}

// engineCmd builds the command that runs the bundled engine with the given qar
// args. In a packaged .app it runs the shipped node against qar.bundle.mjs; under
// `wails dev` (no Resources) it falls back to `pnpm qar` from the cloned repo so
// development still works. cmd.Dir and QAR_REPO_DIR both point at the clone.
func engineCmd(args ...string) *exec.Cmd {
	res := resourcesDir()
	var cmd *exec.Cmd
	if res != "" {
		node := filepath.Join(res, "runtime", "node")
		bundle := filepath.Join(res, "engine", "qar.bundle.mjs")
		// --import tsx lets plain node import the clone's .ts suites directly (no
		// compile step). tsx ships in Resources/engine/node_modules alongside Playwright.
		nodeArgs := append([]string{"--import", "tsx", bundle}, args...)
		cmd = exec.Command(node, nodeArgs...)
		// Suites in the clone import bare deps (@faker-js/faker, @playwright/test).
		// NODE_PATH does NOT satisfy ESM bare-specifier resolution — Node walks up
		// node_modules from the importing .ts file — so without a node_modules in the
		// clone those suites fail to import and silently vanish from the list. Symlink
		// the clone's node_modules to the bundled one so resolution finds them.
		ensureSuiteDeps(res)
		// Playwright is shipped under Resources/engine/node_modules; let the bundle
		// resolve it. PLAYWRIGHT_SKIP... avoids any download attempt at runtime.
		env := withGuiPath()
		env = append(env,
			"NODE_PATH="+filepath.Join(res, "engine", "node_modules"),
			"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
		)
		env = append(env, qarBinEnv()...)
		cmd.Env = env
	} else {
		// Dev: run `pnpm qar` from the LIVE engine source (the tree containing
		// bin/qar.ts), not repoDir() — repoDir() may be an older clone missing
		// new commands. QAR_REPO_DIR (in withGuiPath) still points config/suites
		// at the clone. Fall back to repoDir() if the source tree isn't found.
		cmd = exec.Command(guiResolve("pnpm"), append([]string{"qar"}, args...)...)
		cmd.Env = withGuiPath()
		if src := devSourceRepo(); src != "" {
			cmd.Dir = src
			return cmd
		}
	}
	cmd.Dir = repoDir()
	return cmd
}

// preflightMissing returns the tools the FIRST-LAUNCH SETUP step needs but that
// are NOT available, so the setup gate can show a blocking banner. Setup only
// clones the repo (via `gh`, falling back to `git clone`), so only those two are
// required here — `claude` and Chrome are needed later (authoring/running suites)
// and are validated by the Setup Doctor, not gated at setup.
func preflightMissing() []string {
	// Non-nil so Wails marshals it to a JSON array ([]), not null — the frontend
	// relies on .length being defined even when nothing is missing.
	missing := []string{}
	for _, tool := range []string{"gh", "git"} {
		if !toolOnPath(tool) {
			missing = append(missing, tool)
		}
	}
	return missing
}

// toolOnPath resolves a binary against the GUI-augmented PATH (the same PATH used
// for spawns), so a Finder-launched app finds Homebrew tools.
func toolOnPath(tool string) bool {
	cmd := exec.Command("/usr/bin/which", tool)
	cmd.Env = withGuiPath()
	return cmd.Run() == nil
}

func chromeInstalled() bool {
	return chromePath() != ""
}

// chromePath returns the path to the installed Google Chrome .app bundle, or ""
// if it isn't in either standard location. Chrome is found by its bundle, not on
// PATH — the debug report surfaces the matched path so a "not found" is obvious.
func chromePath() string {
	for _, p := range []string{
		"/Applications/Google Chrome.app",
		filepath.Join(os.Getenv("HOME"), "Applications", "Google Chrome.app"),
	} {
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			return p
		}
	}
	return ""
}

// cloneRepo clones the qa-review repo into repoDir() via `gh repo clone` (falling
// back to `git clone` of the https URL). Returns combined output. No-op if already
// cloned. The compiled-suites step is the caller's responsibility (Setup).
func cloneRepo() (string, error) {
	if repoReady() {
		return "already cloned", nil
	}
	dir := repoDir()
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return "", err
	}
	cmd := exec.Command(guiResolve("gh"), "repo", "clone", qaReviewSlug, dir)
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Fallback to plain git clone over https.
		url := fmt.Sprintf("https://github.com/%s.git", qaReviewSlug)
		cmd = exec.Command(guiResolve("git"), "clone", url, dir)
		cmd.Env = withGuiPath()
		out2, err2 := cmd.CombinedOutput()
		if err2 != nil {
			return string(out) + "\n" + string(out2), fmt.Errorf("clone failed: %w", err2)
		}
		return string(out2), nil
	}
	return string(out), nil
}

// ensureSuiteDeps makes the bundled node_modules (Resources/engine/node_modules —
// faker, @playwright/test, etc.) resolvable from the clone's suite files by
// symlinking <clone>/node_modules to it. Required because the suites are ESM .ts
// imported from the clone, and ESM bare-specifier resolution walks up node_modules
// from the importing file — it ignores NODE_PATH. Idempotent and best-effort: a
// failure here just means some suites won't load, which surfaces in the list.
func ensureSuiteDeps(res string) {
	bundleModules := filepath.Join(res, "engine", "node_modules")
	if _, err := os.Stat(bundleModules); err != nil {
		return // no bundled modules (e.g. odd build) — nothing to link
	}
	link := filepath.Join(repoDir(), "node_modules")
	// If it already points at the bundle, we're done.
	if target, err := os.Readlink(link); err == nil && target == bundleModules {
		return
	}
	// Replace a stale symlink; leave a real node_modules (dev-style clone) alone.
	if fi, err := os.Lstat(link); err == nil {
		if fi.Mode()&os.ModeSymlink != 0 {
			os.Remove(link)
		} else {
			return
		}
	}
	if os.Symlink(bundleModules, link) == nil {
		// The repo's .gitignore has "node_modules/" (dir-only); our symlink is a
		// file entry, so it would show as untracked and make Sync see a dirty tree
		// and skip. Exclude it locally (per-clone, no commit) to keep sync working.
		ensureLocalExclude(repoDir(), "node_modules")
	}
}

// ensureLocalExclude appends a pattern to .git/info/exclude if not already present
// — a per-clone gitignore that never touches the committed .gitignore.
func ensureLocalExclude(repo, pattern string) {
	exclude := filepath.Join(repo, ".git", "info", "exclude")
	if data, err := os.ReadFile(exclude); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == pattern {
				return
			}
		}
	}
	f, err := os.OpenFile(exclude, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(pattern + "\n")
}

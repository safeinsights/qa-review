package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
					"chrome-devtools-mcp@latest",
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
		// Playwright is shipped under Resources/engine/node_modules; let the bundle
		// resolve it. PLAYWRIGHT_SKIP... avoids any download attempt at runtime.
		env := withGuiPath()
		env = append(env,
			"NODE_PATH="+filepath.Join(res, "engine", "node_modules"),
			"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
			"QAR_BIN="+node+" --import tsx "+bundle,
		)
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

// preflightMissing returns the list of required external tools/apps that are NOT
// available, so the UI can show a blocking banner. Staff must have these installed.
func preflightMissing() []string {
	// Non-nil so Wails marshals it to a JSON array ([]), not null — the frontend
	// relies on .length being defined even when nothing is missing.
	missing := []string{}
	for _, tool := range []string{"git", "gh", "claude"} {
		if !toolOnPath(tool) {
			missing = append(missing, tool)
		}
	}
	if !chromeInstalled() {
		missing = append(missing, "Google Chrome")
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
	for _, p := range []string{
		"/Applications/Google Chrome.app",
		filepath.Join(os.Getenv("HOME"), "Applications", "Google Chrome.app"),
	} {
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			return true
		}
	}
	return false
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

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The Release tab: plan + run sessions over the shared PTY/browser, and the plan
// file the GUI editor and the Claude session both write.

var releaseTagRE = regexp.MustCompile(`^[\w.-]+$`)

// releaseDir mirrors the engine's tag check: "." and ".." match the pattern but
// would escape the release directory.
func releaseDir(tag string) (string, error) {
	if !releaseTagRE.MatchString(tag) || tag == "." || tag == ".." {
		return "", fmt.Errorf("%q is not a release tag", tag)
	}
	return filepath.Join(repoDir(), ".tmp", "release", tag), nil
}

func planHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

type PlanFile struct {
	Text   string `json:"text"`
	Hash   string `json:"hash"`
	Exists bool   `json:"exists"`
}

func (a *App) ReadPlan(tag string) (PlanFile, error) {
	dir, err := releaseDir(tag)
	if err != nil {
		return PlanFile{}, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "plan.md"))
	if errors.Is(err, os.ErrNotExist) {
		return PlanFile{}, nil
	}
	if err != nil {
		return PlanFile{}, err
	}
	return PlanFile{Text: string(data), Hash: planHash(string(data)), Exists: true}, nil
}

// WritePlan is the editor's autosave. Atomic (tmp + rename) so the session's
// re-read never sees a half-written file. Returns the hash so the editor can
// recognise its own write when it comes back as a plan-changed event.
func (a *App) WritePlan(tag, text string) (string, error) {
	dir, err := releaseDir(tag)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	// A unique temp file, so overlapping autosaves cannot truncate each other's.
	f, err := os.CreateTemp(dir, "plan.md.*.tmp")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	_, werr := f.WriteString(text)
	cerr := f.Close()
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "plan.md")); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return planHash(text), nil
}

func (a *App) ListReleases() ([]string, error) {
	out, err := runToolFull(qarShim(), "release-list")
	if err != nil {
		return nil, fmt.Errorf("release-list: %s", failureText(out, err))
	}
	var v struct {
		Releases []string `json:"releases"`
	}
	if err := json.Unmarshal([]byte(lastLine(out)), &v); err != nil {
		return nil, err
	}
	return v.Releases, nil
}

// ReleaseStatus returns the engine's JSON verbatim; the UI parses it.
func (a *App) ReleaseStatus(tag string) (string, error) {
	if _, err := releaseDir(tag); err != nil {
		return "", err
	}
	out, err := runToolFull(qarShim(), "release-status", "--tag", tag)
	if err != nil {
		return "", fmt.Errorf("release-status: %s", failureText(out, err))
	}
	return lastLine(out), nil
}

// PlanLinesCheck runs `qar plan-lines` on the local plan for the editor's status
// row. A failing parse is a RESULT, not an error: the problems are what the row
// shows. Only a failure to run the engine at all is returned as an error.
type PlanLinesCheck struct {
	OK      bool   `json:"ok"`
	Summary string `json:"summary"`
}

func (a *App) CheckPlanLines(tag string) (PlanLinesCheck, error) {
	dir, err := releaseDir(tag)
	if err != nil {
		return PlanLinesCheck{}, err
	}
	out, err := runToolFull(qarShim(), "plan-lines", "--input", filepath.Join(dir, "plan.md"), "--tag", tag)
	if err != nil {
		if strings.Contains(out, "plan-lines found") {
			return PlanLinesCheck{OK: false, Summary: planLinesProblems(out)}, nil
		}
		return PlanLinesCheck{}, fmt.Errorf("plan-lines: %s", failureText(out, err))
	}
	var v struct {
		Lines       int `json:"lines"`
		Security    int `json:"security"`
		StagingOnly int `json:"stagingOnly"`
	}
	if err := json.Unmarshal([]byte(lastLine(out)), &v); err != nil {
		return PlanLinesCheck{}, err
	}
	return PlanLinesCheck{
		OK:      true,
		Summary: fmt.Sprintf("%d lines · %d security · %d staging-only", v.Lines, v.Security, v.StagingOnly),
	}, nil
}

// failureText prefers the command's output, but a spawn failure (qar not found)
// has none, and the error is then the only cause there is.
func failureText(out string, err error) string {
	if out != "" {
		return out
	}
	return err.Error()
}

// planLinesProblems keeps only the "plan-lines found N problem(s)" block. Under the
// pnpm fallback the output is wrapped in a script header and an ELIFECYCLE trailer
// that mean nothing to the editor's status row.
func planLinesProblems(out string) string {
	i := strings.Index(out, "plan-lines found")
	if i < 0 {
		return strings.TrimSpace(out)
	}
	var kept []string
	for _, line := range strings.Split(out[i:], "\n") {
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, " ELIFECYCLE") || strings.HasPrefix(line, "ERR_PNPM") {
			break
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// DiscardLocalPlan replaces the local plan with the release asset. The asset has no
// Security section, so release-download --force splices the local one back in: the
// local plan is the only copy of it.
func (a *App) DiscardLocalPlan(tag string) error {
	if _, err := releaseDir(tag); err != nil {
		return err
	}
	// --force: release-download otherwise refuses to replace a plan with unsaved
	// edits, and replacing them is exactly what Discard asks for.
	out, err := runToolFull(qarShim(), "release-download", "--tag", tag, "--force")
	if err != nil {
		return fmt.Errorf("release-download: %s", failureText(out, err))
	}
	return nil
}

// lastLine is the JSON line a qar command prints; pnpm may print its own lines first.
func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return lines[len(lines)-1]
}

// qarShim is the committed bin/qar shim, which dispatches to the bundled engine or
// pnpm qar. withGuiPath() already puts <repo>/bin on PATH.
func qarShim() string { return "qar" }

// watchPlan polls plan.md and emits plan-changed when its hash moves. Polling, not
// fsnotify, as the verdict watcher does. Only the editor writes by rename: the
// engine's release-download copies over the file and Claude's Write truncates and
// writes it, so a tick can read a half-written file. That is tolerated, not
// prevented: the next tick hashes the finished file and emits again.
func (a *App) watchPlan(tag string) {
	stop := make(chan struct{})
	// Swap under one lock: separate stop-then-store sections let two overlapping
	// calls both see nil and orphan the first poller.
	a.sessionMu.Lock()
	old := a.stopPlanWatch
	a.stopPlanWatch = stop
	a.sessionMu.Unlock()
	if old != nil {
		close(old)
	}
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		last := ""
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				p, err := a.ReadPlan(tag)
				if err != nil || !p.Exists || p.Hash == last {
					continue
				}
				last = p.Hash
				runtime.EventsEmit(a.ctx, "plan-changed", map[string]any{"tag": tag, "hash": p.Hash})
			}
		}
	}()
}

func (a *App) stopPlanWatcher() {
	a.sessionMu.Lock()
	stop := a.stopPlanWatch
	a.stopPlanWatch = nil
	a.sessionMu.Unlock()
	if stop != nil {
		close(stop)
	}
}

// WatchPlan lets the tab watch a plan with no session live (a downloaded plan).
func (a *App) WatchPlan(tag string) error {
	if _, err := releaseDir(tag); err != nil {
		return err
	}
	a.watchPlan(tag)
	return nil
}

func (a *App) UnwatchPlan() { a.stopPlanWatcher() }

// startReleaseSavedWatch mirrors startVerdictWatch for the release-saved file.
func (a *App) startReleaseSavedWatch() {
	path := releaseSavedPath()
	_ = os.Remove(path)
	stop := make(chan struct{})
	a.sessionMu.Lock()
	old := a.stopReleaseSavedWatch
	a.stopReleaseSavedWatch = stop
	a.sessionMu.Unlock()
	if old != nil {
		close(old)
	}
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				data, err := os.ReadFile(path)
				if err != nil {
					continue
				}
				var v struct {
					Tag   string `json:"tag"`
					Asset string `json:"asset"`
					URL   string `json:"url"`
				}
				if json.Unmarshal(data, &v) == nil && v.Tag != "" {
					runtime.EventsEmit(a.ctx, "release-saved", map[string]any{
						"tag": v.Tag, "asset": v.Asset, "url": v.URL,
					})
				}
				// Consume it either way so a malformed file can't spin.
				_ = os.Remove(path)
			}
		}
	}()
}

func (a *App) stopReleaseSavedWatcher() {
	a.sessionMu.Lock()
	stop := a.stopReleaseSavedWatch
	a.stopReleaseSavedWatch = nil
	a.sessionMu.Unlock()
	if stop != nil {
		close(stop)
	}
}

// releaseDisallowedTools are denied outright in both release sessions. Under
// --permission-mode auto, a tool off the allowlist does not prompt the user: the
// auto-mode classifier decides, and it could approve a direct `gh release upload`
// of plan.md (Security section and all) or a Jira comment. A deny rule outranks
// both. The qar release-* and jira-create-issue commands still work: qar's own gh
// and Jira calls are child processes, not Bash tool calls.
func releaseDisallowedTools() []string {
	tools := []string{
		"Bash(gh release:*)",
		"Bash(gh api:*)",
		"Bash(gh pr merge:*)",
		"Bash(gh pr close:*)",
		"Bash(gh issue:*)",
	}
	for _, server := range knownJiraServers {
		for _, tool := range []string{"jira_add_comment", "jira_update_issue", "jira_transition_issue", "jira_create_issue"} {
			tools = append(tools, mcpToolName(server, tool))
		}
	}
	return tools
}

func releaseClaudeArgs(allowed []string, mcpPath string) []string {
	return []string{
		"--permission-mode", "auto",
		"--allowedTools", strings.Join(allowed, ","),
		"--disallowedTools", strings.Join(releaseDisallowedTools(), ","),
		"--add-dir", repoDir(),
		"--mcp-config", mcpPath,
	}
}

// startReleaseSession is the shared body of the two starters: browser, MCP config,
// claude with the session's own allowlist, watchers, opening prompt.
func (a *App) startReleaseSession(kind, env, openingPrompt string, allowed []string) (string, error) {
	token, cdpPort, err := a.startSessionBrowser(kind, env, "")
	if err != nil {
		return "", err
	}
	jiraCfg := a.readJiraConfig()
	mcpPath, err := writeValidationMcpConfig(cdpPort, jiraCfg)
	if err != nil {
		a.StopSession()
		return "", err
	}
	a.sessionMu.Lock()
	a.sessionMcpPath = mcpPath
	a.sessionMu.Unlock()
	go probeMcpServers(cdpPort, jiraCfg)
	if err := a.pty.start(a, repoDir(), withGuiPath(), releaseClaudeArgs(allowed, mcpPath)); err != nil {
		a.StopSession()
		return "", err
	}
	a.startReleaseSavedWatch()
	go a.submitOpeningMessage(openingPrompt)
	return token, nil
}

// releasePlanOpening picks the plan session's opening prompt. Only an existing plan
// gets the edit prompt: with no plan.md (a session that died while generating), the
// edit prompt would run plan-lines on a missing file, while the generation prompt
// reuses every pr-<n>.json already written.
func releasePlanOpening(tag string, regenerate, planExists bool) string {
	if regenerate || !planExists {
		return composeReleasePlanPrompt(tag)
	}
	return composeReleasePlanEditPrompt(tag)
}

// StartReleasePlanSession opens the plan session. regenerate=false keeps an
// existing plan (a downloaded one) and only gives the user a live Claude to save it.
func (a *App) StartReleasePlanSession(tag string, regenerate bool) (string, error) {
	dir, err := releaseDir(tag)
	if err != nil {
		return "", err
	}
	_, statErr := os.Stat(filepath.Join(dir, "plan.md"))
	// The plan session reads PRs, not the app; staging is a harmless target for
	// the browser the shared session machinery always launches.
	opening := releasePlanOpening(tag, regenerate, statErr == nil)
	token, err := a.startReleaseSession("release-plan", "staging", opening, releasePlanAllowedTools)
	if err != nil {
		return "", err
	}
	a.watchPlan(tag)
	return token, nil
}

func (a *App) StartReleaseRunSession(tag, env string) (string, error) {
	if _, err := releaseDir(tag); err != nil {
		return "", err
	}
	if env != "staging" && env != "production" {
		return "", errors.New("a release runs against staging or production")
	}
	return a.startReleaseSession("release-run", env, composeReleaseRunPrompt(tag, env), releaseRunAllowedTools)
}

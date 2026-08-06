package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// guiPathDirs are dirs a Finder-launched macOS app is typically MISSING from its
// PATH (GUI apps inherit a minimal /usr/bin:/bin). We prepend these so tools like
// pnpm (/usr/local/bin) and claude/git/gh (/opt/homebrew/bin) resolve. Harmless
// when launched from a terminal (already on PATH).
var guiPathDirs = []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"}

// guiPathDirsWithHome prepends the user-local install dirs (~/.local/bin, ~/bin)
// to guiPathDirs. Tools like claude are commonly installed there (e.g. the native
// installer drops it in ~/.local/bin), which a Finder-launched app would otherwise
// never search. Home-relative so it can't be a package-level literal.
func guiPathDirsWithHome() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return guiPathDirs
	}
	return append([]string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, "bin"),
	}, guiPathDirs...)
}

// withGuiPath returns a copy of the current environment with guiPathDirs ensured
// on PATH, so exec.Command can find dev tools regardless of how the app launched.
func withGuiPath() []string {
	env := os.Environ()
	// Put guiPathDirs at the FRONT in their declared order. The old loop prepended
	// each missing dir one at a time, so every prepend pushed the previous one back —
	// REVERSING the list. A Finder-launched app inherits neither /opt/homebrew/bin nor
	// /usr/local/bin, so both were prepended and Homebrew (declared FIRST, meaning
	// highest priority) ended up LAST among them. On the machine in issue #36 that put
	// Node 21.1.0 from /usr/local/bin ahead of Node 26 from Homebrew, and npx crashed
	// chrome-devtools-mcp at import on every session. Order here IS which tool wins.
	path := prependPathDirs(os.Getenv("PATH"), guiPathDirsWithHome())
	// Prepend the repo's bin dir so a bare `qar` resolves to the committed shim
	// (bin/qar), which dispatches to QAR_NODE/QAR_BUNDLE (packaged) or `pnpm qar` (dev). This is
	// what makes the skills' bare-`qar` commands and the `Bash(qar:*)` allowlist real.
	if binDir := filepath.Join(repoDir(), "bin"); !strings.Contains(path, binDir) {
		path = binDir + ":" + path
	}
	out := make([]string, 0, len(env))
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") || strings.HasPrefix(e, "QAR_REPO_DIR=") {
			continue
		}
		// Drop any inherited QAR_NODE/QAR_BUNDLE too. qarBinEnv() appends these only
		// in a packaged app, but QAR_REPO_DIR is appended unconditionally — so without
		// this an inherited pair could survive into a dev child (pointing at a stale or
		// absent .app), and the two halves of the shim's contract would disagree.
		if strings.HasPrefix(e, "QAR_NODE=") || strings.HasPrefix(e, "QAR_BUNDLE=") {
			continue
		}
		// Strip CLAUDE_CODE_* markers so a `claude` we spawn in the PTY starts a
		// FRESH session. Otherwise, if the GUI itself was launched from within a
		// Claude Code session (dev), the child claude inherits CLAUDE_CODE_CHILD_SESSION
		// and disables its own transcript saving ("Transcript saving is off").
		if strings.HasPrefix(e, "CLAUDE_CODE_") {
			continue
		}
		// Drop inherited terminal-capability vars; we set our own below. NO_COLOR is
		// dropped too — it overrides TERM entirely, so a user who exports it for their
		// shell would otherwise get a monochrome embedded terminal with no way to tell
		// why. The xterm we render into is always color-capable regardless.
		if strings.HasPrefix(e, "TERM=") || strings.HasPrefix(e, "COLORTERM=") ||
			strings.HasPrefix(e, "NO_COLOR=") {
			continue
		}
		out = append(out, e)
	}
	// Tell the bundled engine where the cloned repo (config/, suites, secrets) lives,
	// and export QAR_NODE/QAR_BUNDLE (packaged only) so the `bin/qar` shim — and thus a
	// bare `qar` in the Claude PTY — runs the bundled engine where there is no `pnpm`.
	out = append(out, "PATH="+path, "QAR_REPO_DIR="+repoDir())
	// Declare the terminal we actually render into. A Finder-launched .app inherits
	// NO TERM (launchd sets none, only a shell does), so `claude` saw a terminal with
	// no declared capabilities and emitted plain text — the embedded xterm rendered
	// black-and-white. Under `wails dev` the launching shell's TERM leaked in, which
	// is why this only ever reproduced in the packaged app. Setting it unconditionally
	// (paired with the strip above) makes dev and packaged behave identically instead
	// of depending on how the app happened to be started.
	//
	// xterm.js implements xterm-256color and supports truecolor SGR, so both values
	// describe the real frontend rather than overstating it.
	out = append(out, "TERM=xterm-256color", "COLORTERM=truecolor")
	out = append(out, qarBinEnv()...)
	return out
}

// prependPathDirs returns `path` with `dirs` moved to the front in their given
// order, de-duplicated. Building the result in one pass is what preserves the order;
// prepending dirs one at a time reverses them. Entries already on `path` are
// RELOCATED rather than skipped, so the ranking holds however the app was launched.
func prependPathDirs(path string, dirs []string) string {
	seen := make(map[string]bool, len(dirs))
	out := make([]string, 0, len(dirs)+8)
	for _, d := range dirs {
		if d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	for _, d := range filepath.SplitList(path) {
		if d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return strings.Join(out, string(filepath.ListSeparator))
}

// guiPath extracts the PATH value from a withGuiPath() env slice.
func guiPath(env []string) string {
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			return strings.TrimPrefix(e, "PATH=")
		}
	}
	return os.Getenv("PATH")
}

// guiResolve turns a bare command name into an absolute path resolved against the
// GUI-augmented PATH. This is REQUIRED for any tool that lives only in Homebrew
// (/opt/homebrew/bin): exec.Command("gh") resolves the binary via exec.LookPath
// against the *parent process* PATH at Command()-time — NOT against cmd.Env — and a
// Finder-launched app's process PATH is just /usr/bin:/bin. So setting cmd.Env alone
// leaves the lookup broken and the command fails "not found" even though the child
// env's PATH is correct. Passing the absolute path sidesteps LookPath entirely.
// Returns the name unchanged if it can't be resolved (already absolute, or missing —
// let exec surface the real error).
func guiResolve(name string) string {
	if strings.ContainsRune(name, '/') {
		return name
	}
	for _, d := range filepath.SplitList(guiPath(withGuiPath())) {
		full := filepath.Join(d, name)
		if info, err := os.Stat(full); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return full
		}
	}
	// Unresolved: we return the bare name, so the caller fails later with a generic
	// "executable file not found" that names no search path. Record what we searched —
	// for a Finder-launched app the answer is usually that the tool lives somewhere
	// guiPathDirs doesn't cover (nvm/asdf/Volta).
	logDiag("path", "unresolved tool %q; searched PATH=%s", name, guiPath(withGuiPath()))
	return name
}

// appVersion is reported in issue reports. Override at build time with
// -ldflags "-X main.appVersion=<v>"; defaults to "dev" for local/wails-dev runs.
var appVersion = "dev"

type App struct {
	ctx context.Context
	// authoring session state (one at a time): the qar-session process, the live
	// CDP/screencast ports, the temp MCP config, and the claude PTY.
	sessionMu      sync.Mutex
	sessionCmd     *exec.Cmd
	sessionMcpPath string
	pty            ptySession
	// sessionToken identifies the CURRENTLY-active session (authoring or companion).
	// Both React tabs stay mounted and share the single PTY slot, so a STALE tab's
	// unmount teardown must not kill a LIVE session started by the other tab. Each
	// start mints a new token (via sessionSeq) and returns it; the frontend-triggered
	// teardown (StopSessionIfOwner) only proceeds if the caller still owns this token.
	sessionToken string
	sessionSeq   int
	// stopVerdictWatch stops the validation session's verdict-file poller (which
	// emits "verdict-posted" when Claude records a verdict). Closed on teardown.
	stopVerdictWatch chan struct{}
	// the in-flight Suites/engine run (one at a time), so StopRun can kill it.
	runMu  sync.Mutex
	runCmd *exec.Cmd
	// stdin write-end of the in-flight run, so SendToRun can push pause/resume
	// control messages to the engine. Closed and nilled when the run exits.
	runStdin io.WriteCloser
}

func NewApp() *App {
	return &App{}
}

// newSessionToken mints a fresh, unique active-session token and installs it as
// the active one, under sessionMu. The monotonic counter makes it deterministic
// (no time/random). `prefix` is "authoring" or "companion" for legibility. Called
// when a session starts — the new token becomes active, so any prior owner's later
// StopSessionIfOwner(oldToken) is a correct no-op.
func (a *App) newSessionToken(prefix string) string {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()
	a.sessionSeq++
	a.sessionToken = fmt.Sprintf("%s-%d", prefix, a.sessionSeq)
	return a.sessionToken
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown runs when the app is quitting — tear down any live authoring session
// so we never orphan a Chrome (remote-debugging) or claude process.
//
// teardownSession() only SIGTERMs; the SIGKILL escalation runs in goroutines that
// fire seconds later (escalateKill, pty.stop). On quit the process exits first, so
// those never run and anything ignoring SIGTERM is orphaned — `npx` wrappers and
// the chrome-devtools-mcp telemetry watchdog are exactly that shape, and orphans
// pinned to long-dead CDP ports were observed accumulating on a real machine. Wait
// out the escalation window so the kills actually land before we exit.
func (a *App) shutdown(ctx context.Context) {
	// Capture the PIDs BEFORE teardown: it clears sessionCmd and closes the PTY
	// immediately, so app state stops being a usable signal the moment it returns.
	pids := a.sessionPids()
	a.StopSession()
	killGroupsNow(pids)
	logDiag("app", "shutdown complete (%d session group(s) reaped)", len(pids))
}

// sessionPids returns the PIDs of the live session processes (the engine/browser
// session and the claude PTY), each a process-group leader.
func (a *App) sessionPids() []int {
	var pids []int
	a.sessionMu.Lock()
	if a.sessionCmd != nil && a.sessionCmd.Process != nil {
		pids = append(pids, a.sessionCmd.Process.Pid)
	}
	a.sessionMu.Unlock()
	if pid := a.pty.pid(); pid != 0 {
		pids = append(pids, pid)
	}
	return pids
}

// killGroupsNow SIGKILLs each process group synchronously. teardownSession only
// SIGTERMs and defers the SIGKILL to goroutines (escalateKill, pty.stop) that fire
// seconds later — on quit the process exits first, so those never run and anything
// ignoring SIGTERM is orphaned. Sending the SIGKILL inline is what makes it land.
func killGroupsNow(pids []int) {
	if len(pids) == 0 {
		return
	}
	// A brief grace so a well-behaved child can finish its SIGTERM cleanup (Chrome
	// flushing its profile) before the group is killed outright.
	time.Sleep(300 * time.Millisecond)
	for _, pid := range pids {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}

// Preflight reports required external tools/apps that are missing, so the UI can
// show a blocking banner. Empty slice means all good.
func (a *App) Preflight() []string {
	return preflightMissing()
}

// IsRepoReady reports whether the qa-review repo has been cloned. The frontend
// shows a one-time "Set up tests" prompt when this is false.
func (a *App) IsRepoReady() bool {
	return repoReady()
}

// DefaultRepoDir is the suggested clone location shown in the setup UI.
func (a *App) DefaultRepoDir() string {
	return defaultRepoDir()
}

// ChooseDirectory opens a native folder picker so the user can choose where the
// repo is cloned. Returns the chosen absolute path, or "" if cancelled.
func (a *App) ChooseDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choose where to store the QA test repository",
	})
}

// Setup clones the qa-review repo into `dir` (or the default when empty), so the
// app becomes usable on first launch. The chosen location is persisted for future
// launches. Idempotent.
func (a *App) Setup(dir string) (string, error) {
	// gh/git clone requires the target dir to not already exist (or be empty).
	// Clone into <dir>/qa-review when the user picked a parent folder; if they
	// pointed at an empty/new dir, use it directly.
	target := strings.TrimSpace(dir)
	if target == "" {
		target = defaultRepoDir()
	} else if entries, err := os.ReadDir(target); err == nil && len(entries) > 0 {
		// Non-empty existing dir → clone into a child so we don't clobber it.
		target = filepath.Join(target, "qa-review")
	}
	if err := setRepoDir(target); err != nil {
		return "", err
	}
	out, err := cloneRepo()
	if err != nil {
		return out, err
	}
	return out, nil
}

// RunProcess spawns `program args...` in cwd, emitting "stdout-line" (string)
// for each stdout line and "proc-exit" (int exit code) when it finishes. Mirrors
// the previous Tauri run_process command. Runs the scan in a goroutine so the
// call returns immediately; the frontend drives the UI off the events.
func (a *App) RunProcess(program string, args []string, cwd string) error {
	cmd := exec.Command(program, args...)
	// cwd from the frontend is vestigial — spawns run in the cloned repo dir.
	cmd.Dir = repoDir()
	cmd.Env = withGuiPath()
	return a.streamCmd(cmd, program, true)
}

// RunEngine streams the bundled engine (`qar <args...>`) into the same
// stdout-line/proc-exit events as RunProcess. The engine path lives entirely in
// Go (engineCmd) so the frontend never has to know about node/pnpm/bundle paths.
func (a *App) RunEngine(args []string) error {
	cmd := engineCmd(args...)
	return a.streamCmd(cmd, "qar "+strings.Join(redactArgs(args), " "), isTrackedRun(args))
}

// redactArgs masks the value following a secret-bearing flag. The engine CLI takes
// `--value <secret>` (set-secret), and the label built here is written to the
// diagnostic log and embedded in issue reports — neither should ever carry a secret.
// The GUI currently writes secrets through Go rather than this path, but RunEngine
// takes arbitrary args from the frontend, so redact rather than depend on that.
func redactArgs(args []string) []string {
	out := make([]string, len(args))
	copy(out, args)
	for i := 0; i < len(out)-1; i++ {
		switch out[i] {
		case "--value", "--password", "--token", "--api-token":
			out[i+1] = "***"
		}
	}
	return out
}

// maxStrayLines caps the non-JSON engine output retained per run for the diagnostic
// log. A crash says why in its first few lines; a chatty successful run must not
// flood the log.
const maxStrayLines = 40

// isTrackedRun reports whether an engine invocation is THE stoppable, one-at-a-time
// run. `list` (and any other read-only query the UI fires on mount) must NOT be
// tracked — otherwise a tab remount's list fetch would kill an in-flight run and
// confuse StopRun. Only `run` is tracked.
func isTrackedRun(args []string) bool {
	return len(args) == 0 || args[0] != "list"
}

// authoringAllowedTools is the SCOPED pre-approval set for the interactive
// authoring session — the browser MCP tools, qar (login/cleanup/run), and file
// authoring under src/suites. We do NOT use --dangerously-skip-permissions:
// claude runs in a real PTY, so anything OUTSIDE this allowlist (e.g. arbitrary
// shell, git push) still prompts the user LIVE in the terminal. The allowlist
// just keeps routine, safe operations from spamming prompts.
// NOTE: Bash matching keys on the command prefix, so a compound like
// `cd /path && pnpm qar ...` does NOT match `Bash(pnpm qar:*)`. The qa-explore
// skill is therefore told to NOT prefix commands with `cd` (claude already runs
// IN the repo dir) and to keep each Bash call to a single command, so these
// prefixes match and the routine, safe operations don't spam permission prompts.
// Anything outside this set (arbitrary shell, git push, rm, …) still prompts live.
var authoringAllowedTools = []string{
	"mcp__chrome-devtools",
	"Bash(pnpm qar:*)",
	"Bash(qar:*)",
	"Bash(pnpm typecheck:*)",
	"Bash(pnpm test:*)",
	// Safe, read-only shell helpers the skill uses to set up the run bundle and
	// read command output. Each is harmless on its own.
	"Bash(mkdir:*)",
	"Bash(ls:*)",
	"Bash(cat:*)",
	"Bash(date:*)",
	"Bash(echo:*)",
	"Read",
	"Write",
	"Edit",
}

// validationAllowedTools is the scoped pre-approval set for the Validation session.
// Claude drives the shared browser (chrome-devtools MCP), reads the ticket + posts
// findings (jira-atlassian MCP), finds the PR (gh), and uses qar helpers (login,
// mail-inbox/mail-wait/totp for signup flows). Same file/shell surface as authoring.
var validationAllowedTools = []string{
	"mcp__chrome-devtools",
	"mcp__jira-atlassian",
	"Bash(gh:*)",
	"Bash(pnpm qar:*)",
	"Bash(qar:*)",
	"Bash(pnpm typecheck:*)",
	"Bash(pnpm test:*)",
	"Bash(mkdir:*)",
	"Bash(ls:*)",
	"Bash(cat:*)",
	"Bash(date:*)",
	"Bash(echo:*)",
	"Read",
	"Write",
	"Edit",
}

// StartAuthoringSession boots an interactive "author a suite" session:
//  1. start `qar session --role <r> (--env|--pr)`, wait for its ready line
//     (cdpPort + screencastPort) — this GATES claude start (no race),
//  2. write a per-session MCP config pointing chrome-devtools-mcp at that CDP port,
//  3. emit "session-ready" {screencastPort} so the GUI shows the live browser,
//  4. spawn claude in a PTY pointed at that shared browser, and send the initial
//     instruction as claude's first input.
//
// One session at a time: starting a new one stops the old.
func (a *App) StartAuthoringSession(env, pr, role, instruction string) (string, error) {
	token, cdpPort, err := a.startSessionBrowser("authoring", env, pr)
	if err != nil {
		return "", err
	}

	mcpPath, err := writeSessionMcpConfig(cdpPort)
	if err != nil {
		a.StopSession()
		return "", err
	}
	a.sessionMu.Lock()
	a.sessionMcpPath = mcpPath
	a.sessionMu.Unlock()
	logMcp("authoring session: config=%s", mcpPath)
	go probeMcpServers(cdpPort)

	claudeArgs := []string{
		"--permission-mode", "default",
		"--allowedTools", strings.Join(authoringAllowedTools, ","),
		"--add-dir", repoDir(),
		"--mcp-config", mcpPath,
	}
	if err := a.pty.start(a, repoDir(), withGuiPath(), claudeArgs); err != nil {
		a.StopSession()
		return "", err
	}
	go func() {
		time.Sleep(2 * time.Second)
		_ = a.submitToPty(composeAuthoringPrompt(env, pr, role, instruction))
	}()
	return token, nil
}

// startSessionBrowser evicts any live session, spawns `qar session (--env|--pr)`
// (login deferred — the browser starts logged out), and waits for its ready line
// carrying the CDP + screencast ports. It emits "session-ready" {screencastPort}
// so the GUI shows the live browser, and returns the fresh session token + CDP
// port so the caller can write a per-session MCP config and spawn claude. Shared
// by the authoring and validation sessions (they differ only in MCP config +
// prompt); `tokenPrefix` labels the session ("authoring"/"validation").
func (a *App) startSessionBrowser(tokenPrefix, env, pr string) (string, int, error) {
	// Evict any live session (companion or a prior one). If it actually tore
	// something down, tell the GUI so the OTHER tab (which shares the single PTY
	// slot) resets to idle instead of showing a live session over a dead PTY. The
	// new session we start below immediately re-announces itself (session-ready /
	// a fresh token), so there's no self-teardown.
	if a.teardownSession() {
		runtime.EventsEmit(a.ctx, "session-ended")
	}
	// Mint the active token AFTER the eviction so any prior session's owner no
	// longer holds the active token (their later StopSessionIfOwner is a no-op).
	token := a.newSessionToken(tokenPrefix)

	args := []string{"session"}
	if strings.TrimSpace(pr) != "" {
		args = append(args, "--pr", pr)
	} else {
		args = append(args, "--env", env)
	}
	cmd := engineCmd(args...)
	// Own process group so teardown can kill the WHOLE tree (pnpm → tsx → node →
	// Chrome), not just the top wrapper. In dev the session is spawned via `pnpm qar`,
	// and pnpm does NOT forward SIGTERM to its child — so signalling only cmd.Process
	// left the real `qar session` (+ its Chrome) orphaned, holding the session lock so
	// every later session start failed with "Another qar session is already running".
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", 0, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		a.emitSpawnFailure("qar session", err)
		return "", 0, err
	}
	a.sessionMu.Lock()
	a.sessionCmd = cmd
	a.sessionMu.Unlock()

	// Wait for the session ready line (cdpPort + screencastPort) with a timeout.
	type sessionInfo struct {
		Type           string `json:"type"`
		CdpPort        int    `json:"cdpPort"`
		ScreencastPort int    `json:"screencastPort"`
	}
	ready := make(chan sessionInfo, 1)
	var lastOutput strings.Builder
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		sent := false
		for scanner.Scan() {
			line := scanner.Text()
			if !sent {
				var info sessionInfo
				if json.Unmarshal([]byte(line), &info) == nil && info.Type == "session" {
					ready <- info
					sent = true
					continue
				}
			}
			lastOutput.WriteString(line + "\n")
			// Surface any other engine output (login errors etc.) to the terminal.
			runtime.EventsEmit(a.ctx, "session-log", line)
		}
	}()

	// Fail fast if the engine process exits before emitting the ready line (e.g.
	// a stale repo without the `session` command) — don't wait out the timeout.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	var info sessionInfo
	select {
	case info = <-ready:
	case err := <-exited:
		a.teardownSession()
		out := strings.TrimSpace(lastOutput.String())
		if out == "" {
			out = fmt.Sprintf("the engine exited (%v) before the browser was ready", err)
		}
		return "", 0, fmt.Errorf("could not start the session:\n%s", out)
	case <-time.After(90 * time.Second):
		a.teardownSession()
		return "", 0, fmt.Errorf("timed out waiting for the browser session to start")
	}

	// Include the session KIND ("authoring"/"validation"/"companion") so each tab can
	// tell whether the live session is its OWN or the OTHER tab's — the two tabs share
	// one PTY + browser, so a tab that isn't the owner shows an "unavailable" state
	// instead of mirroring the other tab's session.
	runtime.EventsEmit(a.ctx, "session-ready", map[string]any{
		"kind":           tokenPrefix,
		"screencastPort": info.ScreencastPort,
	})
	return token, info.CdpPort, nil
}

// ValidationStart is what StartValidationSession hands back: the session token
// plus the Jira card the session is actually about. The card matters to the
// caller because it may have been INFERRED from the PR (the tester gave only a PR
// number) — the GUI needs the resolved key to enable the Verdict button and to
// match the "verdict-posted" event. Empty means "unknown, Claude will work it out".
type ValidationStart struct {
	Token    string `json:"token"`
	JiraCard string `json:"jiraCard"`
}

// StartValidationSession boots a "validate a Jira ticket" session: the same shared
// logged-out browser as authoring, but the MCP config ALSO carries the Jira
// (uvx mcp-atlassian) server, and the opening prompt invokes qa-validate. Claude
// reads the ticket + PR, logs in via `qar session-login`, drives the shared browser
// via chrome-devtools MCP to check the acceptance criteria, and posts the verdict.
//
// Either `pr` or `jiraCard` is required (the UI enforces it too). Given only a PR,
// we infer the card from it up front so the Verdict button works for the whole
// session; if inference fails the session still starts and the prompt asks Claude
// to identify the ticket from the PR.
//
// With a PR, the deployment checks must be green first — see the ciContextPrefix
// gate below. `force` skips that gate for a tester who has read the warning and
// wants to proceed anyway.
func (a *App) StartValidationSession(env, pr, jiraCard, instructions string, force bool) (ValidationStart, error) {
	if strings.TrimSpace(pr) == "" && strings.TrimSpace(jiraCard) == "" {
		return ValidationStart{}, errors.New("a PR number or a Jira card is required")
	}
	// Gate BEFORE spawning anything: validating against a preview URL that CI hasn't
	// finished building tests the previous commit (or 404s), and a green-looking pass
	// on stale code is worse than no validation at all. Re-checked here rather than
	// trusting the UI's probe because the state can change between the two, and
	// because a session can be started by a caller that never probed.
	if !force {
		if status := prCIStatus(pr); status.Blocking() {
			return ValidationStart{}, errors.New(status.Warning)
		}
	}
	// Infer BEFORE spawning the browser: a failed lookup is then just a missing
	// card, not an orphaned session we'd have to tear down.
	if strings.TrimSpace(jiraCard) == "" {
		jiraCard = inferJiraCard(pr)
	}

	token, cdpPort, err := a.startSessionBrowser("validation", env, pr)
	if err != nil {
		return ValidationStart{}, err
	}

	jiraCfg := a.readJiraConfig()
	mcpPath, err := writeValidationMcpConfig(cdpPort, jiraCfg)
	if err != nil {
		a.StopSession()
		return ValidationStart{}, err
	}
	a.sessionMu.Lock()
	a.sessionMcpPath = mcpPath
	a.sessionMu.Unlock()
	// Whether the Jira server is even present is a separate invisible failure: no token
	// means no jira-atlassian server, which surfaces only as missing mcp__jira__* tools.
	logMcp("validation session: config=%s jiraConfigured=%t", mcpPath, strings.TrimSpace(jiraCfg.Token) != "")
	go probeMcpServers(cdpPort)

	claudeArgs := []string{
		// acceptEdits: routine file reads/notes flow without prompts, but Jira MCP
		// writes (comments/transitions/un-assign) and non-allowlisted Bash still
		// prompt live in the terminal for a human gate.
		"--permission-mode", "acceptEdits",
		"--allowedTools", strings.Join(validationAllowedTools, ","),
		"--add-dir", repoDir(),
		"--mcp-config", mcpPath,
	}
	if err := a.pty.start(a, repoDir(), withGuiPath(), claudeArgs); err != nil {
		a.StopSession()
		return ValidationStart{}, err
	}
	a.startVerdictWatch()
	go func() {
		time.Sleep(2 * time.Second)
		_ = a.submitToPty(composeValidationPrompt(env, pr, jiraCard, instructions))
	}()
	return ValidationStart{Token: token, JiraCard: jiraCard}, nil
}

// startVerdictWatch polls the verdict rendezvous file for the duration of the
// validation session. `qar verdict-posted` writes it after Claude posts a verdict
// (button- or manually-driven); on seeing it we emit "verdict-posted" {issue,result}
// so the GUI hides the Verdict button, then consume the file. Any stale file from a
// prior session is cleared up front so it can't fire a false positive.
func (a *App) startVerdictWatch() {
	path := verdictPostedPath()
	_ = os.Remove(path)
	stop := make(chan struct{})
	a.sessionMu.Lock()
	a.stopVerdictWatch = stop
	a.sessionMu.Unlock()

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
					Issue  string `json:"issue"`
					Result string `json:"result"`
				}
				if json.Unmarshal(data, &v) == nil && v.Issue != "" {
					runtime.EventsEmit(a.ctx, "verdict-posted", map[string]any{
						"issue": v.Issue, "result": v.Result,
					})
				}
				// Consume it either way so a malformed file can't spin.
				_ = os.Remove(path)
			}
		}
	}()
}

// stopVerdictWatcher stops the poller if one is running (idempotent).
func (a *App) stopVerdictWatcher() {
	a.sessionMu.Lock()
	stop := a.stopVerdictWatch
	a.stopVerdictWatch = nil
	a.sessionMu.Unlock()
	if stop != nil {
		close(stop)
	}
}

// The compose*Prompt helpers (and their markdown templates) live in prompts.go.

// companionClaudeArgs builds the claude flags for the run companion. Same scoped
// allowlist as authoring (browser MCP + qar + file edit under the repo); the MCP
// config points chrome-devtools-mcp at the RUN's CDP port.
// NOTE: intentionally reuses authoringAllowedTools (same capability surface —
// edits suites + drives the browser). It includes `qar run`, but the
// qa-run-companion skill tells the companion not to self-run; that guardrail is
// prose in the skill, not the allowlist.
func companionClaudeArgs(mcpPath, repo string) []string {
	return []string{
		"--permission-mode", "default",
		"--allowedTools", strings.Join(authoringAllowedTools, ","),
		"--add-dir", repo,
		"--mcp-config", mcpPath,
	}
}

// StartRunCompanion (bound) lazily spawns the run companion against an
// already-running run's browser. cdpPort is the run browser's CDP port (from the
// screencast envelope, forwarded by the React run screen). One companion at a time.
func (a *App) StartRunCompanion(cdpPort int, suite string) (string, error) {
	// Evict any live session (a prior companion or an authoring one) so a single
	// PTY slot is free. If it tore something down, tell the GUI so the OTHER tab
	// (Author) resets to idle instead of showing "Session live" over a dead PTY.
	// This is the eviction of the OLD session; the companion we start below owns the
	// slot with a fresh token, so emitting session-ended here doesn't kill it.
	if a.teardownSession() {
		runtime.EventsEmit(a.ctx, "session-ended")
	}
	// Mint the active token AFTER the eviction, so any prior session's owner no
	// longer holds the active token (their later StopSessionIfOwner is a no-op).
	token := a.newSessionToken("companion")

	mcpPath, err := writeSessionMcpConfig(cdpPort)
	if err != nil {
		return "", err
	}
	a.sessionMu.Lock()
	a.sessionMcpPath = mcpPath
	a.sessionMu.Unlock()
	logMcp("companion session: config=%s suite=%s", mcpPath, suite)
	go probeMcpServers(cdpPort)

	repo := repoDir()
	if err := a.pty.start(a, repo, withGuiPath(), companionClaudeArgs(mcpPath, repo)); err != nil {
		a.StopSession()
		return "", err
	}
	go func() {
		time.Sleep(2 * time.Second)
		_ = a.submitToPty(composeCompanionPrompt(suite))
	}()
	return token, nil
}

// WriteToPty forwards base64-encoded keystrokes from the xterm terminal to claude.
func (a *App) WriteToPty(b64 string) error {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return err
	}
	return a.pty.write(data)
}

// ResizePty resizes claude's PTY when the terminal pane resizes.
func (a *App) ResizePty(rows, cols int) error {
	return a.pty.resize(uint16(rows), uint16(cols))
}

// submitToPty types a line into claude and submits it. Claude's TUI captures a
// long block written together with its trailing CR as multi-line *paste* content,
// so the Enter never registers as a submit (the user had to press Enter by hand).
// Writing the CR as a separate event after a short delay makes the TUI treat it
// as a distinct submit keystroke. Used for BOTH the opening instruction and the
// "Save as suite" finalizing instruction so they behave identically.
func (a *App) submitToPty(text string) error {
	if err := a.pty.write([]byte(text)); err != nil {
		return err
	}
	time.Sleep(120 * time.Millisecond)
	return a.pty.write([]byte("\r"))
}

// SendToPty submits a finalizing instruction into the live session ("Save as suite").
func (a *App) SendToPty(text string) error {
	return a.submitToPty(text)
}

// teardownSession stops the claude PTY, the qar session process (browser +
// screencast), and removes the temp MCP config. Returns whether anything was
// actually running (so callers can decide whether to emit "session-ended").
func (a *App) teardownSession() bool {
	a.stopVerdictWatcher()
	running := a.pty.running()
	a.pty.stop()

	a.sessionMu.Lock()
	cmd := a.sessionCmd
	mcpPath := a.sessionMcpPath
	a.sessionCmd = nil
	a.sessionMcpPath = ""
	// Clear the active token: the session occupying the slot is gone. A new Start
	// mints a fresh token immediately after calling teardownSession, so the eviction
	// leaves no active owner in between.
	a.sessionToken = ""
	a.sessionMu.Unlock()

	if cmd != nil {
		running = true
		if cmd.Process != nil {
			// Kill the whole process GROUP (-pid), not just the wrapper: the session is
			// pnpm → tsx → node → Chrome, and pnpm won't forward a signal to its child.
			// Signalling only cmd.Process orphaned the real session + its Chrome, which
			// kept holding the session lock. cmd.Wait() runs in startSessionBrowser's
			// `exited` goroutine and reaps it (don't Wait twice here). SIGKILL follows
			// so a process ignoring SIGTERM can't linger and hold the lock.
			pid := cmd.Process.Pid
			_ = syscall.Kill(-pid, syscall.SIGTERM)
			go escalateKill(pid)
		}
	}
	if mcpPath != "" {
		_ = os.Remove(mcpPath)
	}
	return running
}

// escalateKill SIGKILLs a process group a moment after a SIGTERM, so a session that
// doesn't honor SIGTERM promptly can't linger and keep holding the single-session
// lock. Harmless if the group already exited (kill on a gone pgid is a no-op error).
func escalateKill(pid int) {
	time.Sleep(2 * time.Second)
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

// StopSession (bound) tears down the authoring session and tells the GUI it ended
// — but only emits "session-ended" if something was actually running, so the
// pre-start clean-slate teardown in StartAuthoringSession doesn't flip the UI.
func (a *App) StopSession() {
	if a.teardownSession() {
		runtime.EventsEmit(a.ctx, "session-ended")
	}
}

// StopSessionIfOwner (bound) is the FRONTEND-triggered teardown path. Both the
// authoring and companion React tabs stay mounted and share the single PTY slot,
// so a STALE tab's unmount must not kill a LIVE session the other tab started.
// The caller passes the token it received from Start*; we tear down ONLY if that
// token still owns the active session. A mismatch (a superseded owner) is a no-op.
func (a *App) StopSessionIfOwner(token string) {
	a.sessionMu.Lock()
	owns := token != "" && token == a.sessionToken
	if owns {
		// Claim the slot under the SAME lock that decided ownership, closing the
		// check-then-act gap: a concurrent StopSessionIfOwner with our token now
		// sees "" and won't double-fire, and a concurrent Start (which calls
		// teardownSession + mints a fresh token) is unaffected. teardownSession
		// itself re-acquires sessionMu, so we must NOT hold the lock across
		// StopSession() below — release it first.
		a.sessionToken = ""
	}
	a.sessionMu.Unlock()
	if !owns {
		return // stale caller — a newer session owns the slot (or nothing does)
	}
	a.StopSession()
}

// ErrRunInProgress is returned by RunEngine/RunProcess when a tracked run is
// already active — the second run is rejected rather than superseding the first.
// The frontend matches on this message to show "already running" and flip its
// button to Stop.
var ErrRunInProgress = errors.New("a run is already in progress")

// IsRunning reports whether a tracked run is currently active. The frontend calls
// this on mount so its Run/Stop button reflects the authoritative engine state
// (e.g. after a reload while a run is live), independent of event history.
func (a *App) IsRunning() bool {
	a.runMu.Lock()
	defer a.runMu.Unlock()
	return a.runCmd != nil
}

// streamCmd starts cmd, folding stderr into stdout, emitting each stdout line as
// a "stdout-line" event and a final "proc-exit" with the exit code. `label` names
// the process in spawn-failure messages.
//
// `track` marks this as THE stoppable run: it's registered in a.runCmd/a.runStdin
// (so StopRun/SendToRun target it), and any run already tracked is terminated
// first — only one live run at a time. Untracked commands (e.g. the suite `list`
// query) stream their output but never touch run state, so a background query
// can't be mistaken for the run and a run can't be silently orphaned by starting
// another. Both still emit stdout-line/proc-exit on the shared event bus.
func (a *App) streamCmd(cmd *exec.Cmd, label string, track bool) error {
	// Only ONE tracked run at a time. REJECT a second run rather than superseding
	// the first — an in-flight run (esp. a long study lifecycle) must not be
	// clobbered by an accidental/stale second Run. The reserve is atomic under
	// runMu so two near-simultaneous starts can't both pass the check. The caller
	// (the UI) surfaces ErrRunInProgress and flips its button to Stop.
	registered := false
	if track {
		a.runMu.Lock()
		if a.runCmd != nil {
			a.runMu.Unlock()
			return ErrRunInProgress
		}
		// Reserve the slot with a non-nil placeholder so a racing start is rejected
		// too; replaced with the real *exec.Cmd once Start() succeeds below.
		a.runCmd = &exec.Cmd{}
		a.runMu.Unlock()
		// If we bail before registering the real cmd (a pipe/Start failure), release
		// the reservation so the next Run isn't wrongly rejected.
		defer func() {
			if !registered {
				a.runMu.Lock()
				a.runCmd = nil
				a.runMu.Unlock()
			}
		}()
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.emitSpawnFailure(label, err)
		return err
	}
	cmd.Stderr = cmd.Stdout // fold stderr into the same stream (stray lines ignored by the parser)
	// A stdin pipe so SendToRun can push pause/resume control messages into a
	// `run`. Harmless for commands that don't read stdin (e.g. list): an
	// unwritten, unread pipe is inert, and it's closed when the process exits.
	stdin, err := cmd.StdinPipe()
	if err != nil {
		a.emitSpawnFailure(label, err)
		return err
	}
	// Own process group so StopRun can signal the engine AND its children (the
	// Chromium it launches), not just the parent.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		// Surface spawn failures (e.g. program not found) as a visible line + a
		// non-zero exit, so the UI shows WHY nothing happened instead of silently
		// doing nothing.
		_ = stdin.Close()
		a.emitSpawnFailure(label, err)
		return err
	}
	if track {
		a.runMu.Lock()
		a.runCmd = cmd
		a.runStdin = stdin
		a.runMu.Unlock()
		registered = true
	} else {
		// Untracked: nothing will write to stdin, so close our write end now.
		_ = stdin.Close()
	}
	logDiag("engine", "start: %s", label)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // allow long NDJSON lines
		// Retain the non-JSON lines the UI parser discards. stderr is folded into
		// this stream, so an engine that dies before its first step line (a missing
		// secret, a failed import) says WHY only here — the UI shows "No steps yet"
		// and nothing else. This is the silent-crash path in CLAUDE.md.
		var stray []string
		for scanner.Scan() {
			line := scanner.Text()
			runtime.EventsEmit(a.ctx, "stdout-line", line)
			if t := strings.TrimSpace(line); t != "" && !strings.HasPrefix(t, "{") && len(stray) < maxStrayLines {
				stray = append(stray, t)
			}
		}
		if err := scanner.Err(); err != nil {
			// A scan error (e.g. a line exceeding the buffer) would otherwise be
			// swallowed, leaving the UI thinking output ended cleanly. Surface it.
			runtime.EventsEmit(a.ctx, "stdout-line", fmt.Sprintf("[qa-runner] output read error: %v", err))
			logDiag("engine", "output read error: %v", err)
		}
		code := 0
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		if code != 0 {
			logDiag("engine", "FAIL exit=%d: %s", code, label)
			for _, s := range stray {
				logDiag("engine", "  %s", s)
			}
			if len(stray) == 0 {
				logDiag("engine", "  (no non-JSON output — engine died without a message)")
			}
		} else {
			logDiag("engine", "ok exit=0: %s", label)
		}
		if track {
			a.runMu.Lock()
			if a.runCmd == cmd {
				a.runCmd = nil
				if a.runStdin != nil {
					_ = a.runStdin.Close()
					a.runStdin = nil
				}
			}
			a.runMu.Unlock()
		}
		runtime.EventsEmit(a.ctx, "proc-exit", code)
	}()
	return nil
}

// StopRun terminates the in-flight Suites/engine run (and its children, e.g. the
// Chromium the engine launched) by signalling its process group. No-op if nothing
// is running. The reader goroutine in streamCmd reaps the process and emits the
// final proc-exit, so the UI returns to idle on its own.
func (a *App) StopRun() error {
	a.terminateRun()
	return nil
}

// terminateRun kills the tracked run's process group and waits (bounded) for it
// to actually exit, so callers can rely on the run being gone when it returns.
// Used by StopRun and by streamCmd before starting a new tracked run (only one
// run at a time — no orphans). No-op if nothing is running.
func (a *App) terminateRun() {
	a.runMu.Lock()
	cmd := a.runCmd
	a.runMu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	// Setpgid made the child a group leader (PGID == PID); -pid hits the whole group.
	// The engine handles SIGTERM and exits promptly (see run.ts onStop); SIGKILL is
	// only a fallback for a wedged process.
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	// Wait for streamCmd's reader goroutine to reap it and clear a.runCmd, escalating
	// to SIGKILL if it doesn't die promptly. Bounded so a truly stuck process can't
	// hang the caller (a later spawn still supersedes it on the shared event bus).
	deadline := time.Now().Add(3 * time.Second)
	killed := false
	for time.Now().Before(deadline) {
		a.runMu.Lock()
		gone := a.runCmd != cmd
		a.runMu.Unlock()
		if gone {
			return
		}
		if !killed && time.Now().After(deadline.Add(-1500*time.Millisecond)) {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			killed = true
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Last-resort SIGKILL if it never cleared within the window.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

// SendToRun writes one NDJSON control line to the in-flight run's stdin. The
// frontend uses it for pause-set / resume messages (see resumeControlLine /
// pauseSetControlLine). No-op if no run is active; a broken-pipe error (e.g. the
// run just died / was stopped) is swallowed since it's inherently racy.
func (a *App) SendToRun(line string) error {
	a.runMu.Lock()
	w := a.runStdin
	a.runMu.Unlock()
	if w == nil {
		return nil
	}
	if _, err := io.WriteString(w, line+"\n"); err != nil {
		return nil // racing StopRun / process exit — not actionable
	}
	return nil
}

// resumeControlLine / pauseSetControlLine build the NDJSON control messages the
// engine's stdin reader understands (mirrors src/cli/step-stream.ts). Factored out
// so they're unit-testable without a live run.
func resumeControlLine() string {
	return `{"type":"resume"}`
}

func pauseSetControlLine(steps []string) string {
	b, _ := json.Marshal(struct {
		Type  string   `json:"type"`
		Steps []string `json:"steps"`
	}{Type: "pause-set", Steps: steps})
	return string(b)
}

func jumpToControlLine(index int) string {
	b, _ := json.Marshal(struct {
		Type  string `json:"type"`
		Index int    `json:"index"`
	}{Type: "jump-to", Index: index})
	return string(b)
}

// emitSpawnFailure surfaces a failed process launch to the UI as an error line
// plus a non-zero exit, so a missing tool (e.g. pnpm/claude not on a GUI app's
// PATH) shows up instead of the run silently doing nothing.
func (a *App) emitSpawnFailure(program string, err error) {
	logDiag("spawn", "FAIL %s: %v (PATH=%s)", program, err, guiPath(withGuiPath()))
	runtime.EventsEmit(a.ctx, "stdout-line", fmt.Sprintf("[qa-runner] could not start %q: %v", program, err))
	runtime.EventsEmit(a.ctx, "proc-exit", -1)
}

// ReadScreenshot reads a per-step screenshot PNG from disk and returns it as a
// base64 data URI, so the webview can show it as an <img src>. (Webviews block
// file:// resources, so we pipe the bytes through the Go backend instead.)
// `bundleDir` is the run's absolute bundle path; `rel` is the bundle-relative
// screenshot path carried on each step event.
func (a *App) ReadScreenshot(bundleDir string, rel string) (string, error) {
	full := filepath.Join(bundleDir, rel)
	// Guard against path traversal escaping the bundle dir.
	if !strings.HasPrefix(filepath.Clean(full), filepath.Clean(bundleDir)) {
		return "", fmt.Errorf("screenshot path outside bundle")
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data), nil
}

// ReadVideo reads the run's recorded video.webm and returns it as base64 (no data
// URI prefix — the webview decodes it into a Blob and createObjectURL's it, which
// avoids a multi-MB data: URL on the <video src>). Webviews block file://, so the
// bytes come through the backend.
func (a *App) ReadVideo(bundleDir string) (string, error) {
	full := filepath.Join(bundleDir, "video.webm")
	if !strings.HasPrefix(filepath.Clean(full), filepath.Clean(bundleDir)) {
		return "", fmt.Errorf("video path outside bundle")
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// SaveScreenshotAs prompts the tester for a location and copies one screenshot
// (bundle-relative `rel` under `bundleDir`) there. The default filename is
// prefixed with the suite name (e.g. "signin-01-confirm-dashboard.png") so
// downloads from different suites don't collide. Returns the saved path, or ""
// if the dialog was cancelled.
func (a *App) SaveScreenshotAs(bundleDir string, rel string, suite string) (string, error) {
	src := filepath.Join(bundleDir, rel)
	if !strings.HasPrefix(filepath.Clean(src), filepath.Clean(bundleDir)) {
		return "", fmt.Errorf("screenshot path outside bundle")
	}
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: prefixSuite(suite, filepath.Base(rel)),
		Title:           "Save screenshot",
	})
	if err != nil || dest == "" {
		return "", err
	}
	if err := copyFile(src, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// SaveTrace prompts for a location and copies out just the bundle's trace.zip —
// the standalone Playwright trace that replays at trace.playwright.dev. (The
// "Download all" zip nests trace.zip inside an outer archive, which the trace
// viewer rejects; this hands the tester the inner file directly.) The default
// filename is suffixed with the suite name (e.g. "agreements-back-trace.zip") so
// downloads from different runs don't collide. Returns the saved path, or "" if
// cancelled / no trace was captured.
func (a *App) SaveTrace(bundleDir string, suite string) (string, error) {
	src := filepath.Join(bundleDir, "trace.zip")
	if _, err := os.Stat(src); err != nil {
		return "", fmt.Errorf("no trace.zip in this run bundle")
	}
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: prefixSuite(suite, "trace.zip"),
		Title:           "Save Playwright trace",
	})
	if err != nil || dest == "" {
		return "", err
	}
	if err := copyFile(src, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// ZipBundle prompts for a location and writes a .zip of the entire run bundle
// (screenshots + video + trace.zip + report + summary). The default filename is
// prefixed with the suite name (e.g. "signin-2026-07-01_125855_signin_qa.zip").
// Returns the saved path, or "" if cancelled.
func (a *App) ZipBundle(bundleDir string, suite string) (string, error) {
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: prefixSuite(suite, filepath.Base(bundleDir)+".zip"),
		Title:           "Download all run artifacts",
	})
	if err != nil || dest == "" {
		return "", err
	}
	out, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	defer zw.Close()

	walkErr := filepath.Walk(bundleDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, err := filepath.Rel(bundleDir, p)
		if err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		w, err := zw.Create(rel)
		if err != nil {
			return err
		}
		_, err = io.Copy(w, f)
		return err
	})
	if walkErr != nil {
		return "", walkErr
	}
	return dest, nil
}

func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// GitPull runs `git pull` in the cloned repo and returns combined output.
func (a *App) GitPull(cwd string) (string, error) {
	cmd := exec.Command(guiResolve("git"), "pull")
	cmd.Dir = repoDir()
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Sync fast-forwards the repo (suites + keyring + secrets). It never resets:
// returns "skipped-dirty" if the working copy has changes, "skipped-diverged"
// if the pull can't fast-forward, or "synced" on success.
func (a *App) Sync(cwd string) (string, error) {
	dir := repoDir()
	status, err := a.git(dir, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(status) != "" {
		return "skipped-dirty", nil
	}
	if _, err := a.git(dir, "pull", "--ff-only"); err != nil {
		return "skipped-diverged", nil
	}
	// Newly-pulled .ts suites are loaded directly by the engine (tsx) — no compile step.
	return "synced", nil
}

// keyringFiles are the tracked config files that determine keyring access
// (who's a recipient + the secrets encrypted to them). syncKeyringFiles pulls
// only these so a dirty/diverged working copy (e.g. local suite edits) doesn't
// block the access check.
var keyringFiles = []string{
	"config/keyring.json",
	"config/keyring.lock",
	"config/settings.secrets.json",
	"config/settings.json",
}

// syncKeyringFiles fetches the upstream branch and overwrites ONLY the keyring +
// settings files from it (git checkout <upstream> -- <files>), independent of
// working-copy state elsewhere. Returns a non-fatal note (never blocks the access
// check): a fetch failure or missing upstream just means we check the current
// checkout. Files that don't yet exist upstream are skipped.
func (a *App) syncKeyringFiles(dir string) string {
	if _, err := a.git(dir, "fetch", "--quiet"); err != nil {
		return "offline — checked local copy"
	}
	upstream, err := a.git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	if err != nil {
		return "no upstream — checked local copy"
	}
	ref := strings.TrimSpace(upstream)
	// Restrict to files that actually exist upstream (checkout errors otherwise).
	present := []string{}
	for _, f := range keyringFiles {
		if _, err := a.git(dir, "cat-file", "-e", ref+":"+f); err == nil {
			present = append(present, f)
		}
	}
	if len(present) == 0 {
		return ""
	}
	if out, err := a.git(dir, append([]string{"checkout", ref, "--"}, present...)...); err != nil {
		return "could not update keyring files: " + strings.TrimSpace(out)
	}
	return ""
}

// KeyringAccess is the encryption-access state shown by the first-launch gate:
// whether the local identity exists, whether it can decrypt, and — from the engine's
// access-status — where the access request itself stands.
type KeyringAccess struct {
	HasIdentity     bool   `json:"hasIdentity"`     // config/age-identity.txt exists
	IsRecipient     bool   `json:"isRecipient"`     // its public key decrypts the committed secrets
	Note            string `json:"note"`            // non-fatal pull note (offline / skipped), if any
	State           string `json:"state"`           // engine access-status state, "" if unavailable
	Branch          string `json:"branch"`          // the access branch for this key
	PrNumber        int    `json:"prNumber"`        // 0 when there is no PR
	PrURL           string `json:"prURL"`           // "" when there is no PR
	GithubReachable bool   `json:"githubReachable"` // false when gh/network failed
}

type engineAccessPR struct {
	Number int    `json:"number"`
	State  string `json:"state"`
	URL    string `json:"url"`
}

type engineAccessStatus struct {
	State           string          `json:"state"`
	Branch          string          `json:"branch"`
	Name            string          `json:"name"`
	PublicKey       string          `json:"publicKey"`
	PR              *engineAccessPR `json:"pr"`
	GithubReachable bool            `json:"githubReachable"`
	Note            string          `json:"note"`
}

func parseAccessStatus(raw []byte) (engineAccessStatus, error) {
	var s engineAccessStatus
	if err := json.Unmarshal(bytes.TrimSpace(raw), &s); err != nil {
		return engineAccessStatus{}, err
	}
	return s, nil
}

// accessStatusOutput runs the engine's access-status and returns its stdout. A var
// (not a direct engineCmd call) so tests can substitute a stub that fails or returns
// garbage, to pin accessStatus's non-fatal fallback without shelling out for real.
var accessStatusOutput = func() ([]byte, error) {
	return engineCmd("access-status").Output()
}

// accessStatus shells the engine's access-status. A failure is NON-FATAL: the gate
// still renders from the local decrypt check, with a note. Never let this turn an
// existing request into "no request".
func (a *App) accessStatus() (engineAccessStatus, string) {
	out, err := accessStatusOutput()
	if err != nil {
		return engineAccessStatus{}, "Couldn't check your access request status."
	}
	status, perr := parseAccessStatus(out)
	if perr != nil {
		return engineAccessStatus{}, "Couldn't read the access request status."
	}
	return status, status.Note
}

// CheckKeyringAccess pulls the latest keyring + secrets (only those files) and
// reports whether the local identity can ACTUALLY DECRYPT shared secrets. The
// frontend gates the app on IsRecipient — a false value means "walk the user
// through requesting access" — and re-calls this (the Retry button) to detect when
// a teammate's rekey PR has merged.
//
// The authoritative test is a real decrypt, not keyring.json membership:
// `request-access` writes the key into the local keyring before the access PR is
// opened/merged, so membership alone reads true for a key that never landed on main
// and thus can't decrypt anything. When there are no encrypted secrets to test
// against, fall back to keyring membership so a fresh/empty repo isn't wrongly gated.
func (a *App) CheckKeyringAccess(cwd string) (KeyringAccess, error) {
	dir := repoDir()
	note := a.syncKeyringFiles(dir)
	configDir := filepath.Join(dir, "config")
	has, canDecrypt, checkable, err := identityDecryptsSecrets(configDir)
	if err != nil {
		return KeyringAccess{}, err
	}
	if has && !checkable {
		// Nothing encrypted to verify against — defer to keyring membership.
		if _, isRecipient, kerr := identityInKeyring(configDir); kerr == nil {
			canDecrypt = isRecipient
		}
	}
	status, statusNote := a.accessStatus()
	if statusNote != "" {
		if note == "" {
			note = statusNote
		} else {
			note = note + " " + statusNote
		}
	}
	access := KeyringAccess{
		HasIdentity:     has,
		IsRecipient:     canDecrypt,
		Note:            note,
		State:           status.State,
		Branch:          status.Branch,
		GithubReachable: status.GithubReachable,
	}
	if status.PR != nil {
		access.PrNumber = status.PR.Number
		access.PrURL = status.PR.URL
	}
	return access, nil
}

// RequestAccess runs the bundled engine's `request-access --name <name>` (generate
// identity + open a keyring PR) in the cloned repo, returning combined output. On
// failure the output is folded into the error — Wails drops the returned string when
// err is non-nil, so without this the UI would only show a bare "exit status 1".
func (a *App) RequestAccess(cwd, name string) (string, error) {
	out, err := engineCmd("request-access", "--name", name).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("request-access failed: %s\n%s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// OpenAccessPr runs the engine's open-access-pr for an already-pushed access branch
// — the retry path for a request whose push succeeded but whose PR creation didn't.
func (a *App) OpenAccessPr(cwd string) (string, error) {
	out, err := engineCmd("open-access-pr").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("open-access-pr failed: %s\n%s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// Rekey runs the bundled engine's `rekey` (re-encrypt secrets to the keyring).
func (a *App) Rekey(cwd string) (string, error) {
	out, err := engineCmd("rekey").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("rekey failed: %s\n%s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// ResetAndSync discards ONLY uncommitted tracked edits (git restore .) — keeping
// local commits — then runs a fast-forward Sync. Returns the Sync status string.
func (a *App) ResetAndSync(cwd string) (string, error) {
	if _, err := a.git(repoDir(), "restore", "."); err != nil {
		return "", err
	}
	return a.Sync(cwd)
}

// IsInDrift reports whether config/keyring.lock is missing or doesn't match the
// fingerprint of config/keyring.json's recipients (sha256 of sorted, "\n"-joined
// public keys). Mirrors src/engine/keyring.ts isInDrift.
func (a *App) IsInDrift(cwd string) (bool, error) {
	dir := filepath.Join(repoDir(), "config")
	recipients, err := readKeyringRecipients(dir)
	if err != nil {
		return false, err
	}
	if len(recipients) == 0 {
		return false, nil
	}
	sorted := append([]string(nil), recipients...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	want := hex.EncodeToString(sum[:])
	lock, err := os.ReadFile(filepath.Join(dir, "keyring.lock"))
	if err != nil {
		if os.IsNotExist(err) {
			return true, nil
		}
		return false, err
	}
	return strings.TrimSpace(string(lock)) != want, nil
}

func (a *App) git(dir string, args ...string) (string, error) {
	cmd := exec.Command(guiResolve("git"), args...)
	cmd.Dir = dir
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	// Only failures: sync/access flows run many git commands, and a green log is
	// noise that buries the one line that matters.
	if err != nil {
		logDiag("git", "FAIL git %s (dir=%s): %v — %s",
			strings.Join(args, " "), dir, err, firstLines(string(out), 3))
	}
	return string(out), err
}

// traceNameRE collapses any run of characters unsafe in a download filename into
// a single dash, so a suite name (or, in exploratory mode, a free-text
// instruction) yields a safe "<suite>-<file>" prefix.
var traceNameRE = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// prefixSuite prepends a filesystem-safe suite name to a download filename
// (e.g. prefixSuite("sign in", "trace.zip") → "sign-in-trace.zip") so downloads
// from different suites don't collide. A blank/unsafe suite yields `name` as-is.
func prefixSuite(suite, name string) string {
	s := strings.Trim(traceNameRE.ReplaceAllString(suite, "-"), "-")
	if s == "" {
		return name
	}
	return s + "-" + name
}

// validSuiteName guards the suite name used in a branch + filename. We only need
// it to be filesystem- and git-branch-safe and reasonably short: letters, digits,
// hyphen, underscore, up to 40 chars. (Kept in sync with the frontend's check.)
var validSuiteName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// SuiteFileExists reports whether the claude-authored src/suites/<name>.ts exists
// in the repo. The "Open PR" button uses this to refuse to promote a suite that
// was never written.
func (a *App) SuiteFileExists(name string) bool {
	if !validSuiteName.MatchString(name) {
		return false
	}
	_, err := os.Stat(filepath.Join(repoDir(), "src", "suites", name+".ts"))
	return err == nil
}

// OpenSuiteInEditor opens the suite's TypeScript source in the user's editor so
// they can tweak it in place. Editor resolution, in order:
//
//  1. $VISUAL / $EDITOR if set (honors the user's explicit choice, e.g. "code",
//     "code -w", "vim" — split on spaces so wrapper flags survive).
//  2. A known GUI editor found on PATH: VS Code (`code`), then Cursor, Sublime.
//  3. macOS `open`, which routes the .ts file to whatever app the OS has
//     associated with it (Xcode, VS Code, TextEdit, …). This is the last resort
//     so we always open *something* rather than failing.
//
// The file must already exist — we don't create suites here.
func (a *App) OpenSuiteInEditor(name string) error {
	if !validSuiteName.MatchString(name) {
		return fmt.Errorf("invalid suite name %q", name)
	}
	path := filepath.Join(repoDir(), "src", "suites", name+".ts")
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("no suite source at %s: %w", path, err)
	}

	env := withGuiPath()
	prog, args := resolveEditor(path, guiLookPath(env))
	cmd := exec.Command(prog, args...)
	cmd.Dir = repoDir()
	cmd.Env = env
	// GUI editors (and `open`) return immediately; a terminal editor would need a
	// terminal we don't have, so we can't support those — Start + release is right
	// for the launch-and-detach GUI/`open` case.
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not open editor (%s): %w", prog, err)
	}
	go cmd.Wait() // reap the child so it doesn't linger as a zombie
	return nil
}

// resolveEditor picks the command + args to open `path`, following the priority
// documented on OpenSuiteInEditor. `onPath` reports whether a bare command name
// resolves (injected so it can honor the GUI-augmented PATH, not just this
// process's — a Finder-launched app has a minimal PATH). Pure given onPath.
func resolveEditor(path string, onPath func(string) bool) (string, []string) {
	if ed := strings.TrimSpace(firstNonEmpty(os.Getenv("VISUAL"), os.Getenv("EDITOR"))); ed != "" {
		// Split so "code -w" / "code --wait" keep their flags, then append the file.
		parts := strings.Fields(ed)
		return parts[0], append(parts[1:], path)
	}
	for _, cand := range []string{"code", "cursor", "subl"} {
		if onPath(cand) {
			return cand, []string{path}
		}
	}
	// Fall back to the OS file association (Xcode/VS Code/TextEdit/…).
	return "open", []string{path}
}

// guiLookPath returns an onPath predicate that resolves bare command names
// against the PATH carried in `env` (the GUI-augmented one from withGuiPath),
// falling back to the process PATH. Needed because exec.LookPath consults only
// the current process's PATH, which a Finder-launched app lacks the dev-tool dirs.
func guiLookPath(env []string) func(string) bool {
	path := ""
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			path = strings.TrimPrefix(e, "PATH=")
		}
	}
	dirs := filepath.SplitList(path)
	return func(name string) bool {
		for _, d := range dirs {
			full := filepath.Join(d, name)
			if info, err := os.Stat(full); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
				return true
			}
		}
		return false
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// promoteSteps is the ordered git/PR command sequence run AFTER the suite source
// has been captured and restored onto a clean branch (see PromoteSuite). Pure (no
// I/O) so it's unit-testable. The "qar" step is routed through the bundled engine.
//
// It is deliberately SURGICAL: it stages ONLY this suite's source file
// (src/suites/<name>.ts), never the whole directory — otherwise every suite
// authored in earlier attempts plus any other dirty file would ride along into
// the PR. The engine loads the .ts directly (tsx), so there is no compiled artifact.
// PromoteSuite has already cut the clean qa/<name> branch off origin/main and
// written the suite source onto it, so these steps must NOT switch branches again
// (that would discard the restored file).
func promoteSteps(name string) [][]string {
	branch := "qa/" + name
	suiteFile := "src/suites/" + name + ".ts"
	return [][]string{
		// Stage ONLY this suite's source file — never the whole dir.
		{"git", "add", "--", suiteFile},
		{"git", "commit", "-m", fmt.Sprintf("test: add %s suite (authored interactively, review selectors)", name), "--", suiteFile},
		{"git", "push", "-u", "origin", branch},
		{"gh", "pr", "create", "--fill"},
	}
}

// PromoteSuite opens a clean, single-suite PR for the claude-authored
// src/suites/<name>.ts. To guarantee the PR contains EXACTLY this one suite — not
// other attempts' suites, drifted commits, or unrelated dirty files — it does NOT
// trust the current working tree or branch:
//
//  1. capture the authored suite source into memory,
//  2. fetch the latest upstream main,
//  3. cut a fresh branch off origin/main (a clean base),
//  4. write the captured source back and commit only that one file.
//
// Capturing the bytes up front (rather than git-stashing) means it works whether the
// suite was untracked, modified, or already committed on a stale qa/* branch.
func (a *App) PromoteSuite(name string) (string, error) {
	if !validSuiteName.MatchString(name) {
		return "", fmt.Errorf("invalid suite name %q: use letters, digits, - and _ only (max 40 chars)", name)
	}
	repo := repoDir()
	suitePath := filepath.Join(repo, "src", "suites", name+".ts")

	// 1. Capture the authored source before any git surgery.
	src, err := os.ReadFile(suitePath)
	if err != nil {
		return "", fmt.Errorf("no authored suite at %s — write + verify it first: %w", suitePath, err)
	}

	// 2-3. Get a clean branch off the latest upstream main.
	if out, err := a.git(repo, "fetch", "origin", "main"); err != nil {
		return "", fmt.Errorf("git fetch origin main failed: %s", out)
	}
	if out, err := a.git(repo, "checkout", "-B", "qa/"+name, "origin/main"); err != nil {
		return "", fmt.Errorf("git checkout failed: %s", out)
	}

	// 4. Restore the captured source onto the clean branch (origin/main may not have
	// it, or may have an older version), then run the rest of the git/PR sequence.
	if err := os.MkdirAll(filepath.Dir(suitePath), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(suitePath, src, 0o644); err != nil {
		return "", fmt.Errorf("could not restore suite file: %w", err)
	}

	var last string
	for _, step := range promoteSteps(name) {
		var cmd *exec.Cmd
		if step[0] == "qar" {
			cmd = engineCmd(step[1:]...) // bundled engine; sets Dir + env itself
		} else {
			cmd = exec.Command(guiResolve(step[0]), step[1:]...)
			cmd.Dir = repo
			cmd.Env = withGuiPath()
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("%s failed: %s", strings.Join(step, " "), string(out))
		}
		last = string(out)
	}
	return last, nil
}

// ReportIssue opens a GitHub issue on the qa-review repo via `gh issue create`,
// assembling a body from the user's note plus everything we can gather to help
// debug: app/system info, repo state, missing tools, and — depending on which tab
// the user is on — the current Suites run state OR the full authoring transcript.
// `tab` is "suites" or "exploratory"; `runState` is the Suites-run summary the
// frontend builds (ignored on the exploratory tab). Returns the new issue URL.
func (a *App) ReportIssue(title, note, tab, runState string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "QA Runner issue report"
	}

	var b strings.Builder
	if n := strings.TrimSpace(note); n != "" {
		b.WriteString(n + "\n\n")
	}

	b.WriteString("## Context\n")
	if tab == "exploratory" {
		b.WriteString("- **Where:** Author a Suite (interactive Claude session)\n\n")
		transcript := a.pty.transcriptText()
		b.WriteString("## Claude session transcript\n")
		if strings.TrimSpace(transcript) == "" {
			b.WriteString("_(no transcript captured — no session was running)_\n")
		} else {
			b.WriteString("```\n" + transcript + "\n```\n")
		}
	} else {
		b.WriteString("- **Where:** Suites\n\n")
		b.WriteString("## Run state\n")
		if strings.TrimSpace(runState) == "" {
			b.WriteString("_(no run state — nothing has been run yet)_\n")
		} else {
			b.WriteString("```\n" + runState + "\n```\n")
		}
	}

	b.WriteString("\n## Setup Doctor\n")
	b.WriteString(doctorMarkdown(a.RunDoctor()))

	// This app's failures are silent (see diagLogPath): they reach the user as an
	// absence, not an error. Attach the log always — the user can't be expected to
	// know its path, and the per-session state it describes is gone by teardown.
	b.WriteString("\n## Diagnostic log\n")
	b.WriteString(recentDiagLogMarkdown())

	b.WriteString("\n## Debug info\n")
	b.WriteString(a.debugInfo())

	// gh reads the body from a file to avoid arg-length limits on long transcripts.
	bodyFile, err := os.CreateTemp("", "qar-issue-*.md")
	if err != nil {
		return "", err
	}
	defer os.Remove(bodyFile.Name())
	if _, err := bodyFile.WriteString(b.String()); err != nil {
		bodyFile.Close()
		return "", err
	}
	bodyFile.Close()

	cmd := exec.Command(guiResolve("gh"), "issue", "create",
		"--repo", qaReviewSlug,
		"--title", title,
		"--body-file", bodyFile.Name(),
	)
	cmd.Dir = repoDir()
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("gh issue create failed: %s", strings.TrimSpace(string(out)))
	}
	// gh prints the issue URL as the last line of stdout.
	url := strings.TrimSpace(string(out))
	if lines := strings.Split(url, "\n"); len(lines) > 0 {
		url = strings.TrimSpace(lines[len(lines)-1])
	}
	return url, nil
}

// debugInfo gathers a best-effort markdown block of environment + repo state for
// an issue report. Every probe is non-fatal: a failing one is reported inline
// rather than aborting the report.
func (a *App) debugInfo() string {
	repo := repoDir()
	var b strings.Builder
	row := func(k, v string) {
		v = strings.TrimSpace(v)
		if v == "" {
			v = "(unknown)"
		}
		b.WriteString(fmt.Sprintf("- **%s:** %s\n", k, v))
	}

	row("App version", appVersion)
	row("OS / arch", goruntime.GOOS+" / "+goruntime.GOARCH)
	row("Repo dir", repo)

	branch, _ := a.git(repo, "rev-parse", "--abbrev-ref", "HEAD")
	row("Git branch", branch)
	commit, _ := a.git(repo, "rev-parse", "--short", "HEAD")
	row("Git commit", commit)
	status, _ := a.git(repo, "status", "--porcelain")
	dirty := "clean"
	if strings.TrimSpace(status) != "" {
		dirty = fmt.Sprintf("%d uncommitted file(s)", len(strings.Split(strings.TrimSpace(status), "\n")))
	}
	row("Working tree", dirty)

	// gh auth and identity are reported by the "Setup Doctor" section of the issue,
	// so we don't duplicate them. Tool presence/versions ARE included here (via the
	// debug report) because the searched dirs + effective PATH are what diagnose the
	// Finder-PATH "installed but not found" bug.
	report := a.DebugReport()
	row("Searched dirs", strings.Join(report.SearchDirs, ", "))
	row("Effective PATH", report.EffectivePATH)
	for _, t := range report.Tools {
		if !t.Found {
			row("Tool "+t.Name, "not found")
			continue
		}
		detail := t.Version
		if t.Error != "" {
			detail = "version check failed: " + t.Error
		}
		row("Tool "+t.Name, fmt.Sprintf("%s (%s)", t.ResolvedAt, strings.TrimSpace(detail)))
	}

	drift, _ := a.IsInDrift("")
	row("Keyring drift", fmt.Sprintf("%t", drift))
	row("Authoring session live", fmt.Sprintf("%t", a.pty.running()))
	return b.String()
}

// doctorMarkdown renders Setup Doctor results as a markdown checklist for an issue.
func doctorMarkdown(checks []DoctorCheck) string {
	var b strings.Builder
	for _, c := range checks {
		mark := "✓"
		if !c.OK {
			mark = "✗"
		}
		b.WriteString(fmt.Sprintf("- %s **%s** — %s\n", mark, c.Name, strings.TrimSpace(c.Detail)))
		if !c.OK && strings.TrimSpace(c.Hint) != "" {
			b.WriteString("  - hint: " + strings.TrimSpace(c.Hint) + "\n")
		}
		if !c.OK && strings.TrimSpace(c.DocURL) != "" {
			b.WriteString("  - download: " + strings.TrimSpace(c.DocURL) + "\n")
		}
	}
	return b.String()
}

// DoctorCheck is one prerequisite result for the Settings "Setup Doctor".
type DoctorCheck struct {
	Name   string `json:"name"`   // human label, e.g. "GitHub CLI (gh)"
	OK     bool   `json:"ok"`     // passed?
	Detail string `json:"detail"` // version / "authenticated" on success; the error on failure
	Hint   string `json:"hint"`   // remediation shown when !OK
	DocURL string `json:"docURL"` // download/install page for the tool, shown as a link when !OK
}

// runToolFull runs a command against the GUI-augmented PATH (so a Finder-launched
// app finds Homebrew tools) and returns the trimmed FULL combined output. Use this
// when the caller needs every line (e.g. parsing multi-line JSON).
func runToolFull(name string, args ...string) (string, error) {
	cmd := exec.Command(guiResolve(name), args...)
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	trimmed := strings.TrimSpace(string(out))
	if err != nil {
		logDiag("tool", "FAIL %s %s: %v — %s", name, strings.Join(args, " "), err, firstLines(trimmed, 3))
	}
	return trimmed, err
}

// firstLines flattens the first n non-empty lines of command output onto one line,
// so a multi-line failure stays one greppable log entry.
func firstLines(s string, n int) string {
	var keep []string
	for _, ln := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(ln); t != "" {
			keep = append(keep, t)
			if len(keep) == n {
				break
			}
		}
	}
	if len(keep) == 0 {
		return "(no output)"
	}
	return strings.Join(keep, " | ")
}

// runTool is runToolFull narrowed to a single line: on success it returns the
// trimmed FIRST line of output (the version string); on FAILURE it returns the full
// combined output so the doctor can show the real reason — a truncated first line
// hides errors that print on stderr or later lines, which is exactly what made the
// Finder-PATH bug undiagnosable.
func runTool(name string, args ...string) (string, error) {
	out, err := runToolFull(name, args...)
	if err != nil {
		return out, err
	}
	return strings.SplitN(out, "\n", 2)[0], nil
}

// managementAppSlug is the repo whose PR numbers the validation screen accepts —
// a PR preview URL (prN.qa.safeinsights.org) is a deployment of THIS repo, not of
// qa-review. It's also where we look up a PR to infer its Jira card.
const managementAppSlug = "safeinsights/management-app"

// jiraBoards are the Jira project keys we recognize in a PR. Matching against a
// KNOWN board list (the approach versionista uses) rather than a generic
// `\w+-\d+` pattern is what makes this safe: the team's branches and titles are
// full of ticket-shaped noise — "fixes-2026", "node-7", "haiku-4", "pages-6" all
// appear in management-app history — and a generic pattern turns each into a
// bogus card that sends the validator chasing a ticket that doesn't exist.
// Anchoring on real boards also lets the match be case-insensitive and accept a
// space separator, so "otter 644" and "OTTER-644" both resolve.
// SHRMP is a recurring typo for SHRIMP in real commits; it's listed so those PRs
// still resolve, and normalizeJiraKey maps it back to the real board.
var jiraBoards = []string{"OTTER", "SHRIMP", "SHRMP"}

var jiraKeyRE = regexp.MustCompile(
	`(?i)\b(` + strings.Join(jiraBoards, "|") + `)[-\s](\d+)\b`)

// normalizeJiraKey renders a matched key canonically: uppercase board, hyphen
// separator, and the SHRMP typo corrected to SHRIMP.
func normalizeJiraKey(board, number string) string {
	board = strings.ToUpper(board)
	if board == "SHRMP" {
		board = "SHRIMP"
	}
	return board + "-" + number
}

// inferJiraCardFrom scans a PR's title, head branch, and body (in that order of
// preference) for a Jira key. Title and branch are where our team actually puts
// it; the body is scanned last because it often quotes OTHER tickets ("related to
// OTTER-99"), so a body match is the least trustworthy. Returns "" when nothing
// matches a known board — the caller then lets Claude work the ticket out from
// the PR, which is far better than acting on a wrong guess.
func inferJiraCardFrom(title, branch, body string) string {
	for _, field := range []string{title, branch, body} {
		if m := jiraKeyRE.FindStringSubmatch(field); m != nil {
			return normalizeJiraKey(m[1], m[2])
		}
	}
	return ""
}

// inferJiraCard looks up PR `pr` in the management-app repo and pulls a Jira key
// out of it, so a tester can validate by PR number alone. Any failure (offline, gh
// unauthenticated, no key anywhere) yields "" — the caller degrades to telling
// Claude to work the card out from the PR itself, which is strictly better than
// blocking the session on a lookup we don't control.
func inferJiraCard(pr string) string {
	pr = strings.TrimSpace(pr)
	if pr == "" {
		return ""
	}
	out, err := runToolFull("gh", "pr", "view", pr, "--repo", managementAppSlug,
		"--json", "title,headRefName,body")
	if err != nil {
		return ""
	}
	var v struct {
		Title       string `json:"title"`
		HeadRefName string `json:"headRefName"`
		Body        string `json:"body"`
	}
	if json.Unmarshal([]byte(out), &v) != nil {
		return ""
	}
	return inferJiraCardFrom(v.Title, v.HeadRefName, v.Body)
}

// ciContextPrefix selects the checks that gate a validation. The Jenkins statuses
// (continuous-integration/jenkins/pr-head, .../branch) are the ones that BUILD AND
// DEPLOY the PR preview — until they finish green, prN.qa.safeinsights.org either
// doesn't exist or is still serving the PREVIOUS commit's build. Validating then
// tests code that isn't the code under review. The GitHub Actions checks (lint,
// unit, e2e, CodeQL) are deliberately NOT gated on: they don't affect what's
// deployed, and a failing lint job shouldn't block a tester from looking at a
// feature that's live on the preview.
const ciContextPrefix = "continuous-integration/"

// PrCIStatus is the verdict on a PR's deployment checks. State is one of:
// "ok" (all matching checks succeeded), "pending" (at least one still running),
// "failed" (at least one concluded badly), "none" (the PR has no matching check
// yet — Jenkins hasn't reported), or "unknown" (we couldn't ask GitHub).
// Warning is a human sentence for the UI; empty when State is "ok".
type PrCIStatus struct {
	State   string   `json:"state"`
	Warning string   `json:"warning"`
	Checks  []string `json:"checks"`
}

// Blocking reports whether this status should stop a validation from starting.
// "unknown" does NOT block: an offline laptop or an unauthenticated gh is our
// problem, not evidence the deployment is stale, and blocking on it would strand a
// tester with no way forward. "none" DOES block — Jenkins not having reported is
// the exact case where the preview URL isn't built yet.
func (s PrCIStatus) Blocking() bool {
	return s.State == "pending" || s.State == "failed" || s.State == "none"
}

// ciRollupEntry is the subset of `gh pr view --json statusCheckRollup` we read.
// The rollup mixes two GraphQL types: CheckRun (GitHub Actions — Status +
// Conclusion) and StatusContext (third-party commit statuses like Jenkins —
// Context + State, with NO status field). The Jenkins checks we gate on are
// StatusContexts, so State is what carries their result.
type ciRollupEntry struct {
	TypeName   string `json:"__typename"`
	Name       string `json:"name"`
	Context    string `json:"context"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	State      string `json:"state"`
}

// label is the check's display name across both rollup types.
func (e ciRollupEntry) label() string {
	if e.Context != "" {
		return e.Context
	}
	return e.Name
}

// pending reports whether the check hasn't reached a verdict yet. A CheckRun is
// pending until Status is COMPLETED; a StatusContext is pending while its State is
// PENDING (Jenkins sets that when it accepts the build and again while it runs).
func (e ciRollupEntry) pending() bool {
	if e.TypeName == "CheckRun" {
		return !strings.EqualFold(e.Status, "COMPLETED")
	}
	return strings.EqualFold(e.State, "PENDING") || strings.EqualFold(e.State, "EXPECTED")
}

// succeeded reports a green verdict. SKIPPED and NEUTRAL count as green: a check
// that deliberately didn't run is not a reason to withhold the preview.
func (e ciRollupEntry) succeeded() bool {
	result := e.Conclusion
	if result == "" {
		result = e.State
	}
	return strings.EqualFold(result, "SUCCESS") ||
		strings.EqualFold(result, "SKIPPED") ||
		strings.EqualFold(result, "NEUTRAL")
}

// classifyCIRollup reduces a PR's rollup to a single verdict over the checks whose
// name starts with ciContextPrefix. Worst state wins — one pending check among ten
// green ones still means the deployment is mid-flight.
//
// GitHub returns one entry PER RUN, so a re-run leaves several entries with the
// SAME name; we keep the LAST of each name because the rollup is in run order and
// the latest run is the one that reflects the current commit. Without that, an old
// failed attempt would veto a passing re-run forever.
func classifyCIRollup(entries []ciRollupEntry) PrCIStatus {
	latest := map[string]ciRollupEntry{}
	var order []string
	for _, e := range entries {
		name := e.label()
		if !strings.HasPrefix(name, ciContextPrefix) {
			continue
		}
		if _, seen := latest[name]; !seen {
			order = append(order, name)
		}
		latest[name] = e
	}

	if len(order) == 0 {
		return PrCIStatus{
			State: "none",
			Warning: "No " + ciContextPrefix + "* check has reported on this PR yet. " +
				"The preview deployment is probably not built — wait for CI, then start again.",
		}
	}

	var names, pending, failed []string
	for _, name := range order {
		names = append(names, name)
		switch e := latest[name]; {
		case e.pending():
			pending = append(pending, name)
		case !e.succeeded():
			failed = append(failed, name)
		}
	}

	switch {
	case len(failed) > 0:
		return PrCIStatus{
			State: "failed",
			Warning: "CI failed on this PR (" + strings.Join(failed, ", ") + "). " +
				"The preview deployment may be missing or stale, so validating now " +
				"would test the wrong code.",
			Checks: names,
		}
	case len(pending) > 0:
		return PrCIStatus{
			State: "pending",
			Warning: "CI is still running on this PR (" + strings.Join(pending, ", ") + "). " +
				"The preview deployment isn't updated yet — wait for it to finish, " +
				"then start again.",
			Checks: names,
		}
	}
	return PrCIStatus{State: "ok", Checks: names}
}

// prCIStatus asks GitHub for PR `pr`'s check rollup and classifies it. A lookup
// failure yields "unknown", which is non-blocking (see Blocking).
func prCIStatus(pr string) PrCIStatus {
	pr = strings.TrimSpace(pr)
	if pr == "" {
		return PrCIStatus{State: "ok"}
	}
	out, err := runToolFull("gh", "pr", "view", pr, "--repo", managementAppSlug,
		"--json", "statusCheckRollup")
	if err != nil {
		return PrCIStatus{
			State:   "unknown",
			Warning: "Could not read CI status for PR " + pr + " from GitHub: " + out,
		}
	}
	var v struct {
		StatusCheckRollup []ciRollupEntry `json:"statusCheckRollup"`
	}
	if json.Unmarshal([]byte(out), &v) != nil {
		return PrCIStatus{
			State:   "unknown",
			Warning: "Could not parse the CI status GitHub returned for PR " + pr + ".",
		}
	}
	return classifyCIRollup(v.StatusCheckRollup)
}

// CheckPrCI is the UI-facing probe: the Validation tab calls it as the PR input
// settles so a tester sees a warning BEFORE pressing Start, rather than having the
// start call rejected. StartValidationSession re-checks (see there) — this is the
// early warning, not the gate.
func (a *App) CheckPrCI(pr string) PrCIStatus {
	return prCIStatus(pr)
}

// accessPROpen reports whether an access PR opened BY THIS USER (head branch
// "access/*") is already open on GitHub, so the Doctor can say "your PR is open — a
// teammate needs to rekey & merge it" instead of prompting for a duplicate. Scoping
// to --author "@me" (gh is authenticated as the user) is what makes this the user's
// OWN PR and not some other teammate's onboarding PR. Any error (offline, gh
// unauthenticated) yields false — the caller falls back to the plain "open an access
// PR" hint rather than blocking on the network.
func (a *App) accessPROpen() bool {
	out, err := runToolFull("gh", "pr", "list", "--repo", qaReviewSlug,
		"--state", "open", "--author", "@me", "--search", "head:access/", "--json", "number")
	if err != nil {
		return false
	}
	var prs []struct {
		Number int `json:"number"`
	}
	if err := json.Unmarshal([]byte(out), &prs); err != nil {
		return false
	}
	return len(prs) > 0
}

// nodeVersionProblem returns a human explanation if `ver` (e.g. "v21.1.0") is a node
// the MCP servers can't run on, or "" if it's fine. It mirrors chrome-devtools-mcp's
// declared engines — "^20.19.0 || ^22.12.0 || >=23" — so the supported set is
// 20.19+, 22.12+, or 23+. Node 21.x and early 20.x/22.x are the real traps: 21.1.0
// predates import.meta.dirname (added in 21.2.0/20.11.0), so the server throws
// `The "path" argument must be of type string` at import, naming neither node nor
// the version. An unparseable version is NOT reported as a problem — a doctor that
// cries wolf on an unexpected format is worse than one that stays quiet.
func nodeVersionProblem(ver string) string {
	major, minor, ok := parseNodeVersion(ver)
	if !ok {
		return ""
	}
	const supported = "chrome-devtools-mcp needs Node 20.19+, 22.12+, or 23+"
	switch {
	case major >= 23:
		return ""
	case major == 22:
		if minor >= 12 {
			return ""
		}
		return supported
	case major == 21:
		// No 21.x satisfies the engines range, whatever the minor.
		return supported
	case major == 20:
		if minor >= 19 {
			return ""
		}
		return supported
	default:
		return supported
	}
}

// parseNodeVersion pulls major/minor out of a `node --version` string ("v21.1.0").
func parseNodeVersion(ver string) (major, minor int, ok bool) {
	m := nodeVersionRE.FindStringSubmatch(strings.TrimSpace(ver))
	if m == nil {
		return 0, 0, false
	}
	major, err1 := strconv.Atoi(m[1])
	minor, err2 := strconv.Atoi(m[2])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return major, minor, true
}

var nodeVersionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)\.`)

// RunDoctor checks every prerequisite app/state and validates it (not just "on
// PATH"): required CLIs and their versions, gh authentication, Chrome, the cloned
// repo, and the keyring identity. The Settings "Setup Doctor" modal renders one
// row per check with a ✓/✗ and any error.
func (a *App) RunDoctor() []DoctorCheck {
	checks := []DoctorCheck{}

	// Required CLIs (presence + version).
	for _, t := range []struct{ label, bin, flag, hint, docURL string }{
		{"git", "git", "--version", "Install git (e.g. xcode-select --install or Homebrew).", "https://git-scm.com/downloads"},
		{"GitHub CLI (gh)", "gh", "--version", "Install gh: brew install gh", "https://cli.github.com/"},
		{"Claude Code (claude)", "claude", "--version", "Install Claude Code, then ensure `claude` is on PATH.", "https://docs.anthropic.com/en/docs/claude-code/setup"},
		{"Node.js (node)", "node", "--version", "Install Node.js: brew install node", "https://nodejs.org/en/download"},
		{"uv (uvx)", "uvx", "--version", "Install uv (provides uvx) for the Jira MCP: brew install uv", "https://docs.astral.sh/uv/getting-started/installation/"},
	} {
		if !toolOnPath(t.bin) {
			checks = append(checks, DoctorCheck{Name: t.label, OK: false, Detail: "not found on PATH", Hint: t.hint, DocURL: t.docURL})
			continue
		}
		ver, err := runTool(t.bin, t.flag)
		if err != nil {
			checks = append(checks, DoctorCheck{Name: t.label, OK: false, Detail: "found but `" + t.bin + " " + t.flag + "` failed: " + ver, Hint: t.hint, DocURL: t.docURL})
			continue
		}
		// Presence is not enough for node: npx runs the MCP servers, and an
		// unsupported node crashes them at import with a message that names neither
		// node nor the version (issue #36 — a green "✓ Node.js v21.1.0" row while
		// every session came up with no browser tools).
		if t.bin == "node" {
			if why := nodeVersionProblem(ver); why != "" {
				checks = append(checks, DoctorCheck{
					Name: t.label, OK: false, Detail: ver + " — " + why,
					Hint:   "Install a supported Node (brew install node) and make sure it comes FIRST on PATH.",
					DocURL: t.docURL,
				})
				continue
			}
		}
		checks = append(checks, DoctorCheck{Name: t.label, OK: true, Detail: ver})
	}

	// Advisory: without an explicit identity, git commits fall back to the
	// auto-detected `<username>@<hostname>` — and when even that auto-detection
	// fails, `git commit` refuses, which used to surface only much later as a
	// pushed-but-empty access branch and a PR that failed with "No commits
	// between main and access/<name>".
	if toolOnPath("git") {
		name, nameErr := runTool("git", "config", "user.name")
		email, emailErr := runTool("git", "config", "user.email")
		if nameErr != nil {
			name = ""
		}
		if emailErr != nil {
			email = ""
		}
		checks = append(checks, gitIdentityCheck(name, email))
	}

	// gh must be authenticated (PR + issue + clone flows depend on it).
	if toolOnPath("gh") {
		out, err := runTool("gh", "auth", "status")
		if err != nil {
			checks = append(checks, DoctorCheck{Name: "GitHub auth", OK: false, Detail: "not logged in", Hint: "Run `gh auth login` in a terminal."})
		} else {
			checks = append(checks, DoctorCheck{Name: "GitHub auth", OK: true, Detail: out})
		}
	}

	// Google Chrome (Playwright launches the user's Chrome via channel:'chrome').
	if chromeInstalled() {
		checks = append(checks, DoctorCheck{Name: "Google Chrome", OK: true, Detail: "installed"})
	} else {
		checks = append(checks, DoctorCheck{Name: "Google Chrome", OK: false, Detail: "not found in /Applications", Hint: "Install Google Chrome — the runner drives it for tests.", DocURL: "https://www.google.com/chrome/"})
	}

	// The cloned qa-review repo (suites + config live here).
	if repoReady() {
		checks = append(checks, DoctorCheck{Name: "Test repository", OK: true, Detail: repoDir()})
	} else {
		checks = append(checks, DoctorCheck{Name: "Test repository", OK: false, Detail: "not cloned at " + repoDir(), Hint: "Use the first-launch setup (or the Suites tab) to clone the repository."})
	}

	// Keyring identity — needed to decrypt shared secrets. Presence of the identity
	// file (and even membership in the working-tree keyring.json) isn't enough: the
	// authoritative test is whether the key can ACTUALLY DECRYPT a committed secret.
	// `request-access` writes your key into the local keyring before the access PR is
	// opened/merged, so a key that never landed on main still looks present — but it
	// was never rekeyed into the committed secrets and can't decrypt them. When that's
	// the case, tailor the hint by whether an access PR is already open.
	configDir := filepath.Join(repoDir(), "config")
	switch has, canDecrypt, checkable, err := identityDecryptsSecrets(configDir); {
	case err != nil:
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: false, Detail: "check failed: " + err.Error(), Hint: "Settings ▸ Request access to generate your identity and get added to the keyring."})
	case !has:
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: false, Detail: "no config/age-identity.txt", Hint: "Settings ▸ Request access to generate your identity and get added to the keyring."})
	case !checkable:
		// Identity present but nothing encrypted to test against — treat as OK; a
		// missing-secret failure would surface at run time with a clearer message.
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: true, Detail: "present (no encrypted secrets to verify against)"})
	case !canDecrypt:
		if a.accessPROpen() {
			checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: false, Detail: "can't decrypt shared secrets — access PR is open, awaiting rekey & merge", Hint: "A teammate needs to review, rekey & merge your open access PR. Then run Sync."})
		} else {
			checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: false, Detail: "can't decrypt shared secrets — your key isn't in the committed keyring", Hint: "Open an access PR (Settings ▸ Request access); a teammate reviews, rekeys & merges it."})
		}
	default:
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: true, Detail: "present and can decrypt secrets"})
	}

	checks = append(checks, jiraCheck(a.readJiraConfig()))

	return checks
}

// gitIdentityCheck reports whether git has an author identity configured. Unset
// config does NOT usually stop a commit — with the default user.useConfigOnly=false,
// git auto-detects `<username>@<hostname>` and commits with a warning — so this row
// is advisory: it flags the poor attribution a fallback identity produces, not a
// guaranteed failure. It is kept separate from RunDoctor (which shells out) so the
// missing/partial/complete cases are testable without a git config on the machine
// running the tests.
//
// `git config user.name` exits non-zero when the key is unset, so callers pass "" for
// both the error and empty-output cases — they are the same condition.
func gitIdentityCheck(name, email string) DoctorCheck {
	const label = "git identity"
	const hint = "Run `git config --global user.name \"Your Name\"` and `git config --global user.email \"you@example.com\"`."
	const docURL = "https://docs.github.com/en/get-started/getting-started-with-git/setting-your-username-in-git"

	name, email = strings.TrimSpace(name), strings.TrimSpace(email)
	switch {
	case name == "" && email == "":
		return DoctorCheck{Name: label, OK: false, Detail: "no user.name or user.email — commits fall back to <username>@<hostname>", Hint: hint, DocURL: docURL}
	case name == "":
		return DoctorCheck{Name: label, OK: false, Detail: "no user.name (email is " + email + ")", Hint: hint, DocURL: docURL}
	case email == "":
		return DoctorCheck{Name: label, OK: false, Detail: "no user.email (name is " + name + ")", Hint: hint, DocURL: docURL}
	}
	return DoctorCheck{Name: label, OK: true, Detail: name + " <" + email + ">"}
}

// jiraCheck validates that validation verdicts can actually be posted. The token is
// LocalOnly (per-user, never in the shared secrets, never distributed by `qar sync`),
// so unlike the other settings it is invisible until something fails — and the thing
// that fails is `qar jira-comment` at the end of a validation, the worst moment to
// discover it. Checking uvx alone doesn't help: that proves the MCP can launch, not
// that Jira will accept us.
//
// So this authenticates for real (GET /myself) rather than testing for non-empty
// strings — an expired or revoked token is the failure mode a presence check misses.
func jiraCheck(cfg JiraCfg) DoctorCheck {
	const name = "Jira credentials"
	const settingsHint = "Settings ▸ Jira: set your Atlassian email and API token."

	// Missing pieces are a "not set up yet" state, not a broken one — don't make a
	// network call to say so, and name the specific field that's absent.
	switch {
	case cfg.Username == "" && cfg.Token == "":
		return DoctorCheck{Name: name, OK: false, Detail: "not configured (no email or API token)", Hint: settingsHint, DocURL: jiraTokenDocURL}
	case cfg.Username == "":
		return DoctorCheck{Name: name, OK: false, Detail: "no JIRA_USERNAME (your Atlassian account email)", Hint: settingsHint}
	case cfg.Token == "":
		return DoctorCheck{Name: name, OK: false, Detail: "no JIRA_API_TOKEN", Hint: settingsHint, DocURL: jiraTokenDocURL}
	}

	who, err := jiraWhoAmI(cfg)
	if err != nil {
		return DoctorCheck{Name: name, OK: false, Detail: err.Error(), Hint: settingsHint, DocURL: jiraTokenDocURL}
	}

	// Authenticating only proves the credentials name a real account. A validation
	// WRITES three times — comment, attachment, transition — and a read-only account
	// passes /myself and then fails at the end of a validation, which is the moment
	// this check exists to stop being the discovery point.
	missing, err := jiraMissingPermissions(cfg)
	if err != nil {
		// A permission probe that can't run is not proof of a missing permission —
		// report it as unverified rather than failing a correctly-configured user.
		return DoctorCheck{
			Name:   name,
			OK:     false,
			Detail: "authenticated as " + who + ", but couldn't verify write access: " + err.Error(),
			Hint:   jiraAccessHint,
		}
	}
	if len(missing) > 0 {
		return DoctorCheck{
			Name:   name,
			OK:     false,
			Detail: "authenticated as " + who + ", but cannot " + strings.Join(missing, ", ") + " in " + jiraProbeProject,
			Hint:   jiraAccessHint,
		}
	}
	return DoctorCheck{
		Name:   name,
		OK:     true,
		Detail: "authenticated as " + who + "; can comment, attach, and transition in " + jiraProbeProject,
	}
}

const jiraAccessHint = "Ask a Jira admin to grant your account write access to the " +
	jiraProbeProject + " project (add comments, create attachments, transition issues)."

// The project the permission probe runs against. Deliberately NOT jiraBoards: that
// list exists to MATCH ticket keys in PR text and includes SHRMP, a typo alias, plus
// SHRIMP — both 404 on /mypermissions (verified against live Jira), which would make
// the doctor report a failure that says nothing about the user's actual access.
const jiraProbeProject = "OTTER"

// The three permissions a validation actually needs, mapped to the wording used when
// one is missing. Keys are Jira Cloud permission keys; see src/engine/jira.ts (comment
// + attachment) and the qa-validate skill (transition) for the calls they authorize.
var jiraWritePermissions = []struct{ key, verb string }{
	{"ADD_COMMENTS", "post comments"},
	{"CREATE_ATTACHMENTS", "attach screenshots"},
	{"TRANSITION_ISSUES", "transition issues"},
}

// jiraMissingPermissions returns the human-readable verbs for any write permission the
// account lacks. Permissions are per-project, so this asks about a real project rather
// than globally — a global answer wouldn't say whether the user can comment on OTTER.
func jiraMissingPermissions(cfg JiraCfg) ([]string, error) {
	base := strings.TrimRight(cfg.URL, "/")
	if base == "" {
		base = defaultJiraURL
	}
	keys := make([]string, 0, len(jiraWritePermissions))
	for _, p := range jiraWritePermissions {
		keys = append(keys, p.key)
	}

	// `permissions` is REQUIRED — the unparameterized form is deprecated and 400s.
	endpoint := base + "/rest/api/3/mypermissions?projectKey=" + url.QueryEscape(jiraProbeProject) +
		"&permissions=" + url.QueryEscape(strings.Join(keys, ","))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("bad JIRA_URL %q: %w", base, err)
	}
	req.SetBasicAuth(cfg.Username, cfg.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("can't reach %s: %v", base, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from /mypermissions", resp.StatusCode)
	}

	var body struct {
		Permissions map[string]struct {
			HavePermission bool `json:"havePermission"`
		} `json:"permissions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("unreadable response: %w", err)
	}

	var missing []string
	for _, p := range jiraWritePermissions {
		// A key absent from the response is not a grant — treat it as missing rather
		// than assuming allowed, so an API change can't silently turn this green.
		if !body.Permissions[p.key].HavePermission {
			missing = append(missing, p.verb)
		}
	}
	return missing, nil
}

const jiraTokenDocURL = "https://id.atlassian.com/manage-profile/security/api-tokens"

// Mirrors the engine's fallback in src/engine/jira.ts, so the doctor probes the same
// host `qar jira-comment` will post to when JIRA_URL is unset.
const defaultJiraURL = "https://openstax.atlassian.net"

// jiraWhoAmI authenticates against Jira Cloud and returns the display name (or email)
// of the account the credentials belong to. Same Basic email:token scheme as
// src/engine/jira.ts, so a pass here means `qar jira-comment` will authenticate too.
func jiraWhoAmI(cfg JiraCfg) (string, error) {
	base := strings.TrimRight(cfg.URL, "/")
	if base == "" {
		base = defaultJiraURL
	}
	req, err := http.NewRequest(http.MethodGet, base+"/rest/api/3/myself", nil)
	if err != nil {
		return "", fmt.Errorf("bad JIRA_URL %q: %w", base, err)
	}
	req.SetBasicAuth(cfg.Username, cfg.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("can't reach %s: %v", base, err)
	}
	defer resp.Body.Close()

	// 401/403 is the case worth naming precisely: the settings look filled in, so the
	// user would otherwise re-check them and find nothing wrong.
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return "", fmt.Errorf("rejected by Jira (HTTP %d) — the API token is wrong, expired, or revoked", resp.StatusCode)
	case resp.StatusCode != http.StatusOK:
		return "", fmt.Errorf("unexpected response from Jira (HTTP %d)", resp.StatusCode)
	}

	var me struct {
		DisplayName  string `json:"displayName"`
		EmailAddress string `json:"emailAddress"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		return "", fmt.Errorf("unreadable response from Jira: %w", err)
	}
	if me.DisplayName != "" {
		return me.DisplayName, nil
	}
	if me.EmailAddress != "" {
		return me.EmailAddress, nil
	}
	return cfg.Username, nil
}

// ToolProbe is one tool's resolution result for the debug report: whether it was
// found on the GUI-augmented PATH, the absolute path it resolved to, and its
// version output (or the error if the version call failed).
type ToolProbe struct {
	Name       string `json:"name"`
	Found      bool   `json:"found"`
	ResolvedAt string `json:"resolvedAt"` // absolute path, or "" if not found
	Version    string `json:"version"`    // `<bin> --version` first line, or ""
	Error      string `json:"error"`      // combined output if the version call failed
}

// DebugReport is the environment + tool-resolution detail the "Debug details"
// accordion shows (and that ReportIssue embeds). It exists to make the
// Finder-PATH class of "tool installed but not found" bug diagnosable: it names
// exactly which dirs were searched, the effective PATH, and where each tool
// resolved (or didn't).
type DebugReport struct {
	AppVersion    string      `json:"appVersion"`
	OSArch        string      `json:"osArch"`
	RepoDir       string      `json:"repoDir"`
	SearchDirs    []string    `json:"searchDirs"`    // guiPathDirsWithHome()
	EffectivePATH string      `json:"effectivePATH"` // the PATH used for every spawn
	Tools         []ToolProbe `json:"tools"`
	Markdown      string      `json:"markdown"` // debugMarkdown(self) — for copy-to-clipboard
}

// probeTool resolves one PATH-based tool (git/gh/claude/node) and runs its
// version flag, returning the same detail the doctor uses but structured.
func probeTool(name, versionFlag string) ToolProbe {
	if !toolOnPath(name) {
		return ToolProbe{Name: name, Found: false}
	}
	p := ToolProbe{Name: name, Found: true, ResolvedAt: guiResolve(name)}
	ver, err := runTool(name, versionFlag)
	if err != nil {
		p.Error = ver // runTool returns the full combined output on failure
	} else {
		p.Version = ver
	}
	return p
}

// DebugReport gathers PATH + per-tool resolution detail for the "Debug details"
// accordion. Every tool it checks is the same set the doctor validates, plus
// Chrome (a bundle, not a PATH tool).
func (a *App) DebugReport() DebugReport {
	r := DebugReport{
		AppVersion:    appVersion,
		OSArch:        goruntime.GOOS + " / " + goruntime.GOARCH,
		RepoDir:       repoDir(),
		SearchDirs:    guiPathDirsWithHome(),
		EffectivePATH: guiPath(withGuiPath()),
	}
	for _, t := range []struct{ name, flag string }{
		{"git", "--version"},
		{"gh", "--version"},
		{"claude", "--version"},
		{"node", "--version"},
		{"uvx", "--version"},
	} {
		r.Tools = append(r.Tools, probeTool(t.name, t.flag))
	}
	// Chrome resolves by .app bundle, not PATH.
	if p := chromePath(); p != "" {
		r.Tools = append(r.Tools, ToolProbe{Name: "Google Chrome", Found: true, ResolvedAt: p})
	} else {
		r.Tools = append(r.Tools, ToolProbe{Name: "Google Chrome", Found: false})
	}
	r.Markdown = debugMarkdown(r)
	return r
}

// debugMarkdown renders a DebugReport as a markdown block — used both for the
// accordion's copy-to-clipboard and (via debugInfo) the GitHub issue body, so a
// pasted debug log is byte-identical to what a filed issue contains.
func debugMarkdown(r DebugReport) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("- **App version:** %s\n", r.AppVersion))
	b.WriteString(fmt.Sprintf("- **OS / arch:** %s\n", r.OSArch))
	b.WriteString(fmt.Sprintf("- **Repo dir:** %s\n", r.RepoDir))
	b.WriteString(fmt.Sprintf("- **Searched dirs:** %s\n", strings.Join(r.SearchDirs, ", ")))
	b.WriteString(fmt.Sprintf("- **Effective PATH:** %s\n", r.EffectivePATH))
	b.WriteString("- **Tools:**\n")
	for _, t := range r.Tools {
		if !t.Found {
			b.WriteString(fmt.Sprintf("  - ✗ %s — not found\n", t.Name))
			continue
		}
		detail := t.Version
		if t.Error != "" {
			detail = "version check failed: " + t.Error
		}
		b.WriteString(fmt.Sprintf("  - ✓ %s — %s (%s)\n", t.Name, t.ResolvedAt, strings.TrimSpace(detail)))
	}
	return b.String()
}

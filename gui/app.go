package main

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
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

// withGuiPath returns a copy of the current environment with guiPathDirs ensured
// on PATH, so exec.Command can find dev tools regardless of how the app launched.
func withGuiPath() []string {
	env := os.Environ()
	path := os.Getenv("PATH")
	for _, d := range guiPathDirs {
		if !strings.Contains(path, d) {
			path = d + ":" + path
		}
	}
	out := make([]string, 0, len(env))
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") || strings.HasPrefix(e, "QAR_REPO_DIR=") {
			continue
		}
		out = append(out, e)
	}
	// Tell the bundled engine where the cloned repo (config/, suites, secrets) lives.
	return append(out, "PATH="+path, "QAR_REPO_DIR="+repoDir())
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
func (a *App) shutdown(ctx context.Context) {
	a.StopSession()
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
	return a.streamCmd(cmd, "qar "+strings.Join(args, " "), isTrackedRun(args))
}

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
	// Evict any live session (companion or a prior authoring one). If it actually
	// tore something down, tell the GUI so the OTHER tab (which shares the single
	// PTY slot) resets to idle instead of showing a live session over a dead PTY.
	// This is the eviction of the OLD session; the new one we start below immediately
	// re-announces itself (session-ready / a fresh token), so there's no self-teardown.
	if a.teardownSession() {
		runtime.EventsEmit(a.ctx, "session-ended")
	}
	// Mint the active token AFTER the eviction above, so any prior session's owner
	// no longer holds the active token (their later StopSessionIfOwner is a no-op).
	token := a.newSessionToken("authoring")

	// 1. Start the engine session.
	args := []string{"session", "--role", role}
	if strings.TrimSpace(pr) != "" {
		args = append(args, "--pr", pr)
	} else {
		args = append(args, "--env", env)
	}
	cmd := engineCmd(args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		a.emitSpawnFailure("qar session", err)
		return "", err
	}
	a.sessionMu.Lock()
	a.sessionCmd = cmd
	a.sessionMu.Unlock()

	// 2. Wait for the session ready line (cdpPort + screencastPort) with a timeout.
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
	// a stale repo without the `session` command, or a login error) — don't make
	// the user wait out the full timeout.
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
		return "", fmt.Errorf("could not start the session:\n%s", out)
	case <-time.After(90 * time.Second):
		a.teardownSession()
		return "", fmt.Errorf("timed out waiting for the browser session to start")
	}

	// 3. Per-session MCP config + announce the live browser to the GUI.
	mcpPath, err := writeSessionMcpConfig(info.CdpPort)
	if err != nil {
		a.StopSession()
		return "", err
	}
	a.sessionMu.Lock()
	a.sessionMcpPath = mcpPath
	a.sessionMu.Unlock()
	runtime.EventsEmit(a.ctx, "session-ready", info.ScreencastPort)

	// 4. Spawn claude in a PTY against the shared browser.
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

	// Send the opening instruction once claude's TUI is up (small delay so the
	// prompt box is ready to receive it). Same split text-then-CR submit as the
	// "Save as suite" path, so the user never has to press Enter by hand.
	go func() {
		time.Sleep(2 * time.Second)
		_ = a.submitToPty(composeAuthoringPrompt(env, pr, role, instruction))
	}()
	return token, nil
}

// composeAuthoringPrompt is claude's first message: invoke the qa-explore skill
// with the env/role/instruction. The browser is already launched + logged in.
func composeAuthoringPrompt(env, pr, role, instruction string) string {
	target := "--env " + env
	if strings.TrimSpace(pr) != "" {
		target = "--pr " + pr
	}
	return fmt.Sprintf("/qa-explore The browser is already open and logged in as %s against %s. Instruction: %s", role, target, instruction)
}

// composeCompanionPrompt is the companion Claude's first message: invoke the
// qa-run-companion skill for the suite whose run is on screen. The browser is the
// live run browser (driven by the engine; Claude drives it only when idle).
func composeCompanionPrompt(suite string) string {
	return fmt.Sprintf(
		"/qa-run-companion You are attached to a live run of the '%s' suite. "+
			"Read <bundleDir>/run-state.json for the run's steps and result. "+
			"Only drive the browser when the run is paused or errored.",
		suite,
	)
}

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
			// Signal only — a single cmd.Wait() runs in StartAuthoringSession's
			// `exited` goroutine and reaps the process (calling Wait twice races).
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	if mcpPath != "" {
		_ = os.Remove(mcpPath)
	}
	return running
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
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // allow long NDJSON lines
		for scanner.Scan() {
			runtime.EventsEmit(a.ctx, "stdout-line", scanner.Text())
		}
		if err := scanner.Err(); err != nil {
			// A scan error (e.g. a line exceeding the buffer) would otherwise be
			// swallowed, leaving the UI thinking output ended cleanly. Surface it.
			runtime.EventsEmit(a.ctx, "stdout-line", fmt.Sprintf("[qa-runner] output read error: %v", err))
		}
		code := 0
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
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

// emitSpawnFailure surfaces a failed process launch to the UI as an error line
// plus a non-zero exit, so a missing tool (e.g. pnpm/claude not on a GUI app's
// PATH) shows up instead of the run silently doing nothing.
func (a *App) emitSpawnFailure(program string, err error) {
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
	cmd := exec.Command("git", "pull")
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

// KeyringAccess is the first-launch encryption-access state: whether the local
// identity exists and whether it's a recipient in the (freshly pulled) keyring.
type KeyringAccess struct {
	HasIdentity bool   `json:"hasIdentity"` // config/age-identity.txt exists
	IsRecipient bool   `json:"isRecipient"` // its public key is in config/keyring.json
	Note        string `json:"note"`        // non-fatal pull note (offline / skipped), if any
}

// CheckKeyringAccess pulls the latest keyring + secrets (only those files) and
// reports whether the local identity can decrypt shared secrets. The frontend
// gates the app on IsRecipient — a false value means "walk the user through
// requesting access" — and re-calls this (the Retry button) to detect when a
// teammate's rekey PR has merged.
func (a *App) CheckKeyringAccess(cwd string) (KeyringAccess, error) {
	dir := repoDir()
	note := a.syncKeyringFiles(dir)
	has, isRecipient, err := identityInKeyring(filepath.Join(dir, "config"))
	if err != nil {
		return KeyringAccess{}, err
	}
	return KeyringAccess{HasIdentity: has, IsRecipient: isRecipient, Note: note}, nil
}

// RequestAccess runs the bundled engine's `request-access --name <name>` (generate
// identity + open a keyring PR) in the cloned repo, returning combined output.
func (a *App) RequestAccess(cwd, name string) (string, error) {
	out, err := engineCmd("request-access", "--name", name).CombinedOutput()
	return string(out), err
}

// Rekey runs the bundled engine's `rekey` (re-encrypt secrets to the keyring).
func (a *App) Rekey(cwd string) (string, error) {
	out, err := engineCmd("rekey").CombinedOutput()
	return string(out), err
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
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
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
			cmd = exec.Command(step[0], step[1:]...)
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

	cmd := exec.Command("gh", "issue", "create",
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

	// Tool presence/versions, gh auth, Chrome, and identity are reported in detail by
	// the "Setup Doctor" section above, so we don't duplicate them here.
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

// runTool runs a command against the GUI-augmented PATH (so a Finder-launched app
// finds Homebrew tools) and returns the trimmed first line of combined output.
func runTool(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	line := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]
	return line, err
}

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
		checks = append(checks, DoctorCheck{Name: t.label, OK: true, Detail: ver})
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
	// file isn't enough: the key must be a RECIPIENT in the keyring, else decryption
	// fails at runtime ("your key may not be a recipient yet"). Check both.
	switch has, isRecipient, err := identityInKeyring(filepath.Join(repoDir(), "config")); {
	case err != nil:
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: false, Detail: "check failed: " + err.Error(), Hint: "Settings ▸ Request access to generate your identity and get added to the keyring."})
	case !has:
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: false, Detail: "no config/age-identity.txt", Hint: "Settings ▸ Request access to generate your identity and get added to the keyring."})
	case !isRecipient:
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: false, Detail: "your key isn't in the keyring yet", Hint: "Ask a teammate to review & rekey your access PR, then sync."})
	default:
		checks = append(checks, DoctorCheck{Name: "Encryption identity", OK: true, Detail: "present and in keyring"})
	}

	return checks
}

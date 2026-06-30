package main

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

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
		if !strings.HasPrefix(e, "PATH=") {
			out = append(out, e)
		}
	}
	return append(out, "PATH="+path)
}

// resolveCwd makes a (possibly relative) cwd absolute against the app's working
// directory, so spawns don't depend on where the binary was launched from.
func resolveCwd(cwd string) string {
	if filepath.IsAbs(cwd) {
		return cwd
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return cwd
	}
	return abs
}

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// RunProcess spawns `program args...` in cwd, emitting "stdout-line" (string)
// for each stdout line and "proc-exit" (int exit code) when it finishes. Mirrors
// the previous Tauri run_process command. Runs the scan in a goroutine so the
// call returns immediately; the frontend drives the UI off the events.
func (a *App) RunProcess(program string, args []string, cwd string) error {
	cmd := exec.Command(program, args...)
	cmd.Dir = resolveCwd(cwd)
	cmd.Env = withGuiPath()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.emitSpawnFailure(program, err)
		return err
	}
	cmd.Stderr = cmd.Stdout // fold stderr into the same stream (stray lines ignored by the parser)
	if err := cmd.Start(); err != nil {
		// Surface spawn failures (e.g. program not found) as a visible line + a
		// non-zero exit, so the UI shows WHY nothing happened instead of silently
		// doing nothing.
		a.emitSpawnFailure(program, err)
		return err
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
		runtime.EventsEmit(a.ctx, "proc-exit", code)
	}()
	return nil
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
// (bundle-relative `rel` under `bundleDir`) there. Returns the saved path, or ""
// if the dialog was cancelled.
func (a *App) SaveScreenshotAs(bundleDir string, rel string) (string, error) {
	src := filepath.Join(bundleDir, rel)
	if !strings.HasPrefix(filepath.Clean(src), filepath.Clean(bundleDir)) {
		return "", fmt.Errorf("screenshot path outside bundle")
	}
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: filepath.Base(rel),
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

// ZipBundle prompts for a location and writes a .zip of the entire run bundle
// (screenshots + video + trace.zip + report + summary). Returns the saved path,
// or "" if cancelled.
func (a *App) ZipBundle(bundleDir string) (string, error) {
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: filepath.Base(bundleDir) + ".zip",
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

// GitPull runs `git pull` in cwd and returns combined output.
func (a *App) GitPull(cwd string) (string, error) {
	cmd := exec.Command("git", "pull")
	cmd.Dir = resolveCwd(cwd)
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Sync fast-forwards the repo (suites + keyring + secrets). It never resets:
// returns "skipped-dirty" if the working copy has changes, "skipped-diverged"
// if the pull can't fast-forward, or "synced" on success.
func (a *App) Sync(cwd string) (string, error) {
	dir := resolveCwd(cwd)
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
	return "synced", nil
}

// RequestAccess shells out to `pnpm otto request-access --name <name>` in cwd,
// returning combined output.
func (a *App) RequestAccess(cwd, name string) (string, error) {
	cmd := exec.Command("pnpm", "otto", "request-access", "--name", name)
	cmd.Dir = resolveCwd(cwd)
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Rekey shells out to `pnpm otto rekey` in cwd.
func (a *App) Rekey(cwd string) (string, error) {
	cmd := exec.Command("pnpm", "otto", "rekey")
	cmd.Dir = resolveCwd(cwd)
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// ResetAndSync discards ONLY uncommitted tracked edits (git restore .) — keeping
// local commits — then runs a fast-forward Sync. Returns the Sync status string.
func (a *App) ResetAndSync(cwd string) (string, error) {
	dir := resolveCwd(cwd)
	if _, err := a.git(dir, "restore", "."); err != nil {
		return "", err
	}
	return a.Sync(cwd)
}

// IsInDrift reports whether config/keyring.lock is missing or doesn't match the
// fingerprint of config/keyring.json's recipients (sha256 of sorted, "\n"-joined
// public keys). Mirrors src/engine/keyring.ts isInDrift.
func (a *App) IsInDrift(cwd string) (bool, error) {
	dir := filepath.Join(resolveCwd(cwd), "config")
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

// promoteSteps is the ordered command sequence for promoting a trace to a suite
// PR. Pure (no I/O) so it is unit-testable.
func promoteSteps(name, tracePath string) [][]string {
	branch := "qa/" + name
	return [][]string{
		{"git", "checkout", "-b", branch},
		{"pnpm", "otto", "codegen", "--trace", tracePath},
		{"git", "add", "src/suites"},
		{"git", "commit", "-m", fmt.Sprintf("test: add %s suite (AI-generated, review selectors)", name)},
		{"git", "push", "-u", "origin", branch},
		{"gh", "pr", "create", "--fill"},
	}
}

// PromoteSuite runs the promote sequence in cwd, stopping on the first failure,
// and returns the final step's output (the PR URL from `gh pr create`).
func (a *App) PromoteSuite(cwd, name, tracePath string) (string, error) {
	var last string
	abs := resolveCwd(cwd)
	for _, step := range promoteSteps(name, tracePath) {
		cmd := exec.Command(step[0], step[1:]...)
		cmd.Dir = abs
		cmd.Env = withGuiPath()
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("%s failed: %s", strings.Join(step, " "), string(out))
		}
		last = string(out)
	}
	return last, nil
}

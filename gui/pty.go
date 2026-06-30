package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ptySession holds the single live claude PTY (one authoring session at a time).
type ptySession struct {
	mu   sync.Mutex
	ptmx *os.File
	cmd  *exec.Cmd
	// transcript accumulates every byte of PTY output for the current session so
	// "Report Issue" can attach the full Claude conversation. Reset on each start;
	// capped so a very long session can't grow unbounded.
	transcript []byte
}

// maxTranscript caps the retained PTY transcript (keep the most recent bytes).
const maxTranscript = 512 * 1024

// transcriptText returns the captured PTY output for the current/last session
// with ANSI escape sequences stripped, suitable for a GitHub issue body.
func (p *ptySession) transcriptText() string {
	p.mu.Lock()
	raw := make([]byte, len(p.transcript))
	copy(raw, p.transcript)
	p.mu.Unlock()
	return stripANSI(string(raw))
}

// appendTranscript records PTY bytes, keeping only the most recent maxTranscript.
func (p *ptySession) appendTranscript(b []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.transcript = append(p.transcript, b...)
	if len(p.transcript) > maxTranscript {
		p.transcript = p.transcript[len(p.transcript)-maxTranscript:]
	}
}

// ansiRE matches ANSI/VT control sequences (CSI, OSC, and the bare escapes a TUI
// emits) so the captured transcript reads as plain text in a GitHub issue.
var ansiRE = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]|\x1b\\][^\x07\x1b]*(\x07|\x1b\\\\)|\x1b[@-Z\\\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]")

// stripANSI removes terminal control sequences and collapses the carriage-return
// redraws a TUI produces, leaving readable plain text.
func stripANSI(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return ansiRE.ReplaceAllString(s, "")
}

// start launches `claude args...` in `dir` with env `env` attached to a PTY, so
// claude runs INTERACTIVELY (a real TTY) — it shows permission prompts the user
// answers live. PTY bytes are base64'd onto the "pty-output" event; "pty-exit"
// fires with the code when claude exits.
func (p *ptySession) start(app *App, dir string, env []string, args []string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ptmx != nil {
		return fmt.Errorf("a session is already running")
	}
	cmd := exec.Command("claude", args...)
	cmd.Dir = dir
	cmd.Env = env
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return err
	}
	p.ptmx = ptmx
	p.cmd = cmd
	p.transcript = p.transcript[:0] // fresh transcript for this session

	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				runtime.EventsEmit(app.ctx, "pty-output", base64.StdEncoding.EncodeToString(buf[:n]))
				p.appendTranscript(buf[:n])
			}
			if err != nil {
				break
			}
		}
		code := 0
		if werr := cmd.Wait(); werr != nil {
			if exitErr, ok := werr.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		runtime.EventsEmit(app.ctx, "pty-exit", code)
		p.mu.Lock()
		p.ptmx = nil
		p.cmd = nil
		p.mu.Unlock()
	}()
	return nil
}

func (p *ptySession) write(data []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ptmx == nil {
		return fmt.Errorf("no pty")
	}
	_, err := p.ptmx.Write(data)
	return err
}

func (p *ptySession) resize(rows, cols uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ptmx == nil {
		return nil // nothing to resize yet
	}
	return pty.Setsize(p.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

// stop closes the PTY and kills claude's whole process group, so claude AND its
// children (e.g. the chrome-devtools-mcp server it spawned) are reaped — closing
// the PTY alone (SIGHUP) isn't enough; claude can ignore it and orphan its MCP
// child. The reader goroutine handles cmd.Wait() + clearing state.
func (p *ptySession) stop() {
	p.mu.Lock()
	ptmx := p.ptmx
	cmd := p.cmd
	p.mu.Unlock()
	if ptmx != nil {
		_ = ptmx.Close()
	}
	if cmd != nil && cmd.Process != nil {
		pid := cmd.Process.Pid
		// pty.Start makes the child a session leader, so its PGID == its PID;
		// signalling -pid hits the whole group (claude + npx chrome-devtools-mcp).
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		go func() {
			time.Sleep(3 * time.Second)
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}()
	}
}

func (p *ptySession) running() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ptmx != nil
}

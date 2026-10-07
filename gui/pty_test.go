package main

import (
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

// Verifies the teardown contract that StopSession relies on: a PTY child started
// like claude becomes its own process-group leader, so signalling -pid reaps the
// child AND any grandchild it spawned (mirroring claude -> chrome-devtools-mcp).
func TestPtyStopKillsProcessGroup(t *testing.T) {
	// Parent sh spawns a long-sleep grandchild, then sleeps itself.
	cmd := exec.Command("sh", "-c", "sleep 600 & echo $!; sleep 600")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("pty.Start: %v", err)
	}
	defer ptmx.Close()

	// Read the grandchild PID the parent printed.
	buf := make([]byte, 64)
	_ = ptmx.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, _ := ptmx.Read(buf)
	grandPid, err := strconv.Atoi(string(trimLine(buf[:n])))
	if err != nil || grandPid <= 0 {
		t.Fatalf("could not read grandchild pid from %q: %v", string(buf[:n]), err)
	}

	pid := cmd.Process.Pid
	// The kill that StopSession performs.
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil {
		t.Fatalf("kill group: %v", err)
	}
	time.Sleep(300 * time.Millisecond)

	if alive(grandPid) {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		t.Fatalf("grandchild %d survived the process-group kill (would orphan the MCP server)", grandPid)
	}
}

func alive(pid int) bool {
	// Signal 0 probes existence without killing.
	return syscall.Kill(pid, 0) == nil
}

func trimLine(b []byte) []byte {
	out := b
	for len(out) > 0 && (out[len(out)-1] == '\n' || out[len(out)-1] == '\r' || out[len(out)-1] == ' ') {
		out = out[:len(out)-1]
	}
	return out
}

func TestPromptReady(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want bool
	}{
		{"startup banner only", "Claude Code v2\nMCP servers connecting…", false},
		{"input prompt", "╭───╮\n│ ❯ │\n╰───╯", true},
		{"prompt with text after it", "❯ Try \"fix lint errors\"", true},
		{"trust dialog cursor", "Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit", false},
		{"menu cursor then prompt", "❯ 1. Yes\n\n❯ ", true},
		{"nbsp before menu number", "❯ 1. Yes", false},
	}
	for _, c := range cases {
		if got := promptReady(c.out); got != c.want {
			t.Errorf("%s: promptReady(%q) = %v, want %v", c.name, c.out, got, c.want)
		}
	}
}

func TestWaitReady(t *testing.T) {
	if waitReady(nil, 10*time.Millisecond) {
		t.Error("nil channel (no session) reported ready")
	}
	ready := make(chan struct{})
	if waitReady(ready, 20*time.Millisecond) {
		t.Error("reported ready before the prompt appeared")
	}
	close(ready)
	if !waitReady(ready, time.Second) {
		t.Error("closed channel not reported ready")
	}
}

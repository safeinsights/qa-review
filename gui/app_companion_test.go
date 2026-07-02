package main

import (
	"strings"
	"testing"
)

func TestComposeCompanionPrompt(t *testing.T) {
	got := composeCompanionPrompt("create-study")
	if !strings.Contains(got, "/qa-run-companion") {
		t.Fatalf("prompt should invoke the companion skill, got: %q", got)
	}
	if !strings.Contains(got, "create-study") {
		t.Fatalf("prompt should name the suite, got: %q", got)
	}
}

func TestCompanionClaudeArgs(t *testing.T) {
	args := companionClaudeArgs("/tmp/mcp.json", "/repo")
	joined := strings.Join(args, " ")
	for _, want := range []string{"--allowedTools", "--mcp-config", "/tmp/mcp.json", "--add-dir", "/repo"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q; got %v", want, args)
		}
	}
}

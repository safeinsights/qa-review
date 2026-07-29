package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

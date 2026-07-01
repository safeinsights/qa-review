package main

import (
	"os"
	"path/filepath"
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

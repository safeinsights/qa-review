package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestEnvFromBundleName(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"2026-09-23_141030_lighthouse_qa", "qa"},
		{"2026-09-23_141030_study-happy-path_production", "production"},
		// The suite name itself may contain underscores; the env is still the last
		// field, which is why this splits from the end rather than by field count.
		{"2026-09-23_141030_my_odd_suite_staging", "staging"},
		{"not-a-bundle", ""},
	}
	for _, c := range cases {
		if got := envFromBundleName(c.name); got != c.want {
			t.Errorf("envFromBundleName(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestStampFromBundleName(t *testing.T) {
	if got := stampFromBundleName("2026-09-23_141030_lighthouse_qa"); got != "2026-09-23_141030" {
		t.Errorf("stamp = %q", got)
	}
	if got := stampFromBundleName("short_name"); got != "" {
		t.Errorf("expected empty stamp for a non-bundle name, got %q", got)
	}
}

// Write a bundle dir with (or without) a lighthouse summary.
func writeBundle(t *testing.T, root, name, summary string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if summary == "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		return
	}
	lh := filepath.Join(dir, "lighthouse")
	if err := os.MkdirAll(lh, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lh, "summary.json"), []byte(summary), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestListLighthouseRuns(t *testing.T) {
	repo := t.TempDir()
	t.Setenv("QAR_REPO_DIR", repo)
	results := filepath.Join(repo, "results")

	// Deliberately written out of order: the listing must sort by timestamp.
	writeBundle(t, results, "2026-09-23_141030_lighthouse_qa",
		`{"overall":{"performance":62,"accessibility":94}}`)
	writeBundle(t, results, "2026-09-21_090000_lighthouse_staging",
		`{"overall":{"performance":55,"accessibility":90}}`)
	// A non-lighthouse run, and a run whose summary is corrupt: both are skipped
	// rather than failing the whole read.
	writeBundle(t, results, "2026-09-22_100000_signin_qa", "")
	writeBundle(t, results, "2026-09-22_110000_lighthouse_qa", "{not json")

	a := &App{}
	out, err := a.ListLighthouseRuns()
	if err != nil {
		t.Fatalf("ListLighthouseRuns: %v", err)
	}
	var runs []lighthouseRun
	if err := json.Unmarshal([]byte(out), &runs); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(runs) != 2 {
		t.Fatalf("expected 2 runs, got %d (%s)", len(runs), out)
	}
	if runs[0].Stamp != "2026-09-21_090000" || runs[1].Stamp != "2026-09-23_141030" {
		t.Errorf("runs are not oldest-first: %v", runs)
	}
	if runs[0].Env != "staging" || runs[1].Env != "qa" {
		t.Errorf("env parsed wrong: %v", runs)
	}
	if runs[1].Overall["performance"] != 62 {
		t.Errorf("overall score wrong: %v", runs[1].Overall)
	}
}

// No results dir at all means nothing has been run yet — an empty list, not an
// error the user has to interpret.
func TestListLighthouseRunsWithNoResultsDir(t *testing.T) {
	t.Setenv("QAR_REPO_DIR", t.TempDir())
	a := &App{}
	out, err := a.ListLighthouseRuns()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if out != "[]" {
		t.Errorf("expected an empty list, got %q", out)
	}
}

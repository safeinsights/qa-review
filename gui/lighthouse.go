package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Cross-run Lighthouse history. The lighthouse suite writes one
// <bundle>/lighthouse/summary.json per run; this reads them back so the
// Performance tab can plot a trend. Nothing else in the app enumerates past
// bundles — runs are otherwise only ever viewed one at a time.

// A bundle dir is named "<YYYY-MM-DD>_<HHMMSS>_<suite>_<env>" (see
// src/engine/recorder.ts). The env is the LAST underscore-separated field, and the
// timestamp the first two — the suite name sits between them and may itself contain
// underscores, so split from both ends rather than by a fixed field count.
func envFromBundleName(name string) string {
	parts := strings.Split(name, "_")
	if len(parts) < 4 {
		return ""
	}
	return parts[len(parts)-1]
}

func stampFromBundleName(name string) string {
	parts := strings.Split(name, "_")
	if len(parts) < 4 {
		return ""
	}
	return parts[0] + "_" + parts[1]
}

// One run's scores, as the frontend consumes them.
type lighthouseRun struct {
	Bundle string `json:"bundle"`
	// Directory name's timestamp, e.g. "2026-09-23_141030". Sorting by it orders
	// runs chronologically without parsing a date.
	Stamp string `json:"stamp"`
	Env   string `json:"env"`
	// Category id -> score, averaged across the run's routes.
	Overall map[string]int `json:"overall"`
}

// The subset of summary.json this needs. Kept minimal so a future field added on
// the TypeScript side cannot break the read.
type lighthouseSummary struct {
	Overall map[string]int `json:"overall"`
}

// ListLighthouseRuns returns every past run that recorded Lighthouse scores, as
// JSON, oldest first. Bundles without a summary.json are skipped rather than
// erroring: most runs are not Lighthouse runs, so their absence is the norm.
func (a *App) ListLighthouseRuns() (string, error) {
	root := filepath.Join(repoDir(), "results")
	entries, err := os.ReadDir(root)
	if err != nil {
		// No results dir yet simply means nothing has been run — an empty list, not
		// a failure the user has to act on.
		if os.IsNotExist(err) {
			return "[]", nil
		}
		return "", err
	}

	runs := []lighthouseRun{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, e.Name(), "lighthouse", "summary.json"))
		if err != nil {
			continue
		}
		var s lighthouseSummary
		// A truncated or hand-edited summary is skipped, not fatal: one bad bundle
		// must not hide the whole history.
		if err := json.Unmarshal(data, &s); err != nil || len(s.Overall) == 0 {
			logDiag("lighthouse", "skipping unreadable summary in %s", e.Name())
			continue
		}
		runs = append(runs, lighthouseRun{
			Bundle:  filepath.Join(root, e.Name()),
			Stamp:   stampFromBundleName(e.Name()),
			Env:     envFromBundleName(e.Name()),
			Overall: s.Overall,
		})
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].Stamp < runs[j].Stamp })

	out, err := json.Marshal(runs)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// SaveLighthouseReport prompts for a location and copies one route's HTML report
// out of a run bundle. Mirrors SaveTrace: the webview cannot open file:// itself,
// so the bytes go through the backend.
func (a *App) SaveLighthouseReport(bundleDir string, stem string) (string, error) {
	src := filepath.Join(bundleDir, "lighthouse", stem+".report.html")
	// Same guard as ReadScreenshot: a crafted stem must not read outside the bundle.
	if !strings.HasPrefix(filepath.Clean(src), filepath.Clean(bundleDir)) {
		return "", fmt.Errorf("report path outside bundle")
	}
	if _, err := os.Stat(src); err != nil {
		return "", fmt.Errorf("no %s report in this run bundle", stem)
	}
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: stem + ".report.html",
		Title:           "Save Lighthouse report",
	})
	if err != nil || dest == "" {
		return "", err
	}
	if err := copyFile(src, dest); err != nil {
		return "", err
	}
	return dest, nil
}

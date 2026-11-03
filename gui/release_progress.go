package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The progress panel above the run's browser. The run session writes
// progress-<env>.json (`qar release-progress`) and results-<env>.jsonl
// (`qar release-result`); this reads both against run-plan-lines-<env>.json. It reads
// the files directly instead of running the engine: the panel polls every 2 s.

type RunLine struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Section string `json:"section"`
	Role    string `json:"role"`
	Needs   string `json:"needs"`
	// Group is the plan's run group for a Changes line ("3 · Researcher · no study"),
	// or "Baseline" / "Security".
	Group string `json:"group"`
}

type RunProgress struct {
	// Started is false until the session runs `qar release-progress --start`.
	Started bool     `json:"started"`
	Line    *RunLine `json:"line"`
	Step    string   `json:"step"`
	Note    string   `json:"note"`
	// Position is the 1-based place of the current line in the plan, 0 on a step.
	Position     int            `json:"position"`
	Done         int            `json:"done"`
	Total        int            `json:"total"`
	Counts       map[string]int `json:"counts"`
	StartedAt    string         `json:"startedAt"`
	At           string         `json:"at"`
	RemainingSec int            `json:"remainingSec"`
}

type progressFile struct {
	Line      string `json:"line"`
	Step      string `json:"step"`
	Note      string `json:"note"`
	StartedAt string `json:"startedAt"`
	At        string `json:"at"`
	// Set by `qar release-progress --resume`.
	ResumedAt    string `json:"resumedAt"`
	DoneAtResume int    `json:"doneAtResume"`
}

// minDoneForEstimate: the first lines (baseline, a sign-in) say little about the pace.
const minDoneForEstimate = 5

func runGroup(l RunLine) string {
	switch l.Section {
	case "baseline":
		return "Baseline"
	case "security":
		return "Security"
	}
	g, _, _ := strings.Cut(l.ID, ".")
	role := l.Role
	if role != "" {
		role = strings.ToUpper(role[:1]) + role[1:]
	}
	setup := "no study"
	if l.Needs != "" && l.Needs != "none" {
		setup = "study: " + strings.ReplaceAll(l.Needs, "-", " ")
	}
	return fmt.Sprintf("%s · %s · %s", g, role, setup)
}

func readRunLines(dir, env string) ([]RunLine, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "run-plan-lines-"+env+".json"))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Lines []RunLine `json:"lines"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	for i := range parsed.Lines {
		parsed.Lines[i].Group = runGroup(parsed.Lines[i])
	}
	return parsed.Lines, nil
}

type loggedResult struct {
	Result string
	Title  string
}

// The latest result per line, as release-results reads it: a retest replaces.
func readRunResults(dir, env string) (map[string]loggedResult, error) {
	f, err := os.Open(filepath.Join(dir, "results-"+env+".jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]loggedResult{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	byID := map[string]loggedResult{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var entry struct {
			ID     string `json:"id"`
			Result string `json:"result"`
			Title  string `json:"title"`
		}
		// A line being appended can be half-written when the panel polls; skip it.
		if json.Unmarshal(scanner.Bytes(), &entry) == nil && entry.ID != "" {
			byID[entry.ID] = loggedResult{Result: entry.Result, Title: entry.Title}
		}
	}
	return byID, scanner.Err()
}

func runProgress(dir, env string, now time.Time) (RunProgress, error) {
	out := RunProgress{Counts: map[string]int{}}
	lines, err := readRunLines(dir, env)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.Total = len(lines)

	raw, err := os.ReadFile(filepath.Join(dir, "progress-"+env+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	var p progressFile
	if err := json.Unmarshal(raw, &p); err != nil {
		return out, err
	}
	out.Started = true
	out.Step, out.Note, out.StartedAt, out.At = p.Step, p.Note, p.StartedAt, p.At

	results, err := readRunResults(dir, env)
	if err != nil {
		return out, err
	}
	for i := range lines {
		if lines[i].ID == p.Line {
			out.Line = &lines[i]
			out.Position = i + 1
		}
		// A result logged for another title is from before a plan edit gave this id
		// to a different check (src/engine/release-run-log.ts currentResults).
		r, ok := results[lines[i].ID]
		if ok && (r.Title == "" || r.Title == lines[i].Title) {
			out.Done++
			out.Counts[r.Result]++
		}
	}
	// After a resume the pace counts only this session's lines: the earlier session's
	// lines were done at another time, maybe days before.
	since, doneBefore := p.StartedAt, 0
	if p.ResumedAt != "" {
		since, doneBefore = p.ResumedAt, p.DoneAtResume
	}
	out.RemainingSec = remainingEstimate(since, doneBefore, out.Done, out.Total, now)
	return out, nil
}

// The time left at the pace since `since`, when `doneBefore` lines already had a
// result. 0 means "no estimate yet".
func remainingEstimate(since string, doneBefore, done, total int, now time.Time) int {
	start, err := time.Parse(time.RFC3339, since)
	doneHere := done - doneBefore
	if err != nil || doneHere < minDoneForEstimate || done >= total {
		return 0
	}
	perLine := now.Sub(start).Seconds() / float64(doneHere)
	return int(perLine * float64(total-done))
}

// ReleaseRunProgress is what the Run phase's progress panel shows.
func (a *App) ReleaseRunProgress(tag, env string) (RunProgress, error) {
	dir, err := releaseDir(tag)
	if err != nil {
		return RunProgress{}, err
	}
	if env != "staging" && env != "production" {
		return RunProgress{}, errors.New("a release runs against staging or production")
	}
	return runProgress(dir, env, time.Now())
}

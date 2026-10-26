package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The engine reads JIRA_BOARDS and MANAGEMENT_APP_REPO from config/settings.json;
// Go keeps its own constants because they are used before settings load. This
// test is what stops the two from drifting.
func TestSharedConfigMatchesSettingsJSON(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "config", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]string
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if got := cfg["MANAGEMENT_APP_REPO"]; got != managementAppSlug {
		t.Fatalf("MANAGEMENT_APP_REPO %q != managementAppSlug %q", got, managementAppSlug)
	}
	if got := cfg["JIRA_BOARDS"]; got != strings.Join(jiraBoards, ",") {
		t.Fatalf("JIRA_BOARDS %q != jiraBoards %q", got, strings.Join(jiraBoards, ","))
	}
}

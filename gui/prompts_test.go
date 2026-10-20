package main

import (
	"strings"
	"testing"
)

func TestPromptTemplate(t *testing.T) {
	// A trailing newline would submit the PTY message early, so every template's
	// is trimmed.
	t.Run("trims the template's trailing newline", func(t *testing.T) {
		if got := prompt("companion", map[string]string{"suite": "x"}); strings.HasSuffix(got, "\n") {
			t.Fatalf("template ends with a newline: %q", got)
		}
	})

	t.Run("substitutes every occurrence of a placeholder", func(t *testing.T) {
		got := composeAuthoringPrompt("qa", "", "researcher", "do a thing")
		if strings.Count(got, "researcher") != 2 {
			t.Fatalf("role not substituted in both spots:\n%s", got)
		}
		if strings.Contains(got, "{{") {
			t.Fatalf("unsubstituted placeholder left behind:\n%s", got)
		}
	})

	t.Run("leaves no placeholders in any composed prompt", func(t *testing.T) {
		for _, p := range []string{
			composeAuthoringPrompt("qa", "42", "researcher", "i"),
			composeValidationPrompt("qa", "42", "OTTER-1", "i"),
			composeCompanionPrompt("create-study"),
		} {
			if strings.Contains(p, "{{") {
				t.Fatalf("unsubstituted placeholder:\n%s", p)
			}
		}
	})
}

func TestPromptTarget(t *testing.T) {
	if got := promptTarget("qa", ""); got != "--env qa" {
		t.Fatalf("env target wrong: %q", got)
	}
	if got := promptTarget("qa", "42"); got != "--pr 42" {
		t.Fatalf("PR target wrong: %q", got)
	}
	// A whitespace-only PR is not a PR — it must not shadow the env.
	if got := promptTarget("qa", "   "); got != "--env qa" {
		t.Fatalf("blank PR should fall back to env: %q", got)
	}
}

// A newline INSIDE a template is as bad as a trailing one: claude's TUI treats the
// text before it as a submitted message, so the session sees only the tail. The
// validation prompt shipped multi-line once and the session asked for the card it
// had already been given.
func TestPromptTemplatesAreSingleLine(t *testing.T) {
	entries, err := promptFS.ReadDir("prompts")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		data, err := promptFS.ReadFile("prompts/" + e.Name())
		if err != nil {
			t.Fatal(err)
		}
		if strings.ContainsAny(strings.TrimRight(string(data), "\r\n"), "\r\n") {
			t.Errorf("%s contains a line break inside the prompt", e.Name())
		}
	}
}

// The user's own text comes from a textarea, so a composed prompt must stay on one
// line even when the template, the PR caveat and the instructions are all joined.
func TestComposedPromptsAreSingleLine(t *testing.T) {
	multiLine := "first line\r\nsecond line\nthird\rfourth"
	for name, p := range map[string]string{
		"authoring":          composeAuthoringPrompt("qa", "42", "researcher", multiLine),
		"validation with PR": composeValidationPrompt("qa", "42", "OTTER-1", multiLine),
		"validation by PR":   composeValidationPrompt("qa", "42", "", multiLine),
		"validation, no PR":  composeValidationPrompt("qa", "", "OTTER-1", multiLine),
		"companion":          composeCompanionPrompt("create-study"),
	} {
		if strings.ContainsAny(p, "\r\n") {
			t.Errorf("%s prompt contains a line break: %q", name, p)
		}
	}
}

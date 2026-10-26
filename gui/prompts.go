package main

import (
	"embed"
	"strings"
)

// The opening messages we submit to each Claude session live as markdown under
// prompts/ so they can be edited as prose instead of as Go string concatenation.
// They're compiled into the binary, so there's nothing extra to ship.
//
//go:embed prompts/*.md
var promptFS embed.FS

// prompt reads an embedded prompt template and substitutes `{{key}}` placeholders
// from vars. The trailing line ending every file ends with is trimmed — these are
// submitted as a single PTY message, and a stray CR or LF would send it early.
// Panics on a missing file: the templates are embedded, so absence is a build
// error, not a runtime condition.
func prompt(name string, vars map[string]string) string {
	data, err := promptFS.ReadFile("prompts/" + name + ".md")
	if err != nil {
		panic(err)
	}
	out := strings.TrimRight(string(data), "\r\n")
	for k, v := range vars {
		out = strings.ReplaceAll(out, "{{"+k+"}}", v)
	}
	return out
}

// composeAuthoringPrompt is claude's first message: invoke the qa-explore skill
// with the env/role/instruction. The browser is launched but NOT logged in — login
// is deferred, so the skill logs in as `role` on start via `qar session-login`.
func composeAuthoringPrompt(env, pr, role, instruction string) string {
	return prompt("authoring", map[string]string{
		"target":      promptTarget(env, pr),
		"role":        role,
		"instruction": flattenLines(instruction),
	})
}

// composeValidationPrompt is the validation Claude's first message: invoke the
// qa-validate skill with the env/PR target + Jira card. The browser is open but
// NOT logged in — the skill infers the role from the ticket and logs in itself.
// Any user-supplied `instructions` are appended as a separate final paragraph.
//
// With no `jiraCard` (the tester gave only a PR and inferJiraCard couldn't find a
// key in it) we switch to the by-PR template, which asks Claude to identify the
// ticket from the PR before validating.
func composeValidationPrompt(env, pr, jiraCard, instructions string) string {
	var out string
	if strings.TrimSpace(jiraCard) == "" {
		out = prompt("validation-by-pr", map[string]string{
			"target": promptTarget(env, pr),
			"pr":     strings.TrimSpace(pr),
		})
	} else {
		out = prompt("validation", map[string]string{
			"target":   promptTarget(env, pr),
			"jiraCard": jiraCard,
		})
	}
	// The PR caveat sets expectations that only hold on a PR preview, so the
	// validator doesn't read an empty dashboard as a regression or sit waiting on
	// results that will never arrive. It also names the repo explicitly: the session
	// runs in the qa-review checkout, so a bare `gh` command would resolve THERE, not
	// against the PR under test.
	if strings.TrimSpace(pr) != "" {
		out += " " + prompt("pr-env-caveat", map[string]string{
			"pr":   strings.TrimSpace(pr),
			"repo": managementAppSlug,
		})
	}
	if s := flattenLines(instructions); s != "" {
		out += " Additional instructions from the user: " + s
	}
	return out
}

// composeCompanionPrompt is the companion Claude's first message: invoke the
// qa-run-companion skill for the suite whose run is on screen. The browser is the
// live run browser (driven by the engine; Claude drives it only when idle).
func composeCompanionPrompt(suite string) string {
	return prompt("companion", map[string]string{"suite": suite})
}

// flattenLines joins user text onto one line. The whole prompt is typed into the
// PTY as ONE message, and claude's TUI submits on a CR or LF, so a line break in
// the user's text would leave the session with only the tail of the prompt.
func flattenLines(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// promptTarget renders the engine's target flag — a PR preview overrides the env.
func promptTarget(env, pr string) string {
	if strings.TrimSpace(pr) != "" {
		return "--pr " + pr
	}
	return "--env " + env
}

// composeReleasePlanPrompt opens a release-plan session: build the plan for `tag`.
func composeReleasePlanPrompt(tag string) string {
	return prompt("release-plan", map[string]string{"tag": strings.TrimSpace(tag)})
}

// composeReleaseRunPrompt opens a release-run session against one env.
func composeReleaseRunPrompt(tag, env string) string {
	return prompt("release-run", map[string]string{
		"tag": strings.TrimSpace(tag),
		"env": strings.TrimSpace(env),
	})
}

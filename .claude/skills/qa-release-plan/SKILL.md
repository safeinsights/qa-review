---
name: qa-release-plan
description: Build the regression plan for one management-app release — completeness lines per PR, a security review of the diff, and documentation for PMs and developers — then keep it in sync with the user's edits and save it as a release asset. Use inside the QA Runner's Release tab.
---

# qa-release-plan

You write the **regression plan** for one management-app release. The plan is a
markdown file the user edits beside you; when they are satisfied, you upload it to
the GitHub release. You run **interactively in a terminal** — plain language, ask
when unsure.

## The environment you're in
- The repo is at **`$QAR_REPO_DIR`** and is your working directory. The CLI is
  **`qar`** (a shim on PATH). A browser is open but you do not need it for this.
- The prompt names the **tag** (e.g. `v1.6.9`). Everything for it lives under
  **`.tmp/release/<tag>/`**. The GUI editor shows `plan.md` from that directory
  and reloads it when you write it.
- **`gh`** is available (pre-approved) for PR diffs.

## Plan already exists
If the opening prompt says the plan already exists, skip Phases 1–3 and begin at
Phase 4 after running `qar plan-lines` and reporting its counts.

## Keeping the session smooth
- **Never prefix a command with `cd`.**
- **Write every scratch file under `.tmp/release/<tag>/`.**
- **One command per Bash call.** Pre-approved: `qar …`, `gh …`, and read-only
  `mkdir`/`ls`/`cat`/`date`/`echo`, plus Read/Write/Edit and the Agent tool.
- **Never post to Jira** and never write to management-app except through
  `qar release-upload`.
- **Re-read `plan.md` before every edit.** The user edits the same file.

## Phase 1: the PR set
`qar release-prs --tag <tag>` writes `prs.json`: the previous tag, every PR in the
tag compare (number, title, author, Jira keys, files, body), and `notesMissing` —
PRs the release notes omit. The release page is NOT the source: v1.6.9 listed 43
of 63 PRs. If `notesMissing` is not empty, the Technical appendix must list them.

## Phase 2: one subagent per PR
Dispatch subagents with the Agent tool, **6 at a time**, one per PR. Each one gets
the PR number, the tag, the repo (the `MANAGEMENT_APP_REPO` value in
`config/settings.json`), and this task, with `<n>`, `<tag>` and `<repo>`
substituted before dispatch:

> Read `gh pr view <n> --repo <repo> --json title,body,files` and `gh pr diff <n>
> --repo <repo>`. If the PR has a Jira key, read the card with the jira-atlassian
> MCP (`jira_get_issue`) for its acceptance criteria. Write
> `.tmp/release/<tag>/pr-<n>.json`:
> `{ number, impact, plainSummary, technicalSummary, testLines: [{ title, steps, stagingOnly }],
>   securityNotes: [{ title, probe, stagingOnly }], jiraCriteria: [] }`.
> - `impact`: `high`, `medium` or `low`. `high` = a user-visible behaviour
>   change, a data migration, an auth or permission change, or a security
>   fix; `medium` = a visible UI change with no behaviour change, an email
>   change, an admin-only change; `low` = a dependency bump, CI, lint, docs,
>   tests only.
> - `plainSummary`: 1–3 sentences a PM understands. What changed for a user.
> - `technicalSummary`: files, migrations, flags, routes, env vars, jobs.
> - `testLines`: 1–4 concrete checks that the change IS in the build, each
>   with the steps a tester follows and what they see. A dependency bump
>   gets one line: "app still loads". `stagingOnly: true` when the steps
>   create or change data or send bad input.
> - `securityNotes`: anything in the diff touching auth, sessions, input
>   parsing, redirects, file upload, SQL, secrets, logging, CORS, headers.
>   `probe` says how to test it. `stagingOnly: true` when the probe writes
>   data or sends bad input — those never run on production.
> Keep the file under 300 lines. Do not edit any other file.

The `repo` is `MANAGEMENT_APP_REPO` from `config/settings.json`. A PR whose
`pr-<n>.json` already exists is skipped (a retry after a crash reuses them).

## Phase 3: write `plan.md`
Merge the `pr-<n>.json` files into `.tmp/release/<tag>/plan.md` with EXACTLY these
sections, in this order, as `##` headings:

```
# Regression plan <tag>

## Summary
<plain language, by feature, for PMs — from the plainSummary fields, grouped; high-impact items first>

## Baseline
- [BASELINE] Run release-happy-path — qar run --suite release-happy-path --env <env>

## Changes
### #<n> <title> (<jira keys>) [<impact>]
- [R-<n>-1] <title> — <steps and what the tester sees>

## Security
- [S-1] <title> — <probe> (staging only)
- [S-2] <title> — <read-only check>
PRs reviewed with no finding: #a, #b, …

## Technical appendix
### #<n> <title>
<technicalSummary, Jira links>
### PRs missing from the release notes
#…, #…
```

Every test line is `- [ID] <title> — <steps>` with an em dash. IDs: `R-<pr>-<n>`
under its own `### #<pr>` heading, `S-<n>` in Security. A line that writes data
or sends bad input ends with **`(staging only)`**. An `R-` line whose
`stagingOnly` is true also ends with `(staging only)`. Write the Baseline line
literally, with `--env <env>`; the run skill substitutes the env it runs against. The Summary lists feature groups with the high-impact items first. The Changes
section is ordered by impact (high, medium, low), then by PR number within an
impact; each `### #<pr>` heading ends with the impact in brackets, e.g.
`### #1110 OTTER-794: migrations … [high]`. The Technical appendix stays in
PR-number order.

Then `qar plan-lines --input .tmp/release/<tag>/plan.md --tag <tag>`. It must
print `"ok":true`. If it lists problems, fix the plan and run it again. Do not say
"ready" before it passes. Then report: PRs, plus `lines`, `security` and `stagingOnly` from that JSON, and
`notesMissing` from `release-prs` — and wait.

## Phase 4: edit together
- The user may edit `plan.md` in the editor; **Read it again before any edit**.
- After every edit you make, run `qar plan-lines` again and report the result.
- Never upload or edit the release unless the user says "save the plan".
- A request you cannot satisfy inside the five sections: explain why, do not
  add a sixth section.

## Phase 5: save
When the user says "save the plan" (the GUI's Save button sends exactly that):
1. `qar plan-lines --input .tmp/release/<tag>/plan.md --tag <tag>` — must print `"ok":true`.
2. `qar release-upload --tag <tag> --file .tmp/release/<tag>/plan.md --as regression-plan.md`
3. `qar release-summary --tag <tag>` — copies the Summary section into the release description so the release page says what changed; prints `placement`.
4. `qar release-saved --tag <tag> --asset regression-plan.md --url <url>` (the `url` key of the JSON step 2 printed)
5. Show the asset URL.
If step 1 fails, show the problems and stop; nothing is uploaded.

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
- **`gh pr view` and `gh pr diff`** are pre-approved for reading PRs.

## Plan already exists
If the opening prompt says the plan already exists, skip Phases 1–3 and begin at
Phase 4 after running `qar plan-lines` and reporting its counts.

## Keeping the session smooth
- **Never prefix a command with `cd`.**
- **Write every scratch file under `.tmp/release/<tag>/`.**
- **One command per Bash call.** Pre-approved: every `qar` command whose name
  starts with `release-`, `qar plan-lines`, `qar plan-order`, `qar results-check`,
  `qar results-render`, `gh pr view`, `gh pr diff`, the Jira MCP's
  `jira_get_issue`, read-only `mkdir`/`ls`/`cat`/`date`/`echo`, plus
  Read/Write/Edit and the Agent tool.
- **Never post to Jira** and never write to management-app except through
  `qar release-upload` and `qar release-summary`.
- **management-app is public, and so is every release asset.** The Security
  section stays in the local `plan.md`; `release-upload` strips it.
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
> MCP: `jira_get_issue` with `fields` set to
> `summary,status,description,issuelinks` and `comment_limit` 100. The defaults
> leave out the links and stop at 10 comments. From the card take:
> - the acceptance criteria;
> - the latest QA validation comment, if there is one. A qa-review validation ends
>   with "Posted by qa-review <version>" and gives each criterion a result (PASS,
>   FAIL, NOT TESTED) and a verdict;
> - the follow-up cards: links to other cards, and keys that the validation names
>   for a FAIL ("follow-up", "tracked as"). Read each follow-up's status with
>   `jira_get_issue` (`fields` `summary,status`).
>
> Write `.tmp/release/<tag>/pr-<n>.json`:
> `{ number, impact, plainSummary, technicalSummary,
>   testLines: [{ title, steps, role, needs, endsStudy, stagingOnly }],
>   securityNotes: [{ title, probe, stagingOnly }], jiraCriteria: [],
>   knownIssues: [{ criterion, qaResult, followUp, followUpStatus, currentBehaviour }] }`.
> - `knownIssues`: each criterion the QA validation did not PASS and that was moved
>   to a follow-up card. `currentBehaviour` is what QA saw instead.
> - A known issue whose follow-up is not Done: its test line expects the current
>   behaviour, not the criterion. Start `steps` with
>   `Known issue <follow-up key>:` and describe what the tester sees today. The run
>   passes the line while the app still behaves that way, and fails it only when
>   something else changes, so the area is still checked for new breakage.
> - A known issue whose follow-up is Done: the fix may be in this release. Write a
>   normal line for the criterion and name the follow-up key in `steps`.
> - A criterion that failed on QA with no follow-up is not a known issue: write a
>   normal line, and say in `technicalSummary` that QA failed it.
> - `impact`: `high`, `medium` or `low`. `high` = a user-visible behaviour
>   change, a data migration, an auth or permission change, or a security
>   fix; `medium` = a visible UI change with no behaviour change, an email
>   change, an admin-only change; `low` = a dependency bump, CI, lint, docs,
>   tests only.
> - `plainSummary`: 1–3 sentences a PM understands. What changed for a user.
> - `technicalSummary`: files, migrations, flags, routes, env vars, jobs.
> - `testLines`: 1–4 concrete checks that the change IS in the build, each
>   with the steps a tester follows and what they see. A dependency bump
>   gets one line: "app still loads", with `role` researcher and `needs` none,
>   so all of them land in one group and the run checks once.
>   - If the check needs what the run's browser does not have — Sentry, the
>     Coder admin CLI, an email inbox, an SMS phone, a second account of one
>     role, two tabs open at the same time, or data from before the release —
>     start `steps` with `Requires <what>.` The run asks about these lines
>     before it starts.
>   - Never change a shared account's security key, password, MFA or org role,
>     or a live data partner's code environments or data sources: other testers
>     and CI use them. Write the check for a new invited user, or for an
>     environment the check creates and then deletes. Never write a step that
>     the app says cannot be undone (for example adding a Test Lab).
>   - Do not name ids, people or records from one env (a QA study id, a QA
>     member). Say what the check needs ("a study whose results were encrypted
>     before this release"), so it runs on any env.
>   - Write a signed-out check as "with no session", not "in a private window".
>     A check of the sign-in screens uses a new invited user, so nobody types a
>     shared account's password.
>   - `role`: `admin`, `researcher` or `reviewer` — who is signed in.
>   - `needs`: `none`, or the study stage the check needs: `proposal-draft`,
>     `proposal-submitted`, `proposal-approved`, `code-submitted`,
>     `code-changes-requested`, `code-approved`, `results-ready`,
>     `results-approved`. Use the earliest stage at which the check works.
>   - `endsStudy: true` when the check leaves the study unable to move on (it
>     rejects the proposal, deletes the study, or similar).
>   - `stagingOnly: true` only when the steps send bad input. A check that
>     creates data runs on production too: it uses natural titles and
>     descriptions, and the run deletes the data at the end.
> - `securityNotes`: anything in the diff touching auth, sessions, input
>   parsing, redirects, file upload, SQL, secrets, logging, CORS, headers.
>   `probe` says how to test it. `stagingOnly: true` when the probe writes
>   data or sends bad input — those never run on production.
> Keep the file under 300 lines. Do not edit any other file.

The `repo` is `MANAGEMENT_APP_REPO` from `config/settings.json`. A PR whose
`pr-<n>.json` already exists is reused (a retry after a crash) only if it parses
as JSON, its `impact` is one of `high`, `medium`, `low`, every test line has
a `role` and a `needs` from the lists above, AND it has a `knownIssues` array
(empty when the PR has no card or the card has no QA validation; a file written
before this field existed did not read the comments). Otherwise dispatch
that PR's subagent again and overwrite the file. Never default a missing
`impact`, `role` or `needs`: a guessed value silently puts the check in the
wrong place in the run.

## Phase 3: write `plan.md`
Merge the `pr-<n>.json` files into `.tmp/release/<tag>/plan.md` with EXACTLY these
sections, in this order, as `##` headings:

```
# Regression plan <tag>

## Summary
<plain language, by feature, for PMs — from the plainSummary fields, grouped; high-impact items first>

## Baseline
- [BASELINE] Run release-happy-path — the QA Runner runs it when a run starts

## Changes
### <g>. <Role> · <no study | study with …>
- <g>.<n> <title> — <steps and what the tester sees> ([PR #<pr>](<url>))

## Security
- [S-1] <title> — <probe> (staging only)
- [S-2] <title> — <read-only check>
PRs reviewed with no finding: #a, #b, …

## Technical appendix
### [#<n>](<url>) <title>
<technicalSummary, Jira links>
Known issues: <criterion> — QA <qaResult>, follow-up <key> (<status>); … (only when knownIssues is not empty)
### PRs missing from the release notes
#…, #…
```

**The plan reads in the order it is run**, for you and for a person who runs it
by hand. The Changes section is a list of run groups. Each group heading names
the role and the study setup; its lines run one after the other.

- A group heading is `### <g>. <Role> · <setup>`. `<Role>` is `Admin`,
  `Researcher` or `Reviewer`. `<setup>` is `no study` or `study with <label>`,
  where the label for each `needs` is:
  - `proposal-draft`: `a draft proposal`
  - `proposal-submitted`: `a submitted proposal`
  - `proposal-approved`: `an approved proposal`
  - `code-submitted`: `submitted code`
  - `code-changes-requested`: `code changes requested`
  - `code-approved`: `approved code`
  - `results-ready`: `results to review`
  - `results-approved`: `approved results`
- A Changes line is `- <g>.<n> <title> — <steps> ([PR #<pr>](<url>))` with an
  em dash. `<url>` is `https://github.com/<repo>/pull/<pr>`. Add
  `(ends the study)` when `endsStudy` is true, and `(staging only)` when
  `stagingOnly` is true, before the PR link.
- Write one group per `role` and `needs` pair, in any order, with any numbers.
  Inside a group, put high-impact lines first. Then run
  `qar plan-order --input .tmp/release/<tag>/plan.md`. It sorts the groups so
  one study moves through its stages with the fewest sign-ins, gives a study of
  its own to each check that ends one, writes the `> Next:` steps between the
  groups and the `> Last:` cleanup step, numbers every line and links every PR.
  Do not write the `> Next:` lines yourself, and do not sort by hand.
- Baseline and Security lines are `- [ID] <title> — <steps>`. Write the
  Baseline line literally. IDs in Security are `S-<n>`. An S- line whose probe
  writes data or sends bad input ends with **`(staging only)`**.
- The Summary lists feature groups with the high-impact items first and links
  every PR it names: `[#<pr>](<url>)`. The Technical appendix stays in
  PR-number order, with each heading linked.

Then `qar plan-lines --input .tmp/release/<tag>/plan.md --tag <tag>`. It must
print `"ok":true`. It reads `prs.json` beside the plan and enforces completeness:
every PR in `prs.json` needs at least one Changes line (`PR #n has no test
line`), and every Changes line needs its PR in the release (`<g>.<n> <title>:
PR #n is not in the release`). If it lists problems, fix the plan and run it
again. Do not say
"ready" before it passes. Then report: PRs, plus `lines`, `security` and `stagingOnly` from that JSON,
`notesMissing` from `release-prs`, the Changes lines whose steps start with
`Requires` (by id, with what each one requires), and the lines whose steps start
with `Known issue` (by id, with the follow-up key) — and wait.

## Phase 4: edit together
- The user may edit `plan.md` in the editor; **Read it again before any edit**.
- After every edit to Changes, by you or by the user, run `qar plan-order`, then
  `qar plan-lines`, and report the result. A line the user added without a
  number gets one from `plan-order`. If `plan-order` refuses, it names the line
  it would drop: ask the user where that text belongs.
- After any other edit, run `qar plan-lines` again and report the result.
- Never upload or edit the release unless the user says "save the plan".
- A request you cannot satisfy inside the five sections: explain why, do not
  add a sixth section.

## Phase 5: save
When the user says "save the plan" (the GUI's Save button sends exactly that):
1. `qar plan-order --input .tmp/release/<tag>/plan.md`, then `qar plan-lines --input .tmp/release/<tag>/plan.md --tag <tag>` — must print `"ok":true`.
2. `qar release-upload --tag <tag> --file .tmp/release/<tag>/plan.md --as testing-plan.md`
   — the asset is `testing-plan.md`. The Security section is stripped on upload,
   because management-app is public; `plan.md` keeps it. `stripped` in the output
   says whether there was one.
3. `qar release-summary --tag <tag>` — copies the Summary section into the
   release description so the release page says what changed. It prints `placement`.
4. `qar release-saved --tag <tag> --asset testing-plan.md --url <url>` — `<url>`
   is the `url` key printed by step 2.
5. Show the asset URL.
If step 1 fails, show the problems and stop; nothing is uploaded.

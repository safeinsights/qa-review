---
name: qa-release-run
description: Execute a saved regression plan for a management-app release against staging or production — run the baseline suite, drive the browser through every plan line, gate the results, and upload them to the release. Use inside the QA Runner's Release tab.
---

# qa-release-run

You execute a **regression plan** that is already on the GitHub release. The GUI
has already run the baseline suite; you record its result, drive a **live
browser** through every Changes and `[S-…]` line, record one result per line, and
upload the results as a release asset.

## The environment you're in
- A browser is **already launched but NOT logged in**. Drive it with the
  **`chrome-devtools` MCP tools** — do NOT launch your own browser.
- The repo is at **`$QAR_REPO_DIR`** and is your working directory. The CLI is
  **`qar`**. The prompt names the **tag** and the **env** (`staging` or
  `production`). Everything lives under **`.tmp/release/<tag>/`**.
- Log in with `qar session-login --role <role>`; switch roles the same way.

## Keeping the session smooth
- **Never open a new chrome instance or page.**
- **Never prefix a command with `cd`.**
- **Write every scratch file under `.tmp/release/<tag>/`.**
- **One command per Bash call.** Pre-approved: every `qar` command whose name
  starts with `release-`, `qar plan-lines`, `qar results-check`,
  `qar results-render`, `qar session-login`, `qar cleanup`, `gh pr view`/`gh pr diff`, read-only
  `mkdir`/`ls`/`cat`/`date`/`echo`, Read/Write/Edit, the chrome-devtools MCP tools
  and the Jira MCP's `jira_get_issue`.
- **Never run `qar run`.** The GUI ran the baseline before this session started.
- **Never post to Jira on your own.** The results go to the release only.
- **Production is real, and the run may create data there.** Everything you
  create (studies, users, orgs, files) gets a natural title and description, as
  a real user would write it — never "test", "QA" or "asdf". Write each id to
  `.tmp/release/<tag>/created-<env>.json` as you create it, and delete all of
  it at the end (Phase 3, last step). A line marked `(staging only)` sends bad
  input and is NOT TESTED on production.
- **management-app is public, and so is every release asset.** Security lines and
  their results never leave this machine.

## Phase 1: the plan
1. `qar release-download --tag <tag> --remote-only` — lands as
   `.tmp/release/<tag>/remote/testing-plan.md`. It never touches `plan.md`, which
   someone may be editing.
2. On **staging**, check whether the local plan exists: `ls .tmp/release/<tag>/plan.md`.
   The asset has no Security section; the S- lines are only in that local file.
   - It exists: `qar plan-lines --input .tmp/release/<tag>/remote/testing-plan.md --tag <tag> --security-from .tmp/release/<tag>/plan.md --output .tmp/release/<tag>/run-plan-lines-<env>.json`
   - It does not exist, or the env is **production**: `qar plan-lines --input .tmp/release/<tag>/remote/testing-plan.md --tag <tag> --output .tmp/release/<tag>/run-plan-lines-<env>.json`
   It must print `"ok":true`. If it fails, show the problems and stop.
3. Report the `lines`, `changes`, `security` and `stagingOnly` values from that
   output. On staging with no local plan, say that the security lines cannot run
   from this machine. Wait for the user's go.

## Phase 2: the baseline
Read `.tmp/release/<tag>/baseline-<env>.json`
(`{passed, steps, failedStep, error, reportPath, finishedAt}`). Record the
`BASELINE` line: PASS with `reportPath` as evidence when `passed` is true;
otherwise FAIL with `severity`, `area`, and `failedStep` and `error` in the
evidence. If the file is missing, record `NOT TESTED` with `approvedBy: "gui"`
and evidence "the baseline did not run". **A failed baseline does not stop the
run**; the other lines still need results.

## Phase 3: the lines
The plan is in run order. Go from top to bottom; do not reorder.

- Each `### <g>. <Role> · <setup>` group names who is signed in. When the role
  changes from the group before, switch with `qar session-login --role <role>`.
  `run-plan-lines-<env>.json` carries the same `role` and `needs` per line.
- A `> Next:` line between groups is a setup step, not a test line. Do it in
  the browser, as the role it names, before the next group. It creates the
  study or moves it to the next stage. `Next, with a new study:` means create
  another study for the group below it; the study before it was ended on
  purpose. If a setup step fails, every line that needs that study is
  `NOT TESTED` with `approvedBy: "setup"` and the failure in evidence; go on
  with the lines that do not need it.

For each line, skip `BASELINE` (Phase 2 recorded it):
- On **production**, a `stagingOnly` line is `NOT TESTED` with
  `approvedBy: "plan"` and evidence `"staging only"`. Do not run its probe.
- S- lines run on **staging only**, and only when Phase 1 merged them from the local
  `plan.md`.
- Otherwise follow the line's steps in the browser. Take a screenshot of the
  decisive screen into `.tmp/release/<tag>/shots/<id>.png`.
- One result per line: `PASS`, `FAIL` (with `severity` blocker|major|minor and
  `area`), or `NOT TESTED` (with `approvedBy` — the user's name when they told
  you to skip it). `evidence` names what you saw and the screenshot path.
  Never put a credential in evidence.

Last, the `> Last:` step: delete everything in `created-<env>.json`. Sign in as
admin (`qar session-login --role admin`), read an admin token in the browser
with `evaluate_script`:
```js
async () => (await window.Clerk.session.getToken({ skipCache: true })) ?? ''
```
and run `qar cleanup --env <env> --token <jwt> --studies <ids> --users <ids>`.
A 404 means already deleted. Report any id that did not delete, by name.

## Phase 4: gate, render, upload
1. Write `.tmp/release/<tag>/results-<env>.json` as `{"results":[…]}`.
2. `qar results-check --inventory .tmp/release/<tag>/run-plan-lines-<env>.json --results .tmp/release/<tag>/results-<env>.json --env <env>`
   — must print `"ok":true`. Fix every listed gap first.
3. `qar results-render --tag <tag> --env <env> --plan .tmp/release/<tag>/run-plan-lines-<env>.json --results .tmp/release/<tag>/results-<env>.json`
   — prints `{"output","asset","securityOutput"}`. `output` has no S- line.
4. `qar release-upload --tag <tag> --file <output>` — `<output>` is the `output`
   key printed by `results-render`. Never upload `securityOutput`.
5. `qar release-saved --tag <tag> --asset <asset> --url <url>` — `<asset>` is the
   `asset` key printed by `results-render`; `<url>` is the `url` key printed by
   `release-upload`.
6. If `securityOutput` is not empty, `cat` it and show the security results to the
   runner here in the terminal. It stays on this machine.
   Only if the runner asks for it, file one Jira card with them: `qar jira-create-issue --project <board> --summary "<tag> security results" --body-file <securityOutput>`.
7. Report the counts and the asset URL. Then stop.

---
name: qa-release-run
description: Execute a saved regression plan for a management-app release against staging or production — run the baseline suite, drive the browser through every plan line, gate the results, and upload them to the release. Use inside the QA Runner's Release tab.
---

# qa-release-run

You execute a **regression plan** that is already on the GitHub release. You run
the baseline suite, then drive a **live browser** through every `[R-…]`/`[S-…]`
line, record one result per line, and upload the results as a release asset.

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
- **One command per Bash call.** Pre-approved: `qar …`, `gh …`, and read-only
  `mkdir`/`ls`/`cat`/`date`/`echo`, plus Read/Write/Edit and the chrome-devtools
  MCP tools.
- **Never post to Jira.** The results go to the release only.
- **Production is real.** Create nothing there except what the baseline suite
  creates and deletes. A line marked `(staging only)` is NOT TESTED on production.

## Phase 1: the plan
1. `qar release-download --tag <tag>` — lands as `.tmp/release/<tag>/plan.md`.
2. `qar plan-lines --input .tmp/release/<tag>/plan.md --tag <tag>` — must print
   `"ok":true`. If it fails, the saved plan is broken: show the problems and stop.
3. Report the `lines`, `changes`, `security` and `stagingOnly` values from that
   output, and wait for the user's go.

## Phase 2: the baseline
`qar run --suite release-happy-path --role researcher --env <env>`. It prints a
`report:` path. Record the `BASELINE` line: PASS with the report path as
evidence, or FAIL with `severity`, `area`, and the failed step name. **A failed
baseline does not stop the run**; the other lines still need results.

## Phase 3: the lines
After the user's go, run `qar session-login --role researcher` first. The lines
say when another role is needed; switch with the same command.

For each line in `plan-lines.json`, in order, skip `BASELINE` (Phase 2 recorded it):
- On **production**, a `stagingOnly` line is `NOT TESTED` with
  `approvedBy: "plan"` and evidence `"staging only"`. Do not run its probe.
- Otherwise follow the line's steps in the browser. Take a screenshot of the
  decisive screen into `.tmp/release/<tag>/shots/<id>.png`.
- One result per line: `PASS`, `FAIL` (with `severity` blocker|major|minor and
  `area`), or `NOT TESTED` (with `approvedBy` — the user's name when they told
  you to skip it). `evidence` names what you saw and the screenshot path.
  Never put a credential in evidence.

## Phase 4: gate, render, upload
1. Write `.tmp/release/<tag>/results-<env>.json` as `{"results":[…]}`.
2. `qar results-check --inventory .tmp/release/<tag>/plan-lines.json --results .tmp/release/<tag>/results-<env>.json --env <env>`
   — must print `"ok":true`. Fix every listed gap first.
3. `qar results-render --tag <tag> --env <env> --plan .tmp/release/<tag>/plan-lines.json --results .tmp/release/<tag>/results-<env>.json`
   — prints `{"output","asset"}`.
4. `qar release-upload --tag <tag> --file <output>` — `<output>` is the `output`
   key printed by `results-render`.
5. `qar release-saved --tag <tag> --asset <asset> --url <url>` — `<asset>` is the
   `asset` key printed by `results-render`; `<url>` is the `url` key printed by
   `release-upload`.
6. Report the counts and the asset URL. Then stop.

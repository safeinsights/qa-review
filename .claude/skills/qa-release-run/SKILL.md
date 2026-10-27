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
- **Write each result as soon as you have it**, with `qar release-result` (Phase 3).
  A long run can stop at any time, and a result that is only in the conversation is
  lost when it does.
- **Tell the GUI what you are doing.** The runner watches a progress panel above the
  browser. It reads what `qar release-progress` writes, so run it at each change
  (Phases 2–4). The runner can also click and type in the browser. If they do, wait
  for them to say they are done before you go on.

## Shared accounts and disposable users
The admin, researcher and reviewer accounts are shared by every tester and by CI.
- **Never change a shared account's** security key, password, MFA or org role. A key
  reset replaces the account's public key, and the results key in settings then
  stops decrypting results for everyone. A line that needs one of these changes
  runs on a disposable user, or it is `NOT TESTED` with the runner's approval.
- **Never type a shared account's password.** It would be in the transcript. For a
  check of the sign-in screens themselves (a wrong password, the MFA picker, the
  back link, page layout), sign in as a disposable user.
- **Never change a live data partner's** code environments or data sources that
  studies use. Create your own (natural name, testing image) and delete it.
- **Never do what the app says cannot be undone** (for example "Add Test Lab": "This
  selection cannot be reversed") unless the runner approves it.

To make a disposable user:
- **With a security key:** `qar session-create-user --role researcher|reviewer`. It
  prints `{userId, email}`.
- **Without a key, or to see the MFA enrolment screens:** `qar invite --role
  researcher|reviewer` prints an `inviteUrl`. Sign out (account menu > Log out),
  open the URL, choose Create New Account and give a natural first and last name.
  On the authenticator screen, read the setup key from the page and get codes with
  `qar totp --secret <key>`. Keep the key in `.tmp/release/<tag>/`, never in
  evidence. The user id is in the `__session` cookie: decode the JWT payload and
  read `userMetadata.user.id`.
- Write every user id to `created-<env>.json` at once.

## Browser constraints
- **Sign out with the account menu's Log out.** `window.Clerk.signOut()` from
  `evaluate_script` can hang the tool for two minutes.
- **A TOTP code works once.** Clerk refuses a code it already accepted. If you type
  a code by hand and need another for the same account, wait for the next 30 s
  window. `qar session-login` waits by itself.
- **"Signed out" or "in a private window":** do not sign out the session. Use
  `evaluate_script` with `fetch(url, { credentials: 'omit' })` and read the status,
  the final URL and the body.
- **"Opens in a new tab":** check the link's `href` and `target="_blank"`, then open
  the `href` in the same tab and check the page.
- **Two tabs at the same time** (for example "look at tab B without reloading"):
  this session cannot do it. Ask the runner in Phase 1.

## Phase 1: the plan
1. `qar release-download --tag <tag> --remote-only` — lands as
   `.tmp/release/<tag>/remote/testing-plan.md`. It never touches `plan.md`, which
   someone may be editing.
2. On **staging**, check whether the local plan exists: `ls .tmp/release/<tag>/plan.md`.
   The asset has no Security section; the S- lines are only in that local file.
   - It exists: `qar plan-lines --input .tmp/release/<tag>/remote/testing-plan.md --tag <tag> --security-from .tmp/release/<tag>/plan.md --output .tmp/release/<tag>/run-plan-lines-<env>.json`
   - It does not exist, or the env is **production**: `qar plan-lines --input .tmp/release/<tag>/remote/testing-plan.md --tag <tag> --output .tmp/release/<tag>/run-plan-lines-<env>.json`
   It must print `"ok":true`. If it fails, show the problems and stop.
3. Read every line's steps and list the lines this session cannot do:
   - steps that start with `Requires` (the plan skill marks access the browser
     does not have: Sentry, the Coder admin CLI, an email inbox, an SMS phone, a
     second account of one role, data from before the release);
   - lines that need two tabs at the same time;
   - lines that change a shared account or do something the app cannot undo (see
     "Shared accounts and disposable users"), when no disposable user can stand in;
   - lines that name data from another env (for example a QA study id) that the
     target env does not have.
4. Check for an earlier run: `qar release-progress --tag <tag> --env <env> --status`.
   When `done` is more than 0, an earlier session left results. Then also run
   `qar deployed-release --env <env>` and compare its `label` with the tag:
   - Same release: offer to resume — "`<done>` of `<total>` lines already have
     results (`<counts>`), last written `<loggedAt>`. Resume, or start fresh?"
     Name the `stale` lines, if any: the plan changed since, and they will be
     tested again.
   - Another release: say that the env was redeployed since and the earlier
     results test a different build. Recommend starting fresh.
5. Report the `lines`, `changes`, `security` and `stagingOnly` values from that
   output, the list from step 3, and an estimate of the time: about 70 lines an
   hour for the no-study groups, much less for the study groups (a code run in the
   enclave can take many minutes). On staging with no local plan, say that the
   security lines cannot run from this machine. Ask which of the step 3 lines to
   skip, and whether to run all of the plan or only some groups. Wait for the
   user's go. Each skipped line is `NOT TESTED` with `approvedBy` set to the
   runner's name and the reason in evidence.

## Phase 2: the baseline
First start the run log. For a new run:
`qar release-progress --tag <tag> --env <env> --start` — it keeps any earlier run's
log under a stamped name. When the runner chose to resume:
`qar release-progress --tag <tag> --env <env> --resume` — it keeps the log. Then
`qar release-progress --tag <tag> --env <env> --line BASELINE --note "Recording the baseline result"`.

Read `.tmp/release/<tag>/baseline-<env>.json`
(`{passed, steps, failedStep, error, reportPath, finishedAt}`). Record the
`BASELINE` line with `qar release-result` (Phase 3): PASS with `reportPath` as evidence when `passed` is true;
otherwise FAIL with `severity`, `area`, and `failedStep` and `error` in the
evidence. If the file is missing, record `NOT TESTED` with `approvedBy: "gui"`
and evidence "the baseline did not run". **A failed baseline does not stop the
run**; the other lines still need results.

## Phase 3: the lines
The plan is in run order. Go from top to bottom; do not reorder. The GUI ran the
baseline again for this session, so record `BASELINE` again on a resume too: the
new result replaces the old one.

**On a resume**, skip every line that is not in `remaining` from the `--status`
output. The study does not carry over: the earlier session deleted its study at
cleanup, or left it at an unknown stage. So at the first group with a study that
still has a remaining line, create a new study and do every `> Next:` step from the
first study group down to that group, as setup only: run no test lines on the way.
Write the new study's id to `created-<env>.json`.

- Each `### <g>. <Role> · <setup>` group names who is signed in. When the role
  changes from the group before, switch with `qar session-login --role <role>`.
  `run-plan-lines-<env>.json` carries the same `role` and `needs` per line.
- A `> Next:` line between groups is a setup step, not a test line. Do it in
  the browser, as the role it names, before the next group. It creates the
  study or moves it to the next stage. `Next, with a new study:` means create
  another study for the group below it; the study before it was ended on
  purpose. If a setup step fails, every line that needs that study is
  `NOT TESTED` with `approvedBy: "setup"` and the failure in evidence; go on
  with the lines that do not need it. Before a setup step, run
  `qar release-progress --tag <tag> --env <env> --step setup --note "<what it does>"`.

For each line, skip `BASELINE` (Phase 2 recorded it):
- Before you start the line, run
  `qar release-progress --tag <tag> --env <env> --line <id> --note "<what you do first>"`.
  Run it again with a new `--note` when the line has a long wait (a workspace
  launch, an enclave run), so the runner sees why nothing moves.
- On **production**, a `stagingOnly` line is `NOT TESTED` with
  `approvedBy: "plan"` and evidence `"staging only"`. Do not run its probe.
- S- lines run on **staging only**, and only when Phase 1 merged them from the local
  `plan.md`.
- Otherwise follow the line's steps in the browser. Take a screenshot of the
  decisive screen into `.tmp/release/<tag>/shots/<id>.png`.
- One result per line: `PASS`, `FAIL` (with `severity` blocker|major|minor and
  `area`), or `NOT TESTED` (with `approvedBy` — the user's name when they told
  you to skip it). `evidence` names what you saw and the screenshot path.
  Never put a credential in evidence. Write it before you start the next line:
  `qar release-result --tag <tag> --env <env> --id <id> --result PASS|FAIL|"NOT TESTED" --evidence "<text>"`,
  plus `--severity` and `--area` for a FAIL and `--approved-by` for a NOT TESTED.
  It refuses an entry that results-check would refuse; fix it and run it again. A
  second result for the same line replaces the first.
- A line whose steps start with `Known issue <key>:` checks a criterion that QA
  failed and moved to that follow-up card. Its steps describe the behaviour QA saw.
  PASS when the app still behaves that way, and name the key in evidence. FAIL
  when anything else breaks there. When the criterion now works as the card asked,
  PASS and say "the known issue <key> looks fixed" in evidence, so the follow-up
  can be checked.
- When the env does not have what a line needs (an empty table, no study from
  before the release), record what you could check and ask the runner whether to
  skip the rest; do not guess a PASS.
- Several lines can ask for the same check (for example "App still loads" for one
  role, once per dependency PR). Do the check once; give each line its own
  result with the same evidence.
- Code environments and data sources you create are not deleted by `qar
  cleanup`. Delete them in the UI as soon as their lines are done. Unlink a data
  source from its environment first: both delete buttons are disabled while
  they are linked.

Last, the `> Last:` step. Run `qar release-progress --tag <tag> --env <env> --step cleanup --note "Deleting what the run created"`,
then delete everything in `created-<env>.json`. Sign in as
admin (`qar session-login --role admin`), read an admin token in the browser
with `evaluate_script`, and give the tool a `filePath` under
`.tmp/release/<tag>/` so the token is not printed:
```js
async () => (await window.Clerk.session.getToken({ skipCache: true })) ?? ''
```
Run `qar cleanup --env <env> --token <jwt> --studies <ids> --users <ids>` with the
token from that file, then delete the file. The token lasts about a minute, so
read it just before the cleanup. A 404 means already deleted. Report any id that
did not delete, by name. Leave data you did not create (for example the
baseline's study) unless the runner tells you to delete it.

### When the runner stops the run early
1. Do the `> Last:` cleanup for everything created so far.
2. `qar release-results --tag <tag> --env <env> --stopped-by "<runner's name>"`.
   Every line with no result becomes `NOT TESTED`, approved by the runner, with
   the evidence "Run stopped by the runner before this line was tested."
3. Do Phase 4 steps 2, 3 and 6. Ask before steps 4 and 5: a mostly NOT TESTED
   result on a public release can look like a finished run.

## Phase 4: gate, render, upload
1. `qar release-progress --tag <tag> --env <env> --step report --note "Checking and writing the results"`,
   then `qar release-results --tag <tag> --env <env>`. It writes
   `results-<env>.json` in run order and refuses while a line has no result.
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

---
name: qa-validate
description: Validate that a Jira ticket has been implemented, by reading the ticket + its PR, driving a live browser (chrome-devtools MCP) to check its acceptance criteria, and posting a pass/fail verdict + screenshot to Jira. Use when given a Jira card + env inside the QA Runner's Validation session.
---

# qa-validate

You help a QA staff member confirm that a **Jira ticket has actually been
implemented** in a running SafeInsights environment. You read the ticket and its
GitHub PR, drive a **live browser** to check its acceptance criteria, and report a
clear PASS/FAIL verdict. On request you post your findings (a summary + a screenshot)
as a comment on the ticket and set its status. You run **interactively in a
terminal** — talk to the user in plain language, ask when unsure, and let them
approve actions.

## The environment you're in
- A browser is **already launched but NOT logged in** (the QA Runner ran
  `qar session` before you started; login is deferred). Drive it with the
  **`chrome-devtools` MCP tools** — do NOT launch your own browser.
- The **`jira-atlassian` MCP tools** are available for READING and for status
  changes: `jira_get_issue`, `jira_search`, `jira_update_issue`,
  `jira_get_transitions`, `jira_transition_issue`.
  **To post a comment, use `qar jira-comment`** (see "Posting findings" below) —
  the MCP's `jira_add_comment` cannot embed screenshots, and it has no way to
  delete a comment if you get one wrong.
- **`gh`** is available (pre-approved) to find + read the PR.
- The repo is at **`$QAR_REPO_DIR`** and **is already your working directory.**
  The engine CLI is **`qar`** — a shim on PATH that dispatches to the bundled engine
  (packaged) or `pnpm qar` (dev). Just run `qar …`.
- The prompt names the **target** (`--env <name>` or `--pr <n>`) and the **Jira
  card** (e.g. `OTTER-655`). The browser is on that environment, on the login page.

### If the target is a PR preview (`--pr <n>`)
A PR preview is a fresh deployment of that branch, so two things differ from QA —
neither is a bug, and both will look like one if you forget:
- **No studies are preloaded.** Every account's dashboard starts EMPTY. Create
  whatever a check needs from scratch (`qar session-create-study`, or
  `qar session-create-user` for a fresh user). An empty dashboard is NOT a
  regression and must not be reported as one.
- **PR environments do not actually run code.** There's no compute backend
  attached, so a submitted study never progresses to real results on its own. If a
  check needs a later state (results back, awaiting review, approved), set it
  directly with `qar study-state` — see below. Otherwise validate up to the point
  where execution would begin, and say so in the verdict.

## Keeping the session smooth (IMPORTANT — read before running anything)

- **Never open a new chrome instance or page.** Chrome is already running and the
  `qar` command will use the existing session.
- **Never prefix a command with `cd`** — you are already in `$QAR_REPO_DIR`.
- **Write every scratch file under `.tmp/`** (screenshots, verdict bodies, notes).
  It's gitignored; files written anywhere else pollute the user's `git status`.
- **One command per Bash call.** Chained/piped commands fall outside the allowlist
  and prompt. Pre-approved: `qar …`, `pnpm qar …`, `gh …`, `pnpm typecheck`,
  `pnpm test`, and read-only `mkdir`/`ls`/`cat`/`date`/`echo`, plus Read/Write/Edit
  and the chrome-devtools + jira-atlassian MCP tools.
- **Be quiet.** Do the work, then give a short plain-language result.

## What to do
1. **Read the ticket** with `jira_get_issue` for the named card. Extract the
   acceptance criteria / expected behavior.
2. **Find + read the PR** so you know what actually changed. Prefer the REST
   search endpoint:
   `gh api "search/issues?q=repo:safeinsights/management-app+<CARD>+type:pr" --jq '.items[] | {number, title, state, url: .html_url}'`
   (try another `repo:safeinsights/<repo>` if the ticket points elsewhere), then
   `gh pr view <n> --repo safeinsights/management-app --json title,body,files`.
   Use the changed files to focus your validation on what the ticket touched.
3. **Infer the role** the ticket concerns (`admin`, `researcher`, `reviewer`). If
   unclear, **ask the user**.
4. **Log in:** `qar session-login --role <role>` (deterministic Clerk + MFA on the
   shared browser). Wait for success. To validate a different role later, run it
   again with the new role.
5. **Verify the acceptance criteria in the browser** using the chrome-devtools MCP
   tools (navigate, click, fill, snapshot to read the page). Confirm each criterion
   actually holds by reading the resulting page. Keep the user informed.
6. **State a verdict** — a clear PASS or FAIL with concise reasoning tied to the
   acceptance criteria (which held, which didn't, what you saw).

## Creating a fresh user or study — use the built-in commands (do NOT hand-drive)
Creating a new user or study from scratch is fiddly (invite → email → MFA → recovery
→ security key; org-select → language → the Lexical fields). Do NOT rediscover these
selectors through the chrome-devtools MCP. Two commands run the **exact tested flow
on the SAME browser you're validating in** (the one streamed in the Validation pane)
and print the created id as JSON so you can clean it up afterward:

- **`qar session-create-user --role researcher|reviewer`** — logs the session in as
  admin, mints an invite through the QA API for the org implying the role, and
  completes the full signup from its URL. Prints `{"userId":"…","email":"…"}`.
  (The invited role is the org: researcher→openstax-lab, reviewer→openstax. It ends
  logged in as the NEW user — run `qar session-login --role <r>` if you then need a
  specific role.) The invite URL comes back from the API, so there is no email wait.
- **`qar session-create-study`** — logs the session in as researcher and submits a
  full study proposal. Prints `{"studyId":"…"}`.
- **`qar study-state --study <id> …`** — put a study into a later lifecycle state
  WITHOUT waiting on an enclave run (which takes minutes on QA and never happens at
  all on a PR preview). Combine any of:
  `--status <APPROVED|ARCHIVED|CHANGE-REQUESTED|DRAFT|PENDING-REVIEW|REJECTED>`,
  `--job-status <RUN-COMPLETE|JOB-RUNNING|…>`, `--result <file>`, `--log <file>`.
  Omitted fields are untouched. Example — land on "results are back, awaiting review":

  ```
  qar study-state --study <id> --job-status RUN-COMPLETE --result results.csv
  ```

  Attached files are sent as PLAINTEXT and encrypted server-side to the reviewing
  org, so that org needs a results public key enrolled — if you get
  `no public keys enrolled`, run `qar fix-account --role reviewer --env <env>` first.
  Artifacts attach to the study's LATEST job, so the study must already have one
  (i.e. it was submitted).

Track the printed ids and clean them up when done — see "Cleaning up created
users/studies" below (cleanup needs an admin token you read from the browser).

These reuse the same helpers the suites use, so a change to the flow updates both.

### Reference (only if you must drive a step by hand)
The underlying flows live in `src/engine/flows/{signup,study}.ts` (exact
`getByRole`/`getByLabel` names, the study-id URL pattern, the Lexical fields);
`src/suites/{signup,study-happy-path}.ts` are the suites they came from. For the
page-free bits, these pre-approved `qar` helpers exist too:
- `qar invite --role researcher|reviewer` → mints an invite via the QA API and prints
  `{"inviteUrl":"…","email":"…"}` — no inbox, no email wait. Prefer this over the
  mail helpers for any user you need to CREATE.
- `qar totp --secret <base32>` → prints the current 6-digit MFA code.
- `qar mail-inbox` / `qar mail-wait --address <addr>` → the real-email path (fresh
  mail.tm address; wait for the invite email and print its signup URL). Only needed
  when you are specifically testing that invitation emails are delivered — the
  `signup` suite covers that flow end to end.

If a shared account's password or results key has drifted from settings (login fails,
or results won't decrypt), `qar fix-account --role <r> --env <e>` pushes the settings
values back onto the account. It prompts before writing.

## Posting findings to Jira (button-driven or on request)
When the user presses **Validated** / **Rejected** (or asks you in the session):
1. Capture a screenshot of the relevant screen(s) with the chrome-devtools MCP,
   saving to **`.tmp/`** in the repo (create it with `mkdir -p .tmp` if needed).
   Everything you write during a session — screenshots, the verdict `.md` below —
   goes there: it's gitignored, so session output never shows up as untracked noise
   in the user's `git status`. Never scatter files at the repo root.
2. **Confirm with the user before writing to Jira.**
3. **Post the comment with `qar jira-comment`** — NOT `jira_add_comment`. Write the
   verdict (what you tested, the result, the reasoning) to a `.md` file under
   `.tmp/`, then:
   ```
   qar jira-comment --issue <CARD> --body-file .tmp/<name>.md --images .tmp/a.png,.tmp/b.png
   ```
   It uploads each screenshot, resolves its media id, and posts ONE comment with the
   images **embedded inline**. Images append after the body; put `{{image:1}}` /
   `{{image:2}}` in the body to place them mid-text instead. It prints
   `{"id","url"}` — give the user the URL.

   **The body is Markdown** — it's converted to Jira's ADF, so use formatting:
   `##` headings, `**bold**`, `*italic*`, `` `code` ``, `-` bullet lists, and
   `[text](url)` links all render. (Do NOT use the MCP's `jira_add_comment` for a
   comment with screenshots: it can only emit text, so image syntax renders as
   LITERAL TEXT — upstream bug mcp-atlassian#608.)

   If you post something wrong, remove it yourself rather than leaving it for the
   user: `qar jira-delete-comment --issue <CARD> --ids <id1,id2>`.

   **Auth:** `qar jira-comment` reads the Jira site/email/token from the GUI's saved
   settings (Settings → Jira), so it normally needs no env vars. Only if a command
   fails with `Missing JIRA_USERNAME`/`JIRA_API_TOKEN` (settings not filled in) do you
   need to supply it inline — e.g. `JIRA_USERNAME=<their-atlassian-email> qar
   jira-comment …`. That email is their **Atlassian account email**, often NOT their
   git email; ask if you don't know it (or tell them to set it in Settings).
4. **Transition the ticket** — resolve the transition by NAME (ids vary) via
   `jira_get_transitions` then `jira_transition_issue`:
   - **Validated** → transition to **"Final Review - EM & PM"**.
   - **Rejected** → **un-assign** (`jira_update_issue(fields='{"assignee": null}')`)
     AND transition to **"Development"**.
5. **Tell the GUI the verdict is posted** so it hides the Verdict button and shows the
   outcome — run `qar verdict-posted --issue <CARD> --result <validated|rejected>`.
   Do this AFTER the comment + transition succeed, whether the user pressed the
   Verdict button or asked you directly.
6. **Clean up** anything you created (studies/users) — see "Cleaning up" below.

## Cleaning up created users/studies (you have everything you need — don't get stuck)
Delete every user/study you created. `qar cleanup` needs a **Clerk session JWT** via
`--token` (the QA delete endpoints require an **admin** Bearer token; a cookie does
NOT work). You do NOT need the user to supply it — read it from the streamed browser
while it's logged in as **admin**:

1. **Be logged in as admin.** If the session isn't already, run
   `qar session-login --role admin` (studies/users delete fine as admin; the study's
   owner FK means studies are removed before users automatically).
2. **Read a fresh token** from the authenticated page with the chrome-devtools MCP
   `evaluate_script` (same call the engine uses, `Clerk.session.getToken`):
   ```js
   async () => (await window.Clerk.session.getToken({ skipCache: true })) ?? ''
   ```
   (Clerk hydrates a beat after login — if it returns empty, wait ~1s and retry.)
3. **Delete**, passing that token:
   `qar cleanup --env <env> --token <jwt> --studies <ids> --users <ids>`
   (`--pr <n>` instead of `--env` for a PR target. Omit whichever of
   `--studies`/`--users` you don't need.) It reports per-id JSON; a 404 counts as
   already-gone (success). Only 403/500 mean a real failure — if you get 403, the
   token wasn't an admin one (re-read it while logged in as admin).

Never tell the user "cleanup needs a token I don't have" — fetch it as above.

## Rules
- Drive the EXISTING browser via chrome-devtools MCP; never open your own.
- Log in via `qar session-login --role <role>` — never hand-drive Clerk + MFA.
- Read the ticket/PR via the jira-atlassian MCP + `gh` — don't scrape them via the
  browser.
- To create a fresh user or study, use `qar session-create-user` /
  `qar session-create-study` (they run the tested flow on the streamed browser) —
  don't hand-drive signup/study creation through the MCP. The low-level
  `qar mail-inbox`/`mail-wait`/`totp` helpers are only for driving an individual step
  by hand when you must.
- **Never modify EXISTING users.** Do not add an existing user to a new org, and do
  not change any existing user's role. If a test needs a user in some org/role,
  create a NEW one with `qar session-create-user` (the invited role is implied by the
  org) — never repurpose the shared accounts or a previously-created user.
- **Always clean up every user/study you created** before ending — fetch the admin
  Clerk token from the browser yourself (see "Cleaning up"); don't leave test data on
  the env or ask the user for a token.
- Post Jira comments with `qar jira-comment` (embeds screenshots inline), never
  `jira_add_comment`. If a post comes out wrong, delete it with
  `qar jira-delete-comment` — don't leave a mess for the user to clean up, and
  don't repost variations hoping one renders.
- Always confirm before writing to Jira (comments, attachments, transitions,
  un-assign).

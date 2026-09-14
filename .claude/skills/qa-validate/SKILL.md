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
- The **`plugin:figma:figma` MCP tools** are available for reading any design the
  ticket links (`get_screenshot`, `get_variable_defs`, `get_metadata`) — see
  "Checking the implementation against linked Figma designs" below.
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
6. **Check any linked Figma design** against what you see in the browser — see
   "Checking the implementation against linked Figma designs" below. Look for the
   links in remote links, the description AND the comments.
7. **State a verdict** — a clear PASS or FAIL with concise reasoning tied to the
   acceptance criteria (which held, which didn't, what you saw), plus any design
   deviations reported separately from the criteria.

## Checking the implementation against linked Figma designs
If the ticket links a Figma design, the implementation must MATCH it — a feature can
satisfy every written acceptance criterion and still be wrong, because the design is
where the spacing, colors, copy and states actually live. Treat the design as a
source of criteria that the ticket text left implicit.

### 1. Find the design links
Figma links reach a ticket three ways, and **the description is the least common**:
- **Remote links** — what the Figma–Jira integration creates, and what a designer
  attaching a design from Figma produces. They are NOT in the description, and NOT
  in the default field set, so you will miss every one of them unless you ask:
  `jira_get_issue(issue_key=…, include='remote_links,comments')`.
- **The description** (`fields='description'`), as a pasted URL.
- **A comment** — often a later revision ("updated the empty state, see…"), which is
  why `comments` is in the call above. When comments disagree with the description,
  **the newest link wins**; say which one you validated against.

A design URL looks like
`https://figma.com/design/<fileKey>/<name>?node-id=<n1>-<n2>`. You need BOTH the
`fileKey` and the `node-id`.

**A link with no `node-id` is not usable — ask the user for a node-specific link.**
The Figma tools require a concrete node and will not accept a guessed one; a file
URL alone points at a whole document that may hold dozens of unrelated frames.
Guessing a node id and validating against the wrong frame produces confident,
completely fabricated findings — far worse than reporting the link as unusable.
Also skip `/make/`, `/board/` (FigJam) and `/slides/` URLs: they are not design
files, and `get_metadata`/`get_variable_defs` don't support them.

If the ticket links NO design, say so and validate the written criteria only. Do
not go hunting through Figma for a design that might be related.

### 2. Read the design
The `mcp__plugin_figma_figma__*` tools are available (the Setup Doctor's "Figma MCP"
row proves the server is connected and authenticated). Use these three:

- **`get_screenshot`** (`fileKey`, `nodeId`) — the rendered design frame. **Pass
  `enableBase64Response: true`.** By default it returns a short-lived URL and tells
  you to `curl` it, but figma.com and its asset host are NOT in the sandbox's
  `sandbox.network.allowedDomains`, so that curl fails with a bare transport error
  that names nothing (see CLAUDE.md, "The Claude command sandbox blocks four
  things"). The base64 form comes back through the MCP connection, which is not
  sandboxed. Raise `maxDimension` (default 1024) when you need to read fine detail
  like label text or a border.
- **`get_variable_defs`** (`fileKey`, `nodeId`) — the design tokens actually bound
  to that frame (`{'color/primary': '#0B5CD5', 'spacing/md': '16px'}`). This is what
  turns "the blue looks off" into "design binds `color/primary` **#0B5CD5**, the app
  renders **#1A73E8**" — a finding a developer can act on.
- **`get_metadata`** (`fileKey`, `nodeId`) — the frame's layer tree with names,
  positions and sizes. Use it to find the right child frame when one node holds
  several states (empty / loading / error), and to get exact pixel geometry.

Do **NOT** use `get_design_context`: it exists to GENERATE code from a design, it
requires loading the design-to-code skill first, and it returns a reference
implementation that is irrelevant here — you are comparing against code that
already exists, not writing new code.

Do not perform multiple simultaneous requests to Figma, and pause briefly between
them to avoid rate-limitations their API imposes.

### 3. Compare, at the right altitude
Put the browser on the corresponding screen and compare it to the design
screenshot. **Match the browser to the design's conditions before judging** — the
same viewport width (`resize_page`), the same state (populated vs. empty, the same
role, the same expanded/collapsed section). A design drawn at desktop width
compared against a narrow window produces a page of bogus layout findings.

Check, roughly in order of how much they matter:
1. **Structure & presence** — is every element in the design actually there, and in
   the same order/grouping? A missing control or a section in the wrong place is a
   real failure.
2. **Copy** — headings, labels, button text, empty-state and error messages, quoted
   exactly. Wrong wording is the most common and most checkable design miss.
3. **States** — the design usually specifies empty, loading, error, disabled and
   hover. Drive the app into each one the design shows, rather than validating only
   the happy path it was easiest to reach.
4. **Visual detail** — color, spacing, type size/weight, border radius, alignment.
   Back these with numbers from `get_variable_defs` and the computed values you read
   from the page (`evaluate_script` with `getComputedStyle`), not from eyeballing a
   screenshot.

**Judgment — this is the part to get right.** You are validating a ticket, not
running a pixel-diff. A design is a specification of INTENT, and normal
implementation carries legitimate variance:
- **Report**: missing or extra elements, wrong copy, missing states, a color or
  spacing token that is visibly and measurably wrong, anything that breaks the
  design's visual hierarchy or would be noticed by a user.
- **Do NOT report**: sub-pixel and one-or-two-pixel differences, font rendering
  between the browser and Figma, scrollbar width, placeholder/lorem content in the
  design, or a design element that is clearly a stale earlier revision.
- **When the design and the ticket text conflict, the TICKET wins** — and flag the
  conflict rather than failing the card for it. The design may simply predate a
  decision recorded in the ticket or its comments.

A design difference is a **separate class of finding from an acceptance-criterion
failure.** Unless the ticket makes the design itself a criterion ("matches the
attached design"), a visual deviation goes under "Design review" / "Also observed"
and does **not** by itself flip the verdict to REJECTED. If deviations are serious
enough that you think they should block, say so explicitly and **ask the user** —
they decide, not you.

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
  `no public keys enrolled`, enroll one with `qar fix-account --role reviewer --key
  --yes` (add `--pr <n>` on a PR preview, `--env <env>` otherwise) first. See
  "Results won't decrypt" below.
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
values back onto the account. Pass `--yes` to skip its confirm prompt — it reads the
answer from stdin, so without `--yes` it just hangs in this session.

### Results won't decrypt (expect this on a PR preview)
The reviewer decrypts results with the private key in settings; the app stores only
the matching PUBLIC key on the account. When those disagree, results are wrapped to a
key we can't unwrap and the reviewer's results view fails to decrypt (or
`study-state` reports `no public keys enrolled`).

**A PR preview is a fresh database**, so its accounts start with whatever public key
that env seeded — not ours. Assume the key needs pushing the first time you view
results on a PR:

```
qar fix-account --role reviewer --pr <n> --key --yes
```

`--key` pushes only the public key (omitting it would rewrite the password too).
Then re-run the step that reads results.

There is **no per-PR key to set**: PR previews reuse the QA key (`privateKeyEnvFor()`
maps anything that isn't staging/production to `qa`), which is why a PR run is
identical to a QA run except for the base URL. So this pushes the public half of
`<ROLE>_RESULTS_PRIVATE_KEY_QA` — nothing to configure per PR.

To inspect the private key itself (rare — `fix-account` derives the public half for
you, so you do NOT need this to fix drift), `qar get-secret` is the read half of
`set-secret`:

```
qar get-secret --name REVIEWER_RESULTS_PRIVATE_KEY_QA > .tmp/reviewer-qa.pem
```

The var is named with **`--name`, not `--key`** — `key` is listed valueless for both
secret commands, so `--key <VAR>` resolves to `true` and drops the name. Both reject
it outright rather than aliasing it (it used to encrypt under a var named "true" and
report success). Output carries no trailing newline
(a PEM stays byte-exact) and printing to a terminal is refused without `--force`, so
always redirect. Write it under `.tmp/` and **delete it when done** — this key
decrypts real study results, and leaving it on disk outlives the session that needed
it. (`.tmp/` and `*.pem` are both gitignored, so it won't reach a commit — but that
is not a reason to leave it lying around.)

Use `--pr <n>`, not `--env`, on a preview — `--env qa` would push the key to the
shared QA environment instead. Rotating a key orphans results already wrapped to the
old one; that's harmless on an ephemeral PR preview, but on `qa` or `staging` it
destroys other people's data — ask the user first there.

## Posting findings to Jira (button-driven or on request)
When the user presses **Validated** / **Rejected** (or asks you in the session):
1. Capture a screenshot of **all relevant screen(s)** with the chrome-devtools MCP,
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

   **Follow this template.** Every validation comment uses the same sections so the
   team can scan a card's history without re-reading prose, and so the verdict is
   never ambiguous:

   ```markdown
   ## VALIDATED ✅
   <!-- or: REJECTED ❌ -->

   Validated on **<env>** as a **<role>**, against PR [#<n>](<pr-url>).

   **Setup / replication steps followed:** <the state you had to build to get to
   the thing under test — created a study, submitted a decision, etc.>

   ### Acceptance criteria

   **1. <criterion, quoted from the ticket> — PASS**
   <what you observed that proves it: the exact text, the measured value, the
   state transition.>

   **2. <criterion> — FAIL**
   <what you observed instead, and why it doesn't satisfy the criterion.>

   {{image:1}}

   ### Design review
   <!-- Omit this section entirely when the ticket links no Figma design. -->
   Compared against [<design name>](<figma-url>) (node `<node-id>`).
   <What matched, then each deviation: what the design specifies vs. what the app
   renders, with values — "design binds `color/primary` **#0B5CD5**, the app renders
   **#1A73E8**". State plainly whether these are blocking; a deviation here does NOT
   flip the verdict unless the ticket made the design a criterion.>

   ### Also observed
   <Anything true but outside the criteria: extra changes the PR made, or a
   concern that is NOT blocking. Say explicitly that it isn't a failure. Omit
   this section when there's nothing.>

   ### Verdict
   <One or two sentences: which criteria held, on which env, and the call.>
   **VALIDATED.**
   ```

   Rules for filling it in:
   - **One numbered entry per acceptance criterion, in the ticket's order**, each
     tagged `— PASS` or `— FAIL`. A criterion you could NOT test gets its own
     `— NOT TESTED` entry saying why; never silently drop one.
   - **Evidence, not assertion.** "Reads: *'<exact string>'*" or "measured
     **40.00px**" — not "looks correct".
   - **Any FAIL makes the whole verdict REJECTED**, and the heading must say so.
   - Place `{{image:N}}` next to the criterion it evidences; screenshots with no
     specific home just append after the body.
   - Keep "Also observed" strictly separate from the criteria — a non-blocking
     note must never read as a failure.
   - **Name the design you compared against**, with its node-specific URL, so a
     reader can check the same frame. "Matches the design" without a link is not
     reviewable. If a linked design could NOT be checked (no `node-id`, a
     FigJam/Make URL), say that in this section rather than omitting it silently.

   If you post something wrong, remove it yourself rather than leaving it for the
   user: `qar jira-delete-comment --issue <CARD> --ids <id1,id2>`.

   **Auth:** `qar jira-comment` reads the Jira site/email/token from the GUI's saved
   settings (Settings → Jira), so it normally needs no env vars. Only if a command
   fails with `Missing JIRA_USERNAME`/`JIRA_API_TOKEN` (settings not filled in) do you
   need to supply it inline — e.g. `JIRA_USERNAME=<their-atlassian-email> qar
   jira-comment …`. That email is their **Atlassian account email**, often NOT their
   git email; ask if you don't know it (or tell them to set it in Settings).
4. **Transition the ticket** — resolve the transition by NAME (ids vary) via
   `jira_get_transitions` then `jira_transition_issue`. **Which move depends on the
   TARGET you validated against**, so establish that first (it's in the prompt as
   `--env <name>` or `--pr <n>`):

   | Target | Verdict | Move to | Assignee |
   |---|---|---|---|
   | **QA** | Validated | **"Final Review - EM & PM"** | un-assign |
   | **Staging** | Validated | **"Done"** | un-assign |
   | **QA or Staging** | Rejected | **"To Do"** | assign to the last person who worked it (below) |
   | **PR preview / production** | either | **do NOT transition** | leave as-is |

   - **A PR preview (`--pr <n>`) or production proves nothing about the shared
     envs** — a preview is a throwaway deployment with no seeded data, and
     production isn't where work gets signed off. Post the comment, then STOP:
     no transition, no assignee change. Tell the user you've commented only, and
     that moving the card needs a QA or Staging validation.
   - **Un-assign** with `jira_update_issue(fields='{"assignee": null}')`.

   **Finding who to assign on rejection.** The card is usually already un-assigned
   by the time it reaches QA, so read the history rather than the current field:
   `jira_get_issue(issue_key=…, include='changelog')`, then walk `changelogs`
   (newest first) for the most recent item with `field: "assignee"` and take its
   **`from_id`** — that's the accountId of whoever held it before it was cleared.
   Assign with `jira_update_issue(fields='{"assignee": {"accountId": "<id>"}}')`.

   Cross-check against the PR author (`gh pr view <n> --json author`) when a PR is
   known. If the changelog and the PR disagree, or the changelog has no assignee
   history at all, **ask the user** — a card silently assigned to the wrong person
   is worse than one left un-assigned, since nobody is watching an unexpected queue.
   A GitHub login is NOT a Jira accountId; never guess a mapping between them.
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
- Check any Figma design the ticket links (remote links, description, comments)
  against the implementation, and report deviations SEPARATELY from the acceptance
  criteria — a visual difference doesn't flip the verdict on its own unless the
  ticket made the design a criterion. Never guess a `node-id`; ask for a
  node-specific link instead of validating against a frame you picked.
- Always confirm before writing to Jira (comments, attachments, transitions,
  assigning/un-assigning).

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
- The **`plugin:figma:figma` MCP tools** are available. Annotations are read with
  `use_figma` running ONLY the fixed script `figma-notes.js` (a hook enforces it);
  `get_screenshot`/`get_metadata`/`get_variable_defs` stay available for layout —
  see "Reading Figma annotations" below.
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

## What to do — five phases

### Phase 1: Inventory (before login, before any test)
First find the PR and confirm its code is on the target:
`gh api "search/issues?q=repo:safeinsights/management-app+<CARD>+type:pr" --jq '.items[] | {number, title, state, url: .html_url}'`
(try another `repo:safeinsights/<repo>` if the ticket points elsewhere), then
`gh pr view <n> --repo safeinsights/management-app --json title,body,files,mergeCommit`.
Check the merge commit is in the release deployed on the target (the app's
release marker, or `gh` against the deploy branch). If it is not, stop and ask
whether to proceed. Use the changed files to focus the inventory.

Then build `.tmp/<CARD>-inventory.md`: ONE line per requirement, each with an
id, the text, and its source. Nothing is tested until the user approves this list.

1. **Card.** `jira_get_issue(issue_key=…, include='remote_links,comments', fields='*all')`.
   Every sub-requirement in the description is its own line — not one line per
   heading. Ids follow the card's structure (`RL.SubmittedBy.3`). OTTER-617 yields
   about 60 lines; if you have 10, you have summarised, not inventoried.
2. **Comments.** A decision in a comment changes or adds a line; the line names
   its source ("Iris 10/12: Last updated sorts both ways"). The newest decision wins.
3. **Attachments.** `qar jira-attachments --issue <CARD> --download` saves the text
   ones (a developer's test plan, a CSV of cases) under `.tmp/<CARD>-attachments/`.
   Read each; they add lines. Images are listed only.
4. **Figma.** See "Reading Figma annotations" below. Every annotation on every page
   that holds a linked node becomes a line, sorted by category.
5. **Conflicts.** When a card line and a Figma line disagree, merge them into ONE
   line marked CONFLICT. The app is checked against the card text.
6. Show the user a summary — line count, conflicts, absence checks, sources — and
   wait for approval. This replaces "state the acceptance criteria and plan".

### Phase 2: Test
Infer the role from the inventory (ask if unclear). `qar session-login --role <role>`.
Drive every line with the chrome-devtools MCP. Before you give up on a line, try the
standard methods: timezone/locale and network throttle (`emulate`), viewport
(`resize_page`), a forced request failure (`evaluate_script` wrapping `fetch`),
`qar study-state`, `qar session-create-study`, `qar session-create-user`.

### Phase 3: Classify
Each line gets exactly one result:

| Result | When | Effect |
|---|---|---|
| PASS | The app does what the line says | — |
| FAIL | The app does not, and card and Figma agree | REJECTED or follow-up cards (Phase 5) |
| CONFLICT | Card and Figma disagree | PM question; the app is checked against the card |
| UNCLEAR | The line can be read two ways | PM question; never PASS |
| NOT TESTED | You could not build the state, AND the user approved | — |

- A CONFLICT line is never also a FAIL.
- A line with no effect a user can see ("sorting is server-side") goes under
  "Also observed", not FAIL.
- **NOT TESTED needs the user's approval, per line, and should almost never
  happen.** Stop and ask, giving the line, the methods you tried, and ONE reason
  from: needs a real enclave run `study-state` cannot fake; needs a forbidden
  action (modify an existing user, rotate a key on a shared env); needs an
  external system (real email, a third party); needs time to pass; the code is
  not on the target. "Too much effort" is not a reason. The posted line reads
  `— NOT TESTED (confirmed by <user>)`. While any line is unresolved, no verdict.

### Phase 4: Report
Post with `qar jira-comment` using the template under "Posting findings". Write
for a PM with two minutes: the verdict, the counts, and their questions come
first; PASS rows are collapsed. **During the voice test (see "Voice test" under
"Posting findings"), post the same report three times, once in each voice.**

### Phase 5: Route the failures
Skip when there is no FAIL. Otherwise give each FAIL a severity — **blocker** (a
card-text criterion broken, wrong data, a user cannot finish the flow), **major**
(a state or behaviour a Figma annotation specifies is missing), **minor** (copy,
visual, component) — and an **area** (a short label; FAILs that one fix would
cover share an area). Write them to `.tmp/<CARD>-fails.json` as
`{"fails":[{"id","severity","area"}]}` and run
`qar followup-advice --input .tmp/<CARD>-fails.json`. Present the three options
with the returned recommendation and its reason, and let the user choose:

- **Comment and send back to dev** — `## REJECTED ❌`; transition to "To Do";
  assign the last person who worked the card (see "Transition the ticket").
- **One follow-up card** / **Multiple follow-up cards** — draft each card to
  `.tmp/<CARD>-followup-N.md` (summary; expected, quoting the source; observed;
  steps; screenshots). Show the drafts; the user approves or edits. Then, per
  approved draft:
  `qar jira-create-issue --project <CARD's project> --summary "<text>" --body-file .tmp/<CARD>-followup-N.md --images a.png,b.png --link <CARD>`
  (`--type` defaults to Bug, `--link-type` to Relates; both are verified first).
  The parent comment's heading is `## VALIDATED WITH FOLLOW-UPS ✅` and lists the
  new keys; the parent then moves as VALIDATED, and `qar verdict-posted` gets
  `--result validated`.

CONFLICT and UNCLEAR lines never become cards — they stay as questions.
On a PR preview: no Jira writes at all, so no cards (show the drafts instead).

## Reading Figma annotations

The design's rules live in **Dev Mode annotations** — per-column widths, reset
rules, states, "not ready for engineering" markers. `get_screenshot`,
`get_metadata` and `get_variable_defs` do NOT return them, and neither does the
REST API; only the Plugin API does. So annotations are read with
`mcp__plugin_figma_figma__use_figma` running ONE fixed, read-only script:
**`.claude/skills/qa-validate/figma-notes.js`**. A hook denies any `use_figma`
call whose code differs from that file in anything but its first two lines, so
there is no way to edit a design from this session — do not try to write your
own Plugin API code; it will be refused.

Before any Figma call, run `mcp__plugin_figma_figma__whoami`. If the SafeInsights
plan seat is View or Collab, stop and tell the user (those seats get 6 MCP calls a
month); do not read Figma.

### 1. Find the links
Figma links reach a ticket three ways: **remote links** (what the Figma–Jira
integration creates — invisible unless you ask with
`include='remote_links,comments'`), the **description**, and **comments** (often
a later revision; the newest wins — say which you used). A design URL is
`https://figma.com/design/<fileKey>/<name>?node-id=<a>-<b>`; the node id is
`<a>:<b>`. Skip `/make/`, `/board/` and `/slides/` URLs.

### 2. Read, with the fixed script
Send the file's contents as `code` with only the header lines changed:

1. `const MODE = 'pages'` / `const TARGET = ''` — every page in the file.
2. `const MODE = 'locate'` / `const TARGET = '<id1>,<id2>,…'` — ONE call for all
   linked node ids → each node's page.
3. `const MODE = 'page'` / `const TARGET = '<pageId>'` — one call per page that
   holds a linked node → every top-level frame with its annotation count.
4. `const MODE = 'frame'` / `const TARGET = '<frameId>'` — one call per
   top-level frame whose count is above zero → that frame's annotations (layer
   path, category, text). `use_figma` caps a result at 20 KB, which is why
   notes come one frame at a time rather than one page at a time.

Never edit `figma-notes.js` to get around a limit — the hook compares against
the file on disk, so an edited script is a disabled guard. If a mode you need
does not exist, stop and tell the user.

A link with no `node-id` is not a dead end: run `pages`, show the page names, and
ask the user which page to read. **Every frame on a read page is in scope**, not
just the linked ones — loading and error frames sit beside the linked frames and
their notes apply to the same table. Pause briefly between Figma calls.

### 3. Sort each annotation by category

| Category | Treatment |
|---|---|
| Development, Interaction, Accessibility, Design notes, Visual Inconsistencies, Notes for QA | An inventory line |
| NOT READY, NOT READY FOR DEV, NOT OTTER, JUST FOR MOCKUP | An **absence check**: the feature must NOT be in the app |
| IRIS NOTES, Concept Notes, DONE!, Transition, Transition - IN, Transition - OUT | Context only; not tested |
| anything else | Ask the user |

No category = Development. The same annotation shows up once per component
instance (the RL and DP tables share one); merge identical text into one line
that lists each frame. Every Figma line records page, frame and category, and
links the node: `https://figma.com/design/<fileKey>?node-id=<a>-<b>`.

### 4. Compare at the right altitude
Match the browser to the design's conditions first — viewport (`resize_page`),
state, role. Then check structure and presence, copy (quoted exactly), states
(drive the app into each one the notes describe), and visual detail backed by
numbers (`get_variable_defs`, `getComputedStyle`), not eyeballing. Do not report
sub-pixel differences, font rendering, scrollbar width, or placeholder content.
`get_screenshot` (pass `enableBase64Response: true`; figma.com is not in the
sandbox allowlist) and `get_metadata` remain useful for layout; never use
`get_design_context`.

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
   ## REJECTED ❌
   <!-- or: VALIDATED ✅  /  VALIDATED WITH FOLLOW-UPS ✅ -->
   **<env>** · release `<sha>` · PR [#<n>](<url>) · <roles>
   **<N> requirements:** <a> PASS · <b> FAIL · <c> CONFLICT · <d> UNCLEAR · <e> NOT TESTED
   Sources: card, <k> comments, <m> attachments, <j> Figma annotations on <p> pages
   → <c+d> decisions needed from {{mention}} (below). Follow-up cards: <keys or none>.
   <!-- when c+d = 0: "→ No decisions needed. Follow-up cards: <keys or none>." and no {{mention}} anywhere -->

   ### Decisions needed from PM
   <!-- Omit the section AND --mention when there are no CONFLICT/UNCLEAR lines. -->
   **1. <line id> — CONFLICT.** Card: *"<quote>"*. Figma (<page> / <frame>, <category>): *"<quote>"*.
   App today: <what it does>. **A** keep the card's behaviour · **B** follow Figma.
   **2. <line id> — UNCLEAR.** *"<quote>"* can mean <A> or <B>. App today: <…>. **A** / **B**.

   ### Failed
   **<line id> — FAIL (<severity>).** Expected (<source>): *"<quote>"*. Observed: <evidence>.
   {{image:1}}

   ### Not tested
   **<line id> — NOT TESTED (confirmed by <user>).** <reason>.

   {expand:Passed (<a>)}
   **<card section>**
   - <line id> — *"<quote>"*: <evidence>
   {expand}

   ### Also observed
   <true but outside the lines, explicitly not a failure. Omit when empty.>

   **Setup:** <state built: studies created, decisions submitted — and that they were deleted.>
   ```

   Rules:
   - The first five lines are the whole status for a busy PM; keep them to five.
   - Pass `--mention <reporter accountId>` (from `jira_get_issue` → `reporter.account_id`)
     ONLY when "Decisions needed" is non-empty, so the PM is notified exactly when
     they have something to answer.
   - **Evidence, not assertion**: quoted strings, measured pixels, state transitions.
   - Every inventory line appears exactly once, under one heading. Never drop one.
   - Any FAIL makes the heading REJECTED — unless the user chose follow-up cards,
     in which case it is VALIDATED WITH FOLLOW-UPS and the keys are listed.
   - Each Figma-sourced line names page, frame and category with a node link.
   - Never put `{{image:N}}` inside the `{expand:…}…{expand}` block — images are split out before expand blocks are parsed and the block would break. Screenshots belong with FAIL lines; PASS rows carry text evidence only.
   - Omit a section (and the expand block) when it has nothing in it.
   - When there are no CONFLICT/UNCLEAR lines, line 5 reads "No decisions needed", the
     `{{mention}}` token is removed, and `--mention` is not passed.

   If you post something wrong, remove it yourself rather than leaving it for the
   user: `qar jira-delete-comment --issue <CARD> --ids <id1,id2>`.

   **Voice test (temporary).** Readers disagree about the tone they want, so for
   now every validation posts the SAME report three times, once per voice, so
   the team can compare real examples and choose. Each of the three comments is a
   complete, true representation: the same sections, the same images (uploaded
   again for each post), and the same `--mention` — only the wording changes.
   Write the three bodies to `.tmp/<CARD>-verdict-ste.md`,
   `.tmp/<CARD>-verdict-conversational.md` and `.tmp/<CARD>-verdict-terse.md`, and
   post them in that order. Put a tag on the line directly after the heading:
   `_(voice: STE)_`, `_(voice: conversational)_`, `_(voice: terse)_`. Run the
   transition and `qar verdict-posted` once, after the third post. Give the user
   all three URLs. Once a voice is chosen, delete this block and keep one
   definition.

   - **STE** (ASD-STE100 Simplified Technical English): sentences of 20 words or
     fewer; one idea per sentence; active voice; one term for one thing, no
     synonyms; condition before instruction. Example FAIL line: *"The Reviewed by
     cell shows the proposal reviewer. The annotation says: reset to 'Not
     reviewed' at the code stage. Result: FAIL."*
   - **Conversational**: first person, full sentences, says what you tried and why
     it matters, one short paragraph per finding. Example: *"Reviewed by still
     shows Malar after the study moved to code review. The Figma note on that
     column says it should reset to 'Not reviewed', so I'm marking this a FAIL —
     it affects 53 of the 102 rows on the Openstax dashboard."*
   - **Terse**: fragments, no articles, one line per finding in the form
     `id — result — evidence`. Example: *"DP.ReviewedBy.3 — FAIL — 53/102 rows
     show prior-stage reviewer; Figma: reset at new stage."*

   The 5-line summary block keeps its exact format in every voice; the voice
   applies to everything below it.

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
   | **PR preview / production** | either | **post NOTHING to Jira** | leave as-is |

   - **A PR preview (`--pr <n>`) or production proves nothing about the shared
     envs** — a preview is a throwaway deployment with no seeded data, and
     production isn't where work gets signed off. Post NOTHING to Jira: no
     comment, no cards, no transition, no assignee change. Show the full report (and
     any follow-up drafts) to the user in the session. Tell them that moving the card
     needs a QA or Staging validation.
   - **VALIDATED WITH FOLLOW-UPS** moves the card as Validated does.
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
- Read Figma annotations only through `figma-notes.js` via `use_figma`; never send
  other Plugin API code (the hook denies it). Every annotation on a read page is an
  inventory line with page/frame/category and a node link.
- CONFLICT and UNCLEAR are PM questions, never PASS or FAIL. NOT TESTED needs the
  user's per-line approval and is very rare.
- Always confirm before writing to Jira (comments, attachments, transitions,
  assigning/un-assigning).

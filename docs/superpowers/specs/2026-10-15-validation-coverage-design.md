# Validation coverage — design

Date: 2026-10-15

## Problem

OTTER-617 was validated twice, and each validation missed different things.

The 10/08 pass reported VALIDATED. The PM then found that the "+ New study"
button showed on the Researcher tab of My studies. A Figma annotation marked
that button "Not ready for engineering". The pass also reported "Last updated
never sorts oldest first" as PASS, but the card did not say which behavior was
correct. The PM had to answer that question later.

The 10/13 pass reported REJECTED with 7 issues. It found these issues only after
a person told it to read the Figma annotations. The PM then disputed 3 of them:

- Issues 1 and 2 (Submitted by / Reviewed by reset) were card-vs-Figma
  conflicts. The comment listed them as FAIL **and** as conflicts. This breaks
  the skill's own rule that the ticket wins.
- Issue 6 (client-side sorting) has no effect that a user can see.

The causes, in the tooling and the skill:

1. **Annotations cannot be read with the tools the skill allows.**
   `get_screenshot`, `get_variable_defs` and `get_metadata` do not return Dev
   Mode annotations. The skill bans `get_design_context`. The Figma REST API
   does not return annotations either. Only the Plugin API (`use_figma`) does.
   A read-only probe on 2026-10-15 confirmed this: it returned 33 annotations
   on the "Org dashboards" page, and the file's 16 annotation categories.
2. **Only the linked frames are checked.** The loading and error frames sit next
   to the linked frames on the same page, but the card does not link them.
   `get_metadata` returned 1 of the file's 11 pages. `figma.root.children`
   returns all 11.
3. **Annotation categories are ignored.** The file has categories such as
   `NOT READY FOR DEV`, `NOT OTTER`, `JUST FOR MOCKUP` and `Notes for QA`. They
   change what must be tested.
4. **No full list of requirements.** The card has about 60 sub-requirements.
   The 10/08 pass reduced them to 10 criteria, so a reader cannot see what was
   not checked.
5. **Card attachments are not read.** For example, the developer's
   `manualtest617.md` test plan.
6. **NOT TESTED is too easy to use.** Of the 3 NOT TESTED items in the 10/13
   comment, 2 could be tested with the chrome-devtools tools (timezone
   emulation, request blocking).
7. **No follow-up cards.** The PM asked for a separate card for each failure,
   linked to the main card. The MCP's `jira_create_issue` stores markdown as
   literal text, cannot embed images, and cannot link issues.

## Goals

- Every requirement from the card, its comments, its text attachments and every
  annotation on the relevant Figma pages is listed, and gets exactly one result.
- A conflict or an unclear requirement is a question for the PM, never a FAIL
  or a PASS.
- NOT TESTED is very rare, and the user approves each one.
- Failures go to the place that the user selects: back to the dev, or to one or
  more linked follow-up cards.
- The validator cannot change a Figma file.

## Non-goals

- Reading Figma through the REST API or a Figma token. The REST API does not
  return annotations.
- Automatic pixel comparison.
- Changing the Verdict buttons in the GUI.

## Design

### 1. Reading Figma

#### Fixed read-only script

`.claude/skills/qa-validate/figma-notes.js` is the only code that the validator
sends to `mcp__plugin_figma_figma__use_figma`. Its first two lines are the only
lines that change:

```js
const MODE = 'pages'   // 'pages' | 'locate' | 'page'
const TARGET = ''      // node ids (comma-separated) for 'locate', page id for 'page'
```

- `MODE = 'pages'` returns every page (`id`, `name`). It does not switch pages.
- `MODE = 'locate'` finds each id in `TARGET` with `getNodeByIdAsync` and
  returns the node's name, type and page (`id`, `name`). One call covers every
  linked node, which keeps the Figma call count low (Dev seats have a daily
  limit).
- `MODE = 'page'` calls `setCurrentPageAsync` once for `TARGET`. It returns
  every top-level frame (`id`, `name`, `type`, annotation count), and each
  annotated node: the top-level frame name and id, the layer path, the node id,
  and each annotation's category label, text (`label` or `labelMarkdown`), and
  pinned property types.

The script only reads. It must not call any setter, `create*`, `remove`, or
`set*` method. It uses `'findAll' in node` before `findAll` (TEXT nodes at the
top level do not have it).

#### Guard hook

A `PreToolUse` hook in the committed `.claude/settings.json`, with matcher
`mcp__plugin_figma_figma__use_figma`, runs `.claude/hooks/figma-readonly.mjs`.

The hook reads the tool input from stdin. It removes the `MODE` and `TARGET`
lines from both `tool_input.code` and the script file, and normalizes line
endings and the trailing whitespace. Then:

- If the rest is identical, and `MODE` is `'pages'`, `'locate'` or `'page'`, and
  `TARGET` is empty (only for `'pages'`) or matches `^\d+:\d+(,\d+:\d+)*$`, it
  allows the call.
- Otherwise it denies the call, with the reason: "use_figma may only run
  .claude/skills/qa-validate/figma-notes.js unchanged (MODE and TARGET lines
  only)."

The comparison logic is in an exported pure function, so vitest can test it
without stdin.

The hook command is `"${QAR_NODE:-node}" "$CLAUDE_PROJECT_DIR/.claude/hooks/figma-readonly.mjs"`,
so the packaged app's node runs it and the path does not depend on the cwd. If
the script file is missing (a stale clone), the hook denies with a hint to
sync.

`gui/app.go` keeps `mcp__plugin_figma_figma` in `validationAllowedTools`. The
hook, not the allowlist, prevents writes.

#### "Figma seat" Doctor row

A new row after "Figma MCP", in `RunDoctor` (`gui/app.go`). It runs only when
the "Figma MCP" row is OK.

- Probe: `claude -p "Call the whoami tool." --allowedTools
  mcp__plugin_figma_figma__whoami --output-format stream-json --verbose`. The
  row reads the `tool_result` for `whoami` from the stream. It does not read the
  model's text.
- Parse, in `figmaSeatCheck(out string, err error) DoctorCheck`: find the plan
  whose `name` equals the constant `figmaPlanName = "SafeInsights"`.
  - `seat` is `Full` or `Dev`: OK. Detail: `SafeInsights — Dev seat (<email>)`.
  - `seat` is `View` or `Collab`: FAIL. Hint: "View and Collab seats get 6 Figma
    MCP calls per month. Ask a SafeInsights Figma admin for a Dev seat."
  - No SafeInsights plan: FAIL. Detail includes the account email. Hint: "Sign
    in to Figma with your SafeInsights account, then run `/mcp` to
    re-authenticate."
  - No `whoami` result, or the JSON does not parse: FAIL with the first lines of
    the output.

Figma does not count `whoami` against the rate limit, but the probe costs
about 5–10 seconds, and `AutoDoctorModal` runs the Doctor on each launch. So
the result is cached in `~/Library/Application Support/qa-runner/figma-seat.json`
(`{ email, plans, checkedAt }`) and reused for 24 hours. The Detail shows the
check time when the result comes from the cache. A failed probe is not cached.

### 2. Inventory

The skill gets a new Phase 1. It runs before login and before any test.

Before any Figma read, the validator calls `whoami`. On a View or Collab seat
on the SafeInsights plan, it stops and tells the user; it does not read Figma.

1. **Card.** Each sub-requirement in the description is one line. The ID
   follows the card's structure, for example `RL.SubmittedBy.3`.
2. **Comments.** A decision in a comment changes or adds a line, and the line
   names the source (for example "Iris 10/12: Last updated sorts both
   directions"). The newest decision wins.
3. **Attachments.** `jira_get_issue` lists attachments only when `fields`
   includes `attachment`, and no tool returns their content. A new command,
   `qar jira-attachments --issue <KEY> [--download]`, lists them and saves text
   attachments (`.md`, `.txt`) to `.tmp/<CARD>-attachments/`. The validator
   reads these, and they add lines. Images are listed only.
4. **Figma.** For each Figma link (remote links, description, comments), run
   `pages` mode once for each file and `locate` mode for each linked node. Then
   run `page` mode for each page that holds a linked node. All frames on that
   page are in scope, not only the linked frames. A link with no `node-id` is
   no longer rejected: the validator runs `pages`, shows the page names, and
   asks the user which page to read. The same annotation appears once for each
   instance of a component (the RL and DP tables share one), so lines with
   identical text are merged, and the line lists each frame. Each annotation is
   sorted by its category:

   | Category | Treatment |
   |---|---|
   | Development, Interaction, Accessibility, Design notes, Visual Inconsistencies, Notes for QA | Adds lines to the inventory |
   | NOT READY, NOT READY FOR DEV, NOT OTTER, JUST FOR MOCKUP | Adds an **absence check**: the feature must not be present |
   | IRIS NOTES, Concept Notes, DONE!, Transition, Transition - IN, Transition - OUT | Listed for context; not tested |
   | Any other category | The validator asks the user |

   An annotation with no category is treated as `Development`.
5. **Conflicts.** When a card line and a Figma line disagree, both become one
   line with the result CONFLICT. The app is checked against the card text.
6. The inventory goes to `.tmp/<CARD>-inventory.md`. The validator shows a
   summary (number of lines, conflicts, absence checks, sources). The user
   approves the inventory before testing starts. This replaces the current step
   "state the acceptance criteria and plan".

### 3. Classification

Each line gets exactly one result:

| Result | When | Effect on the verdict |
|---|---|---|
| PASS | The app does what the line says | — |
| FAIL | The app does not do what the line says, and the card and Figma agree | REJECTED, or follow-up cards (section 5) |
| CONFLICT | The card and Figma disagree | A question for the PM; the app is checked against the card |
| UNCLEAR | The line can have two meanings | A question for the PM; never PASS |
| NOT TESTED | The validator cannot create the necessary state, and the user approved | — |

Rules:

- A CONFLICT line is never also FAIL.
- A line with no effect that a user can see (for example "sorting is
  server-side") goes under "Also observed", not FAIL.

#### NOT TESTED

NOT TESTED must be very rare. Before the validator uses it, it must:

1. Try each standard method that applies:
   - timezone and locale (`emulate`),
   - viewport width (`resize_page`),
   - network throttle (`emulate`),
   - request failure or blocking (`evaluate_script` that wraps `fetch`, or the
     request tools),
   - `qar study-state`, `qar session-create-study`, `qar session-create-user`.
2. Stop and ask the user. The question gives the line, a reason from this list,
   and the methods that it tried:
   - needs a real enclave run that `study-state` cannot create,
   - needs a forbidden action (change an existing user, rotate a key on a
     shared environment),
   - needs an external system (real email delivery, a third-party service),
   - needs time to pass,
   - the code is not on the target.
3. Continue only after the user replies. The user can approve NOT TESTED,
   suggest a method, or tell the validator to try again.

A NOT TESTED line in the comment says `(confirmed by <user>)`. While a line is
not resolved, the verdict cannot be posted.

### 4. Report

Changes to the Jira comment template in `SKILL.md`. The goal is that a PM
gets the status in 5 lines and finds their questions without reading the rest.

- **Summary block** at the top, 5 lines maximum:

  ```
  ## REJECTED ❌
  QA · release e9b464a · PR #1133 · researcher, reviewer, admin
  58 requirements: 49 PASS · 2 FAIL · 4 CONFLICT · 1 UNCLEAR · 2 NOT TESTED
  Sources: card, 4 comments, 1 attachment, 33 Figma annotations on 2 pages
  → 5 decisions needed from @Iris (below). Follow-up cards: OTTER-901, OTTER-902.
  ```

- **"Decisions needed from PM"** directly after the summary. One numbered item
  for each CONFLICT and UNCLEAR line, written as an A/B question with both
  sources quoted, so the PM can reply "1A, 2B" in one comment. The section
  starts with a mention of the card's reporter (`reporter.accountId`, an ADF
  `mention` node), so Jira notifies them. The section and the mention are
  omitted when there are no such lines.
- **Then the FAIL lines** (with severity), then NOT TESTED.
- **PASS lines are collapsed** in an expand block, `{expand:Passed (49)}…{expand}`,
  grouped by card section. The default view shows only the summary, the
  decisions and the failures. `buildCommentAdf` gains an ADF `expand` node for
  that syntax, and `qar jira-comment` gains `--mention <accountId>` for the
  reporter mention.
- **Each Figma line names its source**: page, frame and category, with a
  node-specific link.
- The "Design review" section is removed. Figma lines follow the same rules as
  card lines.
- The full inventory is not posted. It stays in `.tmp/`.
- New heading for section 5's follow-up options: `## VALIDATED WITH FOLLOW-UPS ✅`.

### 5. Failures and follow-up cards

When there is one or more FAIL, the validator gives each FAIL a severity:

- **Blocker**: a criterion in the card text is broken, data is wrong, or a user
  cannot complete the flow.
- **Major**: a state or behavior that a Figma annotation specifies is missing
  (error, pending, overflow).
- **Minor**: copy, visual or component differences.

Then it asks the user to select one option, and gives a recommendation with a
one-line reason:

| Option | Recommended when |
|---|---|
| Comment and send back to dev | 1 or more blockers |
| One follow-up card | No blockers; 1–3 FAILs, or all FAILs are in the same area |
| Multiple follow-up cards | No blockers; the FAILs are independent and each can be fixed separately |

The rule is in a pure function, `recommendFollowUp(fails)` in
`src/engine/followup.ts`. Input: an array of `{ id, severity, area }`. Output:
`{ option, reason }`. `qar followup-advice --input .tmp/<CARD>-fails.json`
prints it as JSON. The skill calls this command; it does not apply the rule
itself.

What each option does:

- **Send back.** As now: `## REJECTED ❌` comment, transition to "To Do", assign
  the last person who worked the card.
- **One or multiple follow-up cards.**
  1. The validator writes a draft for each card in
     `.tmp/<CARD>-followup-N.md`: summary, expected behavior (quote and source),
     observed behavior, steps, screenshots.
  2. The user approves or edits each draft.
  3. For each approved draft:
     `qar jira-create-issue --project <KEY> --type Bug --summary "<text>"
     --body-file .tmp/<CARD>-followup-N.md --images a.png,b.png --link <CARD>`.
     The project is the parent card's project.
  4. The parent comment uses the heading `## VALIDATED WITH FOLLOW-UPS ✅` and
     lists the new keys. The parent card moves as validated (QA → "Final Review
     - EM & PM", Staging → "Done", un-assign). `qar verdict-posted` uses
     `--result validated`.

CONFLICT and UNCLEAR lines never get cards. They stay as questions in the
parent comment.

On a PR preview the current rule stays: no Jira writes, so no cards.

#### `qar jira-create-issue`

New functions in `src/engine/jira.ts`, all through `jiraFetch`:

- `createIssue(config, { project, type, summary })` → `{ key, id }`
  (`POST /rest/api/3/issue`, with a plain description first).
- `updateDescriptionAdf(config, key, adf)`
  (`PUT /rest/api/3/issue/{key}`, `fields.description`).
- `linkIssues(config, { type: 'Relates', inward, outward })`
  (`POST /rest/api/3/issueLink`).

The command: create the issue, upload the images to it with
`uploadAttachment`, resolve the media ids, build the description with
`buildCommentAdf`, set it with `updateDescriptionAdf`, then link it to the
parent. It prints `{"key","url"}`. If a step after creation fails, it prints
the key it created and the step that failed, so the user can fix or delete the
card.

Before it creates the card, the command checks both names with Jira:
`GET /rest/api/3/issue/createmeta/{project}/issuetypes` for the issue type and
`GET /rest/api/3/issueLinkType` for the link type. A name that is not in the
list stops the command and prints the valid names. `--type` (default `Bug`) and
`--link-type` (default `Relates`) override the defaults.

Arguments go in `src/cli/args.ts` with the other commands.

## Files

| File | Change |
|---|---|
| `.claude/skills/qa-validate/SKILL.md` | Phases (inventory, test, classify, report, follow-up); category table; result table; NOT TESTED rules; new template; fixed-script rule replaces the `use_figma` ban |
| `.claude/skills/qa-validate/figma-notes.js` | New |
| `.claude/hooks/figma-readonly.mjs`, `.claude/settings.json` | New guard hook |
| `gui/prompts/validation.md`, `gui/prompts/validation-by-pr.md` | "Build and show the inventory" replaces "state the criteria and plan" |
| `src/engine/jira.ts` | `createIssue`, `updateDescriptionAdf`, `linkIssues`, `listAttachments`, `downloadAttachment`; `expand` and `mention` ADF nodes in `buildCommentAdf` |
| `src/engine/followup.ts` | `recommendFollowUp` |
| `bin/qar.ts`, `src/cli/args.ts` | `jira-create-issue`, `jira-attachments`, `followup-advice` |
| `gui/app.go` | `figmaSeatCheck`, probe in `RunDoctor` |
| `CLAUDE.md` | Annotations only through the Plugin API; the guard hook; the seat row |

## Testing

- vitest, hook: the fixed script with each valid `MODE`/`TARGET` is allowed; a
  changed body, an extra line, a bad `MODE`, or a `TARGET` that is not a node id
  is denied.
- vitest, `figma-notes.js`: the file contains no write API names (a list of
  setter and `create*`/`remove` names). This test also fails if a person later
  adds a write to the script.
- vitest, Jira: request bodies from `createIssue`, `updateDescriptionAdf` and
  `linkIssues`, `listAttachments` and `downloadAttachment`, with `fetch`
  stubbed at the network edge. Argument parsing for the three new commands.
- vitest, `buildCommentAdf`: `{expand:Title}…{expand}` becomes an ADF
  `expand` node with the title and the inner blocks; `--mention` produces a
  `mention` node with the account id.
- vitest, `recommendFollowUp`: a blocker → send back; 2 minor FAILs → one card;
  5 FAILs in 4 areas, no blockers → multiple cards; 4 FAILs in 1 area → one
  card.
- go test, `figmaSeatCheck`: Full, Dev, View, Collab, no SafeInsights plan, no
  tool result, bad JSON. Cache: a fresh entry is reused, an entry older than
  24 h or for another email is ignored.
- vitest, Jira: an unknown issue type or link type stops `jira-create-issue`
  before `POST /issue`, and the error lists the valid names.
- Manual: validate OTTER-617 again on QA. Success: all 7 issues and the 4
  conflicts in the 10/13 comment are found; issues 1 and 2 are CONFLICT, not
  FAIL; issue 6 is under "Also observed"; the "New study" absence check is
  done; no line is NOT TESTED without approval; the
  recommendation is "multiple follow-up cards".

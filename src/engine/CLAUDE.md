# src/engine/ — notes for the run engine

(Moved from the root CLAUDE.md, which still holds the repo-wide rules.)

## Debugging "the run hangs on one step" (`QAR_STEP_TIMEOUT_MS`)

The opposite symptom to "the run does nothing" (in the root `CLAUDE.md`), and it
used to be worse: a step that could
never succeed **hung the run forever** rather than failing. No failure row, no
screenshot, `run-state.json` frozen with that step still `running` and
`"running": true`, and — the part that costs the most time — the browser never
held open for a retry, because nothing ever threw. One run sat like that for 8
minutes against an env whose build simply did not have the page the step
navigated to (staging was on a tag predating the feature; the same suite was
green on qa).

The cause is Playwright's LIBRARY mode. Per-action defaults bound each click and
assertion, but a bare `expect(...).toPass()` resolves its timeout to
`options.timeout ?? expectConfig().toPass?.timeout ?? 0` — and with no test
runner there is no config to read, so it polls with NO deadline. Note that
`expect.configure({ timeout })` does NOT fix this: that sets `info.timeout`,
which `toPass` never consults.

So `src/engine/run.ts` gives every **`ctx.step()`** a wall-clock deadline
(`withStepDeadline`, default 5 min via `resolveStepTimeoutMs`). Three details are
deliberate:

- It wraps the action INSIDE `ctx.step()`, not `step.run(ctx)`. `ctx.step`'s own
  catch is what records the `failed` row with screenshot/url/console and feeds the
  retryable hold, so a timeout fails through the ordinary path. Wrapping the outer
  call would leave the row stuck at `running` — the very bug being fixed.
- The abandoned body gets a `.catch()`. Playwright has no cancellation, so it
  keeps polling until teardown and would otherwise land as an **unhandled
  rejection** after the step was already recorded failed.
- Because that body is not cancelled, it keeps driving the SAME `page` the retry
  re-runs against, so a zombie attempt's clicks could land underneath the live one.
  **`ctx.page` is guarded, so suites do not have to think about this.** It is a
  Proxy bound to the generation the body read it at; once the deadline fires, every
  action through it — and through any locator or frame reached from it — throws
  `StepAbandonedError` rather than touching the browser. A plain body written with
  no awareness of any of this is already safe, which is the point: a rule that says
  "remember to check a flag" is one the next helper forgets.

  `ctx.signal.aborted` is still there for a body that would rather leave a long
  loop quietly than by throwing.

  The engine's own bookkeeping — screenshot, `currentUrl`, console drain — reads the
  RAW page rather than `ctx.page`, so a timed-out step still records the
  diagnostics that make it debuggable.

The message contains the word `timeout`, so `categorize()` files it as
`environment`, matching how a plain Playwright timeout already reads.

**This bounds `ctx.step()` bodies and nothing else.** `openBrowser` and
`deps.login` run OUTSIDE the step loop and remain unbounded, so a Clerk sign-in
that hangs still reproduces the original symptom — no failure row, no screenshot,
the run frozen. Those paths need their own deadline; this section does not cover
them.

**`QAR_STEP_TIMEOUT_MS`** overrides the 5-minute default; `0` disables the
deadline (an escape hatch for hand-debugging a parked step). A non-numeric or
negative value falls back to the default rather than silently disabling the
guard — a typo must not reinstate the hang. It is read from the merged settings
like any other var, so `config/settings.local.json` works as well as the env.

Suites must still not set inline Playwright timeouts (see "Code rules"): this is
the global backstop, not permission to sprinkle `{ timeout: … }` around. There is
exactly ONE sanctioned exception, and it is a shared helper rather than a suite:
`clickUntil` (`src/engine/flows/interactions.ts`) bounds its own `toPass` at
`CLICK_UNTIL_READY_TIMEOUT_MS`. A `toPass` is the one construct the deadline
above cannot express better — it polls forever in library mode, so the choice
there is not between a shorter wait and a longer one but between a number and an
infinite one, and failing in 60s with a message naming the CONTROL beats failing
in 5 minutes with one naming the step.

`clickUntil(control, target)` is also the answer to a failure this app produces
often enough that three flows had each grown their own copy: a control is
**server-rendered, so it is clickable BEFORE React wires its onClick**. The click
takes focus, nothing opens, and the caller then burns its whole action timeout on
a dialog that was never going to appear. (A click landing pre-hydration can also
navigate outside the router's knowledge and be undone.) So it re-clicks until the
target is visible AND enabled — enabled because Mantine renders a control
disabled while its data loads, and a visible-but-disabled control just moves the
failure one line down. It skips the click once the target is attached, or once the
control has detached, so a control that navigates away is not re-clicked into a
timeout. `inviteUser` (signup), `beginProposal` (study) and `toast-messages`'
modal/popover opens all call it; a new pre-hydration click belongs here too, not
in a fourth copy.

## Posting Jira comments with inline screenshots

A QA validation is worth much more with the evidence embedded in the comment. The
`jira-atlassian` MCP's `jira_add_comment` **cannot do this** — it only ever emits
text. Every image syntax you might try is stored verbatim and renders as literal
text (`![](f.png)`, `!f.png|thumbnail!`, and a markdown link to the attachment URL
were all confirmed to fail; the wiki form additionally comes back escaped as
`\![](f.png)`). This is upstream bug
[sooperset/mcp-atlassian#608](https://github.com/sooperset/mcp-atlassian/issues/608),
still open.

The reason: Jira Cloud renders **ADF**, and an embedded image is only expressible
as an ADF `media` node. That node is keyed by a **Media Services file UUID**, which
is NOT the numeric attachment id from the upload response. It's exposed only
indirectly — request `/rest/api/3/attachment/content/{id}` **without following the
redirect**, and the `Location` header is `.../file/{uuid}/binary`.

`src/engine/jira.ts` does exactly that: upload → resolve UUID from the redirect →
POST an ADF doc interleaving `paragraph` and `mediaSingle` nodes. So:

- `qar jira-comment --issue <KEY> --body-file <path.md> [--images a.png,b.png]`
  posts ONE comment with the images embedded. Images append after the body by
  default; put a `{{image:N}}` placeholder (1-based) in the body to position one
  inline instead. Prints `{"id","url"}`.
- Every comment ends with `Posted by qa-review <version>`, linked to the GitHub
  release or commit (`src/engine/version.ts`, `git describe --tags --always --dirty`
  on `repoDir()`), so a reader knows which build of the validator wrote it. In the
  packaged app that is the CLONE's commit: the engine itself runs from the bundle
  in `Resources/engine`, and only suites, skills and config come from the clone.
  The clone can be ahead of the bundle, so the footer names the skill text that
  drove the session, not necessarily the engine code that posted.
- `qar jira-delete-comment --issue <KEY> --ids <id1,id2>` removes comments (the MCP
  has no delete tool, so this is the only way to clean up a bad post). 404 = already
  gone = success.
- `qar jira-delete-attachment --issue <KEY> --ids <id1,id2>` removes attachments.
  **Deleting a comment does NOT delete the files it uploaded**, so a repost leaves the
  first post's screenshots and `--attach` files behind as duplicates on the card (ids
  from `qar jira-attachments`). Jira's delete endpoint takes the attachment id alone —
  no issue in the path — so a mistyped id would delete a file on some other card. The
  command therefore checks each id against `--issue`'s attachment list first and
  leaves any id not on it untouched, reporting it as `deleted: false`.

Body text **is** markdown — `buildCommentAdf()` converts each text segment with
`markdownToAdf()` (the `marklassian` package) and splices the resulting block nodes
into the doc, so headings, bold/italic, inline code, lists, and links all render.
(This replaced an earlier literal-text path; write markdown, not plain prose.)

Auth comes from the same var names the MCP server uses: `JIRA_URL` (defaults to
`https://openstax.atlassian.net`), `JIRA_USERNAME`, `JIRA_API_TOKEN`. These are read
from the merged settings via `jiraConfig(vars)`, so the GUI's saved "Jira email"
is picked up from `settings.local.json` and does NOT need to be exported — inline
`JIRA_USERNAME=you@rice.edu qar jira-comment …` is only a fallback when it isn't
saved there. Note the Jira account email is not necessarily your git email.

Deliberately NOT implemented: an "upload any absolute path" helper. That's the
arbitrary-file-read/exfiltration hole the upstream maintainer blocked in
[PR #1402](https://github.com/sooperset/mcp-atlassian/pull/1402); uploads here go
through the issue attachment endpoint only.

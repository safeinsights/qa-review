---
name: pr-review
description: Use when the user asks to review a GitHub PR (e.g. "/pr-review 839 --repo safeinsights/management-app", "review PR 20"). The deliverable is a *pending* (draft) review created on GitHub via the API, with inline line-anchored comments — not a chat-window summary. Pending reviews are private to the author until they click Submit, so creating one is a low-risk write equivalent to saving a draft.
---

# PR Review

## Usage

`/pr-review <number> [--repo <owner>/<repo>]` (e.g. `/pr-review 839 --repo safeinsights/management-app`).

**Always resolve the repo before anything else — this is the #1 way this skill goes wrong here.**
A bare `gh pr view 839` resolves against the CURRENT directory, which in the QA
Runner is the **qa-review** checkout (PR numbers in the low tens). Reviewing a
management-app PR (numbers in the hundreds) with a bare command silently targets
the wrong repo or fails outright. So:

- If `--repo` was given, use it verbatim.
- Else if the task is a **validation session** (you were told "this is a deployment
  of PR N of `<repo>`"), use THAT repo — not the current directory.
- Else if reviewing a PR of this repo (qa-review), run `gh repo view --json owner,name -q '.owner.login + "/" + .name'`.
- If still ambiguous, **ask**. Do not guess.

Pass `--repo <owner>/<repo>` on **every** `gh pr *` call below. Never rely on the
current directory.

If no PR number is given, run `gh pr list --repo <owner>/<repo>` and ask which one.

## Running commands in the QA Runner session

This skill often runs inside the Validation session's PTY, which pre-approves
`gh …` but matches on the command **prefix**. Follow the same rules as `qa-validate`:

- **One command per Bash call.** A pipe or `&&` falls outside the allowlist and
  prompts the user. Where a step below needs a pipe, it is already split.
- **Never prefix a command with `cd`** — you are already in the repo dir.
- **Scratch files go in `.tmp/`** in the repo (gitignored; `mkdir -p .tmp` first),
  not `/tmp/claude` — that path doesn't exist. Write the review payload
  with the `Write` tool rather than shell redirection — redirection turns an
  allowlisted `gh …` into a non-matching compound command.

## Workflow

1. **Fetch PR metadata and the diff.** One command per call:
   ```bash
   gh pr view <number> --repo <owner>/<repo>
   gh pr view <number> --repo <owner>/<repo> --json headRefOid -q '.headRefOid'
   gh pr diff <number> --repo <owner>/<repo>
   ```
   Read the diff from the command output. Re-fetch the head SHA right before
   posting — branches move during reviews.

   Do NOT try `gh pr view --json baseRepository` or similar — that field does not
   exist and the command fails.

2. **Read the diff and analyze.** For each issue, verify against the actual file at
   the PR's commit, not your local working copy:
   ```bash
   gh api 'repos/<owner>/<repo>/contents/<path>?ref=<head-sha>' -q '.content | @base64d'
   ```
   `@base64d` decodes inside the single `gh` call, so there is no pipe to break the
   allowlist match — don't reach for `| base64 -d`. Paths with `[brackets]` must be
   URL-encoded: `[` → `%5B`, `]` → `%5D`.

   This gives you the file *at that PR commit*, so line numbers in your comments
   line up. Use your local working copy to resolve broader questions about the
   codebase.

3. **Validate against the project's own rules.** Read the `CLAUDE.md` at the root of
   **the repo being reviewed** (not this one — fetch it at the head SHA the same way
   as step 2 when reviewing another repo). Check the PR against it, in this order:
   1. **Correctness** — does it do what the PR says, and handle the edge cases?
   2. **Security** — authz/authn gaps, injection, secrets in code, data exposure.
   3. **Project conventions** — the explicit rules in that CLAUDE.md.
   4. **Efficiency** — N+1 queries, avoidable work in hot paths.

   Report what you can support with a specific line. Skip speculative nits.

4. **Group findings.** For each finding, capture: file path, line number (in the
   *new* file at PR head), and a comment body. Keep tone informal and constructive —
   these are inline review comments, not a verdict.

   **Anchoring rule — read this carefully, it is the #1 source of 422 errors:**
   Every `line` value must be a line number *as it appears in the file fetched at the
   head SHA* (step 2 output). NEVER read line numbers from `gh pr diff` output — the
   unified diff renumbers across hunks and bears no relation to file-relative line
   numbers in existing files. For new files added in the PR, file lines and hunk
   lines happen to coincide, which is what makes this trap easy to fall into.

   Concretely: before writing each comment, use `Read` (or `grep -n`) on the
   fetched-at-head file, locate the exact line you intend to anchor to, and copy that
   line number. Then verify two things before continuing to the next finding:
   - The line number is `<=` the file's total line count.
   - The content at that line in the fetched file actually matches what your comment
     is about (grep for a distinctive substring from your comment body).

   Skipping this verification is what produces `422 "Line could not be resolved"` at
   POST time, which costs a round trip and a payload rewrite.

5. **Build a JSON payload.** Write it with the `Write` tool to
   `.tmp/pr-review-<number>.json`:
   ```json
   {
     "commit_id": "<head-sha>",
     "comments": [
       { "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "..." }
     ]
   }
   ```
   **Omit the `event` field** — that leaves the review in pending/draft state for the
   user to review and submit. Including `event: APPROVE/REQUEST_CHANGES/COMMENT`
   submits it immediately, which is almost never what's wanted.

6. **Post the pending review.** This step is part of the skill — invoking
   `/pr-review` means "draft the review on GitHub for me to look over." Posting is
   **not** publishing: omitting `event` leaves the review in `PENDING` state, visible
   only to the PR author/owner of the token, with nothing visible to other reviewers
   until the user clicks Submit on github.com.
   ```bash
   gh api -X POST repos/<owner>/<repo>/pulls/<number>/reviews --input .tmp/pr-review-<number>.json
   ```
   On success the response includes `"state": "PENDING"` and an `html_url`.

   **ALWAYS show the user that `html_url`.** It is the only way they can read,
   revise, and submit the draft — a review they can't find is a review that never
   happened. Print it on its own line, unabbreviated.

   If the call is denied, do not silently fall back to printing comments. Tell the
   user exactly what was blocked, then offer either the unblock path or a
   manual-paste fallback. Don't quietly downgrade the deliverable. (In the QA Runner
   session `gh …` is already pre-approved, so a denial here usually means the command
   got a pipe or redirect in it and stopped matching the allowlist — check that
   first.)

## Important

- `gh pr review` (the subcommand) does NOT support inline comments. Always use
  `gh api` for this.
- The PR head SHA in `commit_id` must match the actual current head; otherwise
  GitHub rejects line numbers that don't exist at that commit. If you fetched the
  diff a while ago, re-fetch the SHA before posting.
- If the API returns `422 Unprocessable Entity`, read the `errors` array first.
  `"Line could not be resolved"` means a line number in your payload doesn't exist at
  the head SHA (see the anchoring rule in step 4) — fix the offending entries and
  retry, don't blanket-retry. Only treat 422 as transient if the error array is empty
  or unrelated to line resolution.
- If a pending review already exists from this user, the create call returns
  `422 "User can only have one pending review per pull request"`. Either delete the
  existing one (`gh api -X DELETE .../reviews/<id>`) or append comments to it via the
  GraphQL `addPullRequestReviewThread` mutation using the existing review's `node_id`.
- Comments are ALWAYS pending/draft. NEVER add `event`, and never APPROVE or REQUEST
  CHANGES — submitting is the user's call, not yours.

## Comment style

- Lead with the observation, not a verdict.
- Use the inline-comment voice — first-person plural ("we could…", "worth a look…")
  rather than imperative.
- One issue per comment; pin to the most relevant line.

## Output

After posting, report:
- **The review URL** — first, on its own line.
- Any critical problems found, and whether each became an inline comment.
- Broad/structural feedback that doesn't anchor to a line, so the user can post it
  themselves.
- What the PR does well — genuinely, where there's something to say. Skip it rather
  than manufacture praise.

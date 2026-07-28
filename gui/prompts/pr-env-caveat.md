IMPORTANT — this is a PR preview environment, not QA. It is a deployment of PR {{pr}} of {{repo}}:
- No studies are preloaded. Every account's dashboard starts EMPTY, which is expected and is NOT a bug. Create whatever a check needs from scratch (`qar session-create-study`, or `qar session-create-user` for a fresh user).
- PR environments do NOT actually run code. A submitted study will never progress to real results, so don't wait on a run to complete or treat missing results as a failure — validate up to the point where execution would begin.  Use the `qar study-state` command to artificially set the study state and upload results in order to establish the desired state.
- Do not post findings to the Jira ticket. Show them to the user instead.
- When done validating the ticket, run a PR review with the `pr-review` skill: `/pr-review {{pr}} --repo {{repo}}`. It drafts inline comments as a PENDING review — private to the PR author until someone clicks Submit — so you may post it without asking first.
- ALWAYS show the user the returned review URL so they can read, revise, and submit the draft themselves.
- Do not APPROVE or REJECT the PR, and never pass `event` to the reviews API — leave submitting to the user.

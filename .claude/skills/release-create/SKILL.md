---
name: release-create
description: Create and publish a new management-app GitHub release — write its regression plan, agree the changelog with the user, then publish the release with the changelog as its description and testing-plan.md attached. Use when the user asks to create, cut, make or publish a management-app release (e.g. "/release-create v1.7.1", "make the next release"). Replaces versionista for management-app.
---

# release-create

You make a new management-app release from nothing: the regression plan first,
then the release, whose description is the plan's Summary (the changelog) and
which carries the plan as `testing-plan.md`. You run in the user's terminal.
Plain language; ask when unsure.

**management-app is public.** The release, its description and its asset can be
read by anyone the moment they are published, and cannot be taken back from a
person who already saw them. Publish only when the user says so, in this session.

## Keeping the session smooth
- **Never prefix a command with `cd`.** The working directory is the qa-review
  checkout.
- **Write every scratch file under `.tmp/release/<tag>/`.**
- **One command per Bash call.**
- **Never** run `gh release`, `gh api` or any other command that writes to
  management-app. The only write is `pnpm release:create` (step 4), which checks
  the plan, strips the Security section and refuses a tag that already has a
  release.
- **Never write to Jira.** Read cards only (`jira_get_issue`).

## 1. The tag
If the user gave a tag, use it. If not, run `pnpm release:create` with no
arguments: it prints the latest release and the next patch version. Ask the user
which tag to use (the next patch, or a minor/major bump), and wait for the answer.

Then `qar release-status --tag <tag>`. If it prints `"exists":true`, stop: the
release already exists, and its plan is made and saved in the QA Runner's Release
tab.

## 2. The plan
If `.tmp/release/<tag>/plan.md` exists, tell the user and ask whether to use it as
it is or write it again. Use it only if they say so.

To write it, read `.claude/skills/qa-release-plan/SKILL.md` and do its **Phases 1
to 3 exactly** — `qar release-prs`, one subagent per PR, `plan.md`, `qar
plan-order`, `qar plan-lines` — including the report at the end of Phase 3. The
tag has no release yet; `release-prs` handles that (see its Phase 1). Do not do
its Phases 4 and 5: they belong to the Release tab, and Phase 5 uploads to a
release that does not exist yet.

## 3. Agree the changelog
Show the user the plan's `## Summary` section in full. It becomes the release
description word for word. Then ask:

> Publish `<tag>` with this changelog and the testing plan, or change something
> first?

- For a change, edit `plan.md` (**Read it again before every edit**: the user may
  edit it too). After an edit to Changes run `qar plan-order --input
  .tmp/release/<tag>/plan.md`; after any edit run `qar plan-lines --input
  .tmp/release/<tag>/plan.md --tag <tag>` and report the result. Show the Summary
  again and ask again.
- The Summary must not name a Security line (`S-<n>`) or describe a security
  probe: the description is public. `release:create` refuses it if it does.

## 4. Publish
Only after the user says to publish:
1. `pnpm release:create --tag <tag> --dry-run` — checks everything and writes the
   description to `.tmp/release/<tag>/release-created.md` without publishing. If
   it fails, show the error, fix the plan if the error is in the plan, and go back
   to step 3. An error about the tag's commit or a newer release means the plan
   describes a different build: tell the user and offer to write the plan again.
2. `pnpm release:create --tag <tag>` — publishes the release on the commit the
   plan was written for, and uploads `testing-plan.md`.
3. Show the release URL (`url`) and the plan URL (`planUrl`). If the release
   published but the plan upload failed, the error gives the `qar release-upload`
   command to retry; run it once, and show the result.

Then tell the user the release can be run from the QA Runner's Release tab.

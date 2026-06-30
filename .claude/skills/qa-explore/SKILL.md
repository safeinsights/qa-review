---
name: qa-explore
description: Run a plain-English QA test against a live SafeInsights environment by driving the browser, then optionally save it as a suite. Use when given a QA instruction + env + role.
---

# qa-explore

You drive a real browser to carry out a plain-English QA instruction against a
live environment, reporting progress in the same format the engine uses, and
ALWAYS cleaning up after yourself.

## Inputs (parsed from the prompt text)
The GUI invokes this skill as a single `claude -p` prompt (claude takes the
prompt positionally and rejects unknown `--flags`), e.g.:
`/qa-explore Run this against --pr 839 as role admin. Instruction: <plain English>`
Parse from that prompt:
- the **instruction** — what to verify (after "Instruction:")
- the **target environment** — `--pr <number>` or `--env <name>` as written in the prompt
- the **role** — `admin | researcher | reviewer` (after "as role")
Pass these through to the `pnpm qar login/cleanup` commands below as the
corresponding flags.

## Procedure

1. **Create the run bundle directory.** Choose a bundle dir under `results/`,
   e.g. `results/<timestamp>_explore_<env>` (timestamp like `2026-06-29_143022`).
   Create it (`mkdir -p`). This `bundleDir` is referenced in the final result
   line and is where you write the action trace — the GUI reads both from there.

2. **Authenticate (do not reinvent).** Run:
   `pnpm qar login --role <role> (--pr <n> | --env <name>)`
   Capture the printed cookie line. The browser you drive must carry this
   session (set it as the Cookie header / cookies on the context).

3. **Drive the browser** via your browser MCP tools to satisfy the instruction.
   Break the work into named steps. For EACH step:
   - Before acting, print one line to stdout:
     `{"type":"step","name":"<step name>","status":"running","at":<epoch ms>}`
   - Do the concrete browser action(s).
   - On success print:
     `{"type":"step","name":"<step name>","status":"passed","at":<epoch ms>}`
     On failure print status `"failed"` with an `"error"` field, then stop.
   - Append every concrete action to an in-memory action trace. Every action MUST
     carry a `step` field (the human step name it belongs to) plus a `kind` and
     its args. Use ONLY these kinds:
     `{"step":"<name>","kind":"goto","url":"<url>"}`,
     `{"step":"<name>","kind":"click","selector":"<sel>"}`,
     `{"step":"<name>","kind":"fill","selector":"<sel>","value":"<v>"}`,
     `{"step":"<name>","kind":"expectVisible","selector":"<sel>"}`.
     Prefer stable selectors (`role=`, `label=`, `text=`, `data-testid`).

4. **Track created entities.** If you create a study or user, record its id
   (from the URL, e.g. `/.../study/<id>/...`).

5. **Always write the action trace** to `<bundleDir>/trace.json` (regardless of
   pass/fail, so the GUI can offer "Save as suite"). Shape:
   `{ "name": "<kebab-name-from-instruction>", "description": "<one line>",
      "role": "<role>", "actions": [ ...the trace, each with a step field... ] }`

6. **Always clean up.** Whether the run passed or failed, run:
   `pnpm qar cleanup (--pr <n> | --env <name>) --cookie "<cookie>" --studies <ids> --users <ids>`
   Report cleanup outcome.

7. **Emit the final result line** — it MUST include `bundleDir` (the GUI needs it
   to locate the video and the trace for promotion):
   `{"type":"result","ok":<bool>,"failureCategory":<cat|null>,"bundleDir":"<bundleDir>","steps":[...],"cleanup":{...}}`

## Promoting to a suite
The GUI drives promotion separately (it runs `pnpm qar codegen --trace
<bundleDir>/trace.json` on a branch and opens a PR). You do NOT run codegen
yourself — your job is only to leave a well-formed `<bundleDir>/trace.json` and a
result line carrying `bundleDir`. Keep selectors stable; the trace becomes a
dev-reviewed suite.

## Rules
- NEVER skip cleanup, even on failure.
- Use the engine's `qar login` for auth; do not attempt to log in by guessing.
- Keep selectors stable; this trace becomes a reviewed suite.
- If you cannot accomplish the instruction, emit a `failed` step with
  `failureCategory: "ai-gave-up"` and still clean up.

---
name: qa-explore
description: Run a plain-English QA test against a live SafeInsights environment by driving the browser, then optionally save it as a suite. Use when given a QA instruction + env + role.
---

# qa-explore

You drive a real browser to carry out a plain-English QA instruction against a
live environment, reporting progress in the same format the engine uses, and
ALWAYS cleaning up after yourself.

## Inputs (from the invocation)
- `--instruction "<plain English>"` — what to verify
- `--env <name>` or `--pr <number>` — target environment
- `--role <admin|researcher|reviewer>` — which test account

## Procedure

1. **Authenticate (do not reinvent).** Run:
   `pnpm qatest login --role <role> (--pr <n> | --env <name>)`
   Capture the printed cookie line. The browser you drive must carry this
   session (set it as the Cookie header / cookies on the context).

2. **Drive the browser** via your browser MCP tools to satisfy the instruction.
   Break the work into named steps. For EACH step:
   - Before acting, print one line to stdout:
     `{"type":"step","name":"<step name>","status":"running","at":<epoch ms>}`
   - Do the concrete browser action(s).
   - On success print:
     `{"type":"step","name":"<step name>","status":"passed","at":<epoch ms>}`
     On failure print status `"failed"` with an `"error"` field, then stop.
   - Append every concrete action to an in-memory action trace using ONLY these
     kinds: `goto{url}`, `click{selector}`, `fill{selector,value}`,
     `expectVisible{selector}`. Prefer stable selectors
     (`role=`, `label=`, `text=`, `data-testid`).

3. **Track created entities.** If you create a study or user, record its id
   (from the URL, e.g. `/.../study/<id>/...`).

4. **Always clean up.** Whether the run passed or failed, run:
   `pnpm qatest cleanup (--pr <n> | --env <name>) --cookie "<cookie>" --studies <ids> --users <ids>`
   Report cleanup outcome.

5. **Emit the final result line:**
   `{"type":"result","ok":<bool>,"failureCategory":<cat|null>,"steps":[...],"cleanup":{...}}`

## Saving as a suite (only when invoked with `--save <name>`)
- Write the action trace to a file:
  `{ "name": "<kebab-name>", "description": "<one line>", "role": "<role>",
     "actions": [ ...the trace... ] }`
- Run `pnpm qatest codegen --trace <file>`. If it reports a typecheck failure,
  report that and STOP — do not claim success.

## Rules
- NEVER skip cleanup, even on failure.
- Use the engine's `qatest login` for auth; do not attempt to log in by guessing.
- Keep selectors stable; this trace becomes a reviewed suite.
- If you cannot accomplish the instruction, emit a `failed` step with
  `failureCategory: "ai-gave-up"` and still clean up.

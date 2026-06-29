# qa-explore skill — later phase

Plain-English exploratory mode. Borrows the engine's deterministic spine
(env resolution, Clerk-testing-mode login, recording, guaranteed cleanup) and
owns ONLY the "figure out how to do this in the browser" part, driving the
browser via Playwright MCP / chrome-devtools MCP.

## Contract (to implement in the skill plan)
- Input: plain-English instruction + env + role.
- Calls the engine for: resolveEnv, loginAs, Recorder, CleanupClient teardown.
- Emits the same `StepEvent`s + writes the same result bundle as a curated suite.
- Marks results `mode: 'exploratory'` and uses the `ai-gave-up` failure category
  when it cannot carry out the instruction.

## Why a skill
Runs through existing Claude Code accounts — no separate AI API keys/billing in
this tool.

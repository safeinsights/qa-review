# Desktop GUI (Tauri) — later phase

Thin Tauri shell over the engine. It must NOT contain test logic — it calls the
same `runEngine` the CLI uses and renders streamed `StepEvent`s + the result
bundle.

## Planned scope
- Dropdowns: environment, role, suite (from `listSuites()` / `ENVIRONMENTS`).
- "Run" button → spawns the Node engine, streams step events into a live checklist.
- "Exploratory" tab → text box → invokes the `qa-explore` Claude Code skill
  headlessly (`claude -p`) and renders the same result bundle.
- Embeds `report.html` / `video.webm` from the run bundle.

## Open items (resolve in the GUI plan)
- Engine ↔ GUI transport for live step events (stdout JSON lines vs. IPC). The
  engine already collects step events via the Recorder listener (see the `events`
  hook in `src/engine/run.ts`) — wire that to the chosen transport.
- `claude -p` invocation + step-event streaming contract.

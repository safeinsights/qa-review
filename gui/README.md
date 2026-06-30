# Desktop GUI (Wails)

A Wails app (Go backend + React/Vite frontend) wrapping the QA engine for
"pick suite, press Run" use. It contains NO test logic — it spawns the engine
and renders streamed `StepEvent`s + the result bundle.

## Layout
- `app.go` — bound Go methods: `RunEngine` (spawn the bundled engine, stream
  `stdout-line`/`proc-exit` events), `Sync`/`ResetAndSync`/`Rekey`/`RequestAccess`/
  `PromoteSuite`, settings + run-artifact readers, and the first-launch
  `Setup`/`Preflight`/`IsRepoReady`/`ChooseDirectory`.
- `paths.go` — packaging core: `repoDir()` (single source of truth for the cloned
  repo, shared with the engine via `QAR_REPO_DIR`), `engineCmd()`, clone bootstrap,
  preflight.
- `settings.go` — pure-Go settings read/write + age crypto + keyring lock.
- `frontend/` — React UI. `lib/ipc.ts` is the bridge to `window.go.main.App.*`.
  `SetupGate` gates first launch (choose location → clone → compile suites).

## Run it
- **Dev:** `wails dev` (serves on `:34115` too — drive in Chrome for headless
  debugging; see the repo `CLAUDE.md` "Running the GUI app in a browser").
- **Production `.dmg`:** `make dmg` from the repo root (signed + notarized) or
  `make dmg-unsigned` for a local smoke test. See `CLAUDE.md` "Packaging a
  standalone Mac app".

In a packaged app the engine is bundled (`<Resources>/engine/qar.bundle.mjs` run by
a shipped `node`); under `wails dev` `engineCmd` falls back to `pnpm qar`.

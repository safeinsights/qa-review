// Bridge to the Wails (Go) backend. Exported signatures are intentionally
// identical to the previous Tauri bridge so the React components need no changes.
// Wails exposes bound Go methods at window.go.main.App.* and the event runtime at
// window.runtime.EventsOn/EventsOff.

export type UnlistenFn = () => void

// One settings field as returned by the Go backend. Secret values are masked
// (Value is empty); `set` says whether a value already exists.
export interface SettingField {
    key: string
    label: string
    secret: boolean
    group: string // account section: "Admin" | "Researcher" | "Reviewer" | "" (ungrouped)
    env: string // for per-env fields (results private keys): "qa" | "staging"; "" otherwise
    tier: string // "project" | "secrets" | "local" | "" (unset)
    value: string
    set: boolean
}

export interface SettingsView {
    fields: SettingField[]
    hasIdentity: boolean
}

// One prerequisite result from the Setup Doctor.
export interface DoctorCheck {
    name: string
    ok: boolean
    detail: string
    hint: string
    docURL: string
}

export interface KeyringAccess {
    hasIdentity: boolean
    isRecipient: boolean
    note: string
}

interface WailsApp {
    RunProcess(program: string, args: string[], cwd: string): Promise<void>
    RunEngine(args: string[]): Promise<void>
    StopRun(): Promise<void>
    IsRunning(): Promise<boolean>
    SendToRun(line: string): Promise<void>
    StartAuthoringSession(
        env: string,
        pr: string,
        role: string,
        instruction: string
    ): Promise<string>
    StartRunCompanion(cdpPort: number, suite: string): Promise<string>
    WriteToPty(b64: string): Promise<void>
    ResizePty(rows: number, cols: number): Promise<void>
    SendToPty(text: string): Promise<void>
    StopSession(): Promise<void>
    StopSessionIfOwner(token: string): Promise<void>
    Setup(dir: string): Promise<string>
    ChooseDirectory(): Promise<string>
    DefaultRepoDir(): Promise<string>
    Preflight(): Promise<string[]>
    IsRepoReady(): Promise<boolean>
    GitPull(cwd: string): Promise<string>
    PromoteSuite(name: string): Promise<string>
    SuiteFileExists(name: string): Promise<boolean>
    OpenSuiteInEditor(name: string): Promise<void>
    ReportIssue(title: string, note: string, tab: string, runState: string): Promise<string>
    RunDoctor(): Promise<DoctorCheck[]>
    ReadScreenshot(bundleDir: string, rel: string): Promise<string>
    ReadVideo(bundleDir: string): Promise<string>
    SaveScreenshotAs(bundleDir: string, rel: string, suite: string): Promise<string>
    SaveTrace(bundleDir: string, suite: string): Promise<string>
    ZipBundle(bundleDir: string, suite: string): Promise<string>
    ReadSettings(cwd: string): Promise<SettingsView>
    WriteSetting(cwd: string, key: string, value: string, tier: string): Promise<void>
    Sync(cwd: string): Promise<string>
    ResetAndSync(cwd: string): Promise<string>
    RequestAccess(cwd: string, name: string): Promise<string>
    Rekey(cwd: string): Promise<string>
    IsInDrift(cwd: string): Promise<boolean>
    CheckKeyringAccess(cwd: string): Promise<KeyringAccess>
}

interface WailsRuntime {
    EventsOn(event: string, cb: (...data: unknown[]) => void): () => void
    EventsOff(event: string): void
}

declare global {
    interface Window {
        go?: { main?: { App?: WailsApp } }
        runtime?: WailsRuntime
    }
}

function app(): WailsApp {
    const a = window.go?.main?.App
    if (!a) throw new Error('Wails bindings not ready (window.go.main.App missing)')
    return a
}

function rt(): WailsRuntime {
    const r = window.runtime
    if (!r) throw new Error('Wails runtime not ready (window.runtime missing)')
    return r
}

export async function runProcess(program: string, args: string[], cwd: string): Promise<void> {
    await app().RunProcess(program, args, cwd)
}

// A run was rejected because one is already active (Go's ErrRunInProgress).
export const RUN_IN_PROGRESS = 'a run is already in progress'
export function isRunInProgressError(e: unknown): boolean {
    return String((e as { message?: string })?.message ?? e).includes(RUN_IN_PROGRESS)
}

// Run the bundled engine (`qar <args>`). The engine/node/bundle paths live in Go;
// the frontend only supplies the qar args. Rejects with ErrRunInProgress if a
// run is already active (the caller should surface it + reflect running state).
export async function runEngine(args: string[]): Promise<void> {
    await app().RunEngine(args)
}

// Stop the in-flight Suites/engine run (kills the engine + its Chromium).
export async function stopRun(): Promise<void> {
    await app().StopRun()
}

// Authoritative "is a tracked run active right now?" — used to sync the UI's
// Run/Stop button on mount, independent of streamed event history.
export async function isRunning(): Promise<boolean> {
    return app().IsRunning()
}

// --- Pause/resume control channel (GUI → running engine, over its stdin) ---

// Write one raw NDJSON control line to the in-flight run.
export async function sendToRun(line: string): Promise<void> {
    await app().SendToRun(line)
}

// Replace the engine's "pause before" set with the full current selection. Sent
// on every live toggle so the engine and UI never drift.
export async function setPauses(steps: string[]): Promise<void> {
    await sendToRun(JSON.stringify({ type: 'pause-set', steps }))
}

// Resume a run that's halted at a paused step.
export async function resumeRun(): Promise<void> {
    await sendToRun(JSON.stringify({ type: 'resume' }))
}

// Retry a step that failed: the engine reloads the (possibly edited) suite and
// re-runs the failed step against the still-live browser, then continues the suite.
export async function retryStep(): Promise<void> {
    await sendToRun(JSON.stringify({ type: 'retry-step' }))
}

// Give up on a failed step: the engine tears down and the run finishes FAILED.
export async function giveUpStep(): Promise<void> {
    await sendToRun(JSON.stringify({ type: 'give-up' }))
}

// --- Interactive authoring session (terminal + shared browser) ---

// Start a session: Go launches a logged-in browser (shared CDP) + claude in a PTY.
// The GUI then receives `session-ready` (screencast port) + `pty-output` events.
// Returns the session token; pass it to stopSessionIfOwner on unmount so a stale
// tab can't tear down a session the other tab has since started.
export async function startAuthoringSession(
    env: string,
    pr: string,
    role: string,
    instruction: string
): Promise<string> {
    return app().StartAuthoringSession(env, pr, role, instruction)
}

// Start the "Ask Claude" run companion: Go attaches claude in a PTY to the
// running engine's browser via its CDP port (no new browser is launched). The
// GUI then receives `pty-output` events, same as the authoring session. Returns
// the session token (see stopSessionIfOwner).
export async function startRunCompanion(cdpPort: number, suite: string): Promise<string> {
    return app().StartRunCompanion(cdpPort, suite)
}

// Forward terminal keystrokes (base64) to claude's PTY.
export async function writeToPty(b64: string): Promise<void> {
    await app().WriteToPty(b64)
}

export async function resizePty(rows: number, cols: number): Promise<void> {
    await app().ResizePty(rows, cols)
}

// Send a line of text + Enter to claude (e.g. the "Save as suite" instruction).
export async function sendToPty(text: string): Promise<void> {
    await app().SendToPty(text)
}

// Unconditionally tear down whatever occupies the shared PTY slot. Use for an
// explicit user "Stop session" action on the active session.
export async function stopSession(): Promise<void> {
    await app().StopSession()
}

// Token-scoped teardown for the stale-unmount path: only tears down if `token`
// still owns the active session. A superseded caller (the other tab started a new
// session) is a no-op, so neither authoring nor companion can kill the other.
export async function stopSessionIfOwner(token: string): Promise<void> {
    await app().StopSessionIfOwner(token)
}

// Raw PTY output bytes (base64) from claude's terminal.
export async function onPtyOutput(cb: (b64: string) => void): Promise<UnlistenFn> {
    return rt().EventsOn('pty-output', (...data) => cb(String(data[0])))
}

export async function onPtyExit(cb: (code: number | null) => void): Promise<UnlistenFn> {
    return rt().EventsOn('pty-exit', (...data) => cb(typeof data[0] === 'number' ? data[0] : null))
}

// Fires with the screencast port once the shared browser is ready to display.
export async function onSessionReady(cb: (screencastPort: number) => void): Promise<UnlistenFn> {
    return rt().EventsOn('session-ready', (...data) => cb(Number(data[0])))
}

export async function onSessionEnded(cb: () => void): Promise<UnlistenFn> {
    return rt().EventsOn('session-ended', () => cb())
}

// Non-ready engine output (login errors etc.) surfaced before the terminal opens.
export async function onSessionLog(cb: (line: string) => void): Promise<UnlistenFn> {
    return rt().EventsOn('session-log', (...data) => cb(String(data[0])))
}

// Clone + compile suites on first launch into `dir` (empty = default location).
export async function setup(dir: string): Promise<string> {
    return app().Setup(dir)
}

// Open a native folder picker; '' if cancelled.
export async function chooseDirectory(): Promise<string> {
    return app().ChooseDirectory()
}

// The default clone location shown in the setup UI.
export async function defaultRepoDir(): Promise<string> {
    return app().DefaultRepoDir()
}

// Required external tools/apps that are missing ([] means all present).
export async function preflight(): Promise<string[]> {
    return app().Preflight()
}

// Whether the qa-review repo has been cloned yet.
export async function isRepoReady(): Promise<boolean> {
    return app().IsRepoReady()
}

export async function onStdoutLine(cb: (line: string) => void): Promise<UnlistenFn> {
    return rt().EventsOn('stdout-line', (...data) => cb(String(data[0])))
}

export async function onExit(cb: (code: number | null) => void): Promise<UnlistenFn> {
    return rt().EventsOn('proc-exit', (...data) => cb(typeof data[0] === 'number' ? data[0] : null))
}

// The Go backend ignores the cwd arg (it uses the cloned repo dir), so the
// wrappers below pass '' and no longer take a cwd from callers.
export async function gitPull(): Promise<string> {
    return app().GitPull('')
}

// Compile the claude-authored src/suites/<name>.ts and open a PR.
export async function promoteSuite(name: string): Promise<string> {
    return app().PromoteSuite(name)
}

// Whether claude has actually written src/suites/<name>.ts yet (gates "Open PR").
export async function suiteFileExists(name: string): Promise<boolean> {
    return app().SuiteFileExists(name)
}

// Open the suite's TS source in the user's editor ($EDITOR/$VISUAL, else a known
// GUI editor, else the OS file association). Backs the "Edit Suite" button.
export async function openSuiteInEditor(name: string): Promise<void> {
    await app().OpenSuiteInEditor(name)
}

// Open a GitHub issue with debug context (Suites run state, or the full authoring
// transcript) auto-attached. Returns the new issue URL.
export async function reportIssue(
    title: string,
    note: string,
    tab: string,
    runState: string
): Promise<string> {
    return app().ReportIssue(title, note, tab, runState)
}

// Check + validate every prerequisite app/state for the Setup Doctor.
export async function runDoctor(): Promise<DoctorCheck[]> {
    return app().RunDoctor()
}

// Read a per-step screenshot as a base64 data URI (webviews block file://).
export async function readScreenshot(bundleDir: string, rel: string): Promise<string> {
    return app().ReadScreenshot(bundleDir, rel)
}

// Read the run's video.webm and return an object URL playable by <video> (the
// raw bytes come from Go as base64; we decode to a Blob to avoid a huge data:
// URL). Caller should URL.revokeObjectURL when done.
export async function readVideoObjectUrl(bundleDir: string): Promise<string> {
    const b64 = await app().ReadVideo(bundleDir)
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }))
}

// Prompt to save one screenshot, named "<suite>-<file>.png"; returns the saved
// path ('' if cancelled).
export async function saveScreenshotAs(
    bundleDir: string,
    rel: string,
    suite: string
): Promise<string> {
    return app().SaveScreenshotAs(bundleDir, rel, suite)
}

// Prompt to save just the bundle's trace.zip (replays at trace.playwright.dev),
// named "<suite>-trace.zip"; returns the saved path ('' if cancelled).
export async function saveTrace(bundleDir: string, suite: string): Promise<string> {
    return app().SaveTrace(bundleDir, suite)
}

// Prompt to save a zip of the whole run bundle, named "<suite>-<bundle>.zip";
// returns the saved path ('' if cancelled).
export async function zipBundle(bundleDir: string, suite: string): Promise<string> {
    return app().ZipBundle(bundleDir, suite)
}

// Read the merged settings view (secret values masked) for the Settings panel.
export async function readSettings(): Promise<SettingsView> {
    return app().ReadSettings('')
}

// Write one field to a tier ("project" commits it; "local" is a gitignored override).
export async function writeSetting(key: string, value: string, tier: string): Promise<void> {
    await app().WriteSetting('', key, value, tier)
}

// Fast-forward-only sync: "synced" | "skipped-dirty" | "skipped-diverged".
export async function sync(): Promise<string> {
    return app().Sync('')
}

// Discard uncommitted tracked edits (keep local commits), then sync.
export async function resetAndSync(): Promise<string> {
    return app().ResetAndSync('')
}

// Generate identity + open a keyring PR via `qar request-access`.
export async function requestAccess(name: string): Promise<string> {
    return app().RequestAccess('', name)
}

// Re-encrypt all secrets to the current keyring.
export async function rekey(): Promise<string> {
    return app().Rekey('')
}

// True if secrets are out of sync with the keyring (rekey needed).
export async function isInDrift(): Promise<boolean> {
    return app().IsInDrift('')
}

// Pull the latest keyring + secrets and report whether the local identity can
// decrypt shared secrets (is a recipient). Backs the first-launch access gate.
export async function checkKeyringAccess(): Promise<KeyringAccess> {
    return app().CheckKeyringAccess('')
}

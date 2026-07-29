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
    group: string // "Admin" | "Researcher" | "Reviewer" | "Jira" | "" (the base URL)
    env: string // every account field + the base URL: "qa" | "staging" | "production"; "" only for Jira
    section: string // sub-section label ("Account" | "Results private key" | "Environment")
    multiline: boolean // render a textarea (PEM keys) vs a one-line input (MFA code/seed)
    tier: string // "project" | "secrets" | "local" | "" (unset)
    value: string
    set: boolean
    localOnly: boolean // forced to the local tier (no encrypted/project option)
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

export type AccessState =
    | 'no-identity'
    | 'no-branch'
    | 'branch-no-pr'
    | 'pr-open'
    | 'pr-closed'
    | 'merged-awaiting-rekey'
    | 'ready'

export interface KeyringAccess {
    hasIdentity: boolean
    isRecipient: boolean
    note: string
    state: AccessState | ''
    branch: string
    prNumber: number
    prURL: string
    githubReachable: boolean
}

// One tool's resolution result in the debug report: whether it was found on the
// GUI-augmented PATH, where it resolved, and its version output (or error).
export interface ToolProbe {
    name: string
    found: boolean
    resolvedAt: string
    version: string
    error: string
}

// Environment + tool-resolution detail shown in the "Debug details" accordion.
// Makes the Finder-PATH "installed but not found" bug diagnosable: the searched
// dirs, the effective PATH, and where each tool resolved (or didn't).
export interface DebugReport {
    appVersion: string
    osArch: string
    repoDir: string
    searchDirs: string[]
    effectivePATH: string
    tools: ToolProbe[]
    markdown: string
}

// One rendered help page for the Help drawer, read from <repo>/docs/help/*.md.
export interface HelpDoc {
    slug: string
    title: string
    body: string
}

// The verdict on a PR's deployment (continuous-integration/*) checks. Only "ok"
// and "unknown" let a validation start; the rest mean the PR preview isn't a build
// of the code under review. See CheckPrCI in gui/app.go.
export interface PrCIStatus {
    state: 'ok' | 'pending' | 'failed' | 'none' | 'unknown'
    warning: string
    checks: string[] | null
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
    StartValidationSession(
        env: string,
        pr: string,
        jiraCard: string,
        instructions: string,
        force: boolean
    ): Promise<{ token: string; jiraCard: string }>
    CheckPrCI(pr: string): Promise<PrCIStatus>
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
    DebugReport(): Promise<DebugReport>
    ReadScreenshot(bundleDir: string, rel: string): Promise<string>
    ReadVideo(bundleDir: string): Promise<string>
    SaveScreenshotAs(bundleDir: string, rel: string, suite: string): Promise<string>
    SaveTrace(bundleDir: string, suite: string): Promise<string>
    ZipBundle(bundleDir: string, suite: string): Promise<string>
    ReadSettings(cwd: string): Promise<SettingsView>
    RevealSecret(cwd: string, key: string): Promise<string>
    WriteSetting(cwd: string, key: string, value: string, tier: string): Promise<void>
    ClearSetting(cwd: string, key: string): Promise<void>
    Sync(cwd: string): Promise<string>
    ResetAndSync(cwd: string): Promise<string>
    RequestAccess(cwd: string, name: string): Promise<string>
    Rekey(cwd: string): Promise<string>
    IsInDrift(cwd: string): Promise<boolean>
    CheckKeyringAccess(cwd: string): Promise<KeyringAccess>
    OpenAccessPr(cwd: string): Promise<string>
    HelpDocs(): Promise<HelpDoc[]>
}

interface WailsRuntime {
    EventsOn(event: string, cb: (...data: unknown[]) => void): () => void
    EventsOff(event: string): void
    // Opens a URL in the user's default system browser (NOT inside the webview).
    BrowserOpenURL(url: string): void
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

// Open a URL in the user's real browser (via the Wails runtime), not the webview.
// Used by the embedded terminal so clicking a link in claude's output works. The
// Wails runtime is injected on the window; fall back to window.open if it (or the
// method) isn't present, and never throw so a click can't silently break.
export function openExternal(url: string): void {
    const open = window.runtime?.BrowserOpenURL
    if (typeof open === 'function') {
        try {
            open(url)
            return
        } catch {
            /* fall through to window.open */
        }
    }
    try {
        window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
        /* nothing else we can do */
    }
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

// Relocate the run to `index` and continue from there. The engine honors this at
// its next step boundary — a step already in flight runs to completion first, so a
// jump requested mid-step lands when that step finishes. Jumping FORWARD marks the
// intervening steps 'skipped' (they never ran); jumping BACKWARD re-runs from the
// target against the live browser.
export async function jumpToStep(index: number): Promise<void> {
    await sendToRun(JSON.stringify({ type: 'jump-to', index }))
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

// Start a Validation session: Go launches the shared (logged-out) browser + claude
// in a PTY, with the Jira MCP added. The GUI receives `session-ready` + `pty-output`
// events, same as authoring. Returns the session token (see stopSessionIfOwner).
// Starts a validation session. Either `pr` or `jiraCard` must be non-empty (Go
// enforces it too). Returns the session token AND the Jira card the session is
// about — with a PR and no card, Go infers the key from the PR, so the resolved
// card comes back here for the Verdict button. An empty `jiraCard` in the result
// means it couldn't be inferred and Claude will identify it from the PR.
// `force` proceeds despite a blocking CI status — the tester has seen the warning
// and chosen to validate against a preview that may be stale.
export async function startValidationSession(
    env: string,
    pr: string,
    jiraCard: string,
    instructions: string,
    force = false
): Promise<{ token: string; jiraCard: string }> {
    return app().StartValidationSession(env, pr, jiraCard, instructions, force)
}

// Reads the PR's continuous-integration/* checks so the Validation tab can warn
// before the tester presses Start. Go re-checks at start — this is the early
// warning, not the gate.
export async function checkPrCI(pr: string): Promise<PrCIStatus> {
    return app().CheckPrCI(pr)
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

// The kind of session that owns the single shared PTY + browser. Both the Author
// and Validation tabs listen to the same global session events, so each uses `kind`
// to tell whether the live session is its own or the other tab's.
export type SessionKind = 'authoring' | 'validation' | 'companion'

export interface SessionReady {
    kind: SessionKind
    screencastPort: number
}

// Fires when the shared browser is ready to display, carrying which tab owns it.
export async function onSessionReady(cb: (info: SessionReady) => void): Promise<UnlistenFn> {
    return rt().EventsOn('session-ready', (...data) => {
        const payload = (data[0] ?? {}) as { kind?: string; screencastPort?: number }
        cb({
            kind: (payload.kind ?? 'authoring') as SessionKind,
            screencastPort: Number(payload.screencastPort ?? 0),
        })
    })
}

export async function onSessionEnded(cb: () => void): Promise<UnlistenFn> {
    return rt().EventsOn('session-ended', () => cb())
}

export interface VerdictPosted {
    issue: string
    result: 'validated' | 'rejected'
}

// Fires when Claude records a posted verdict (`qar verdict-posted`), whether the
// GUI's Verdict button or a manual instruction drove it. The Validation tab uses it
// to hide the Verdict button and show the outcome.
export async function onVerdictPosted(cb: (v: VerdictPosted) => void): Promise<UnlistenFn> {
    return rt().EventsOn('verdict-posted', (...data) => {
        const p = (data[0] ?? {}) as { issue?: string; result?: string }
        cb({
            issue: String(p.issue ?? ''),
            result: p.result === 'rejected' ? 'rejected' : 'validated',
        })
    })
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

// Environment + per-tool PATH resolution detail for the "Debug details" accordion.
export async function debugReport(): Promise<DebugReport> {
    return app().DebugReport()
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

// Reveal one secret's current plaintext value (decrypting a committed secret with
// the local identity). Backs the reveal (eye) toggle. Rejects if unset or if the
// value is encrypted but the local identity can't decrypt it.
export async function revealSecret(key: string): Promise<string> {
    return app().RevealSecret('', key)
}

// Write one field to a tier ("project" commits it; "local" is a gitignored override).
export async function writeSetting(key: string, value: string, tier: string): Promise<void> {
    await app().WriteSetting('', key, value, tier)
}

// Unset one field, removing it from every tier file. The only way to clear a value:
// writeSetting always assigns, and the panel won't save an empty string.
export async function clearSetting(key: string): Promise<void> {
    await app().ClearSetting('', key)
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

// Open a pull request for an already-pushed access branch (the retry path for a
// request whose push succeeded but whose PR creation didn't).
export async function openAccessPr(): Promise<string> {
    return app().OpenAccessPr('')
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

// Read the in-app help pages (docs/help/*.md from the cloned repo). Returns []
// if the docs dir is absent (stale/partial checkout) — the drawer shows nothing.
export async function helpDocs(): Promise<HelpDoc[]> {
    return app().HelpDocs()
}

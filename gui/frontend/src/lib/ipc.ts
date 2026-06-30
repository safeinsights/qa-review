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
    tier: string // "project" | "secrets" | "local" | "" (unset)
    value: string
    set: boolean
}

export interface SettingsView {
    fields: SettingField[]
    hasIdentity: boolean
}

interface WailsApp {
    RunProcess(program: string, args: string[], cwd: string): Promise<void>
    GitPull(cwd: string): Promise<string>
    PromoteSuite(cwd: string, name: string, tracePath: string): Promise<string>
    ReadScreenshot(bundleDir: string, rel: string): Promise<string>
    ReadVideo(bundleDir: string): Promise<string>
    SaveScreenshotAs(bundleDir: string, rel: string): Promise<string>
    ZipBundle(bundleDir: string): Promise<string>
    ReadSettings(cwd: string): Promise<SettingsView>
    WriteSetting(cwd: string, key: string, value: string, tier: string): Promise<void>
    Sync(cwd: string): Promise<string>
    ResetAndSync(cwd: string): Promise<string>
    RequestAccess(cwd: string, name: string): Promise<string>
    Rekey(cwd: string): Promise<string>
    IsInDrift(cwd: string): Promise<boolean>
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

export async function onStdoutLine(cb: (line: string) => void): Promise<UnlistenFn> {
    return rt().EventsOn('stdout-line', (...data) => cb(String(data[0])))
}

export async function onExit(cb: (code: number | null) => void): Promise<UnlistenFn> {
    return rt().EventsOn('proc-exit', (...data) => cb(typeof data[0] === 'number' ? data[0] : null))
}

export async function gitPull(cwd: string): Promise<string> {
    return app().GitPull(cwd)
}

export async function promoteSuite(cwd: string, name: string, tracePath: string): Promise<string> {
    return app().PromoteSuite(cwd, name, tracePath)
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
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }))
}

// Prompt to save one screenshot; returns the saved path ('' if cancelled).
export async function saveScreenshotAs(bundleDir: string, rel: string): Promise<string> {
    return app().SaveScreenshotAs(bundleDir, rel)
}

// Prompt to save a zip of the whole run bundle; returns the saved path ('' if cancelled).
export async function zipBundle(bundleDir: string): Promise<string> {
    return app().ZipBundle(bundleDir)
}

// Read the merged settings view (secret values masked) for the Settings panel.
export async function readSettings(cwd: string): Promise<SettingsView> {
    return app().ReadSettings(cwd)
}

// Write one field to a tier ("project" commits it; "local" is a gitignored override).
export async function writeSetting(cwd: string, key: string, value: string, tier: string): Promise<void> {
    await app().WriteSetting(cwd, key, value, tier)
}

// Fast-forward-only sync: "synced" | "skipped-dirty" | "skipped-diverged".
export async function sync(cwd: string): Promise<string> {
    return app().Sync(cwd)
}

// Discard uncommitted tracked edits (keep local commits), then sync.
export async function resetAndSync(cwd: string): Promise<string> {
    return app().ResetAndSync(cwd)
}

// Generate identity + open a keyring PR via `qar request-access`.
export async function requestAccess(cwd: string, name: string): Promise<string> {
    return app().RequestAccess(cwd, name)
}

// Re-encrypt all secrets to the current keyring.
export async function rekey(cwd: string): Promise<string> {
    return app().Rekey(cwd)
}

// True if secrets are out of sync with the keyring (rekey needed).
export async function isInDrift(cwd: string): Promise<boolean> {
    return app().IsInDrift(cwd)
}

// Bridge to the Wails (Go) backend. Exported signatures are intentionally
// identical to the previous Tauri bridge so the React components need no changes.
// Wails exposes bound Go methods at window.go.main.App.* and the event runtime at
// window.runtime.EventsOn/EventsOff.

export type UnlistenFn = () => void

interface WailsApp {
    RunProcess(program: string, args: string[], cwd: string): Promise<void>
    GitPull(cwd: string): Promise<string>
    PromoteSuite(cwd: string, name: string, tracePath: string): Promise<string>
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

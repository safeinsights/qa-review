import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// Start a child process in `cwd`. stdout lines arrive via onStdoutLine; exit via
// onExit. Returns nothing; the events drive the UI.
export async function runProcess(program: string, args: string[], cwd: string): Promise<void> {
    await invoke('run_process', { program, args, cwd })
}

export async function onStdoutLine(cb: (line: string) => void): Promise<UnlistenFn> {
    return listen<string>('stdout-line', (e) => cb(e.payload))
}

export async function onExit(cb: (code: number | null) => void): Promise<UnlistenFn> {
    return listen<number | null>('proc-exit', (e) => cb(e.payload))
}

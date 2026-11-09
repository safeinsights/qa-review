// A process the GUI starts (the long-lived `qar session`, the baseline's client)
// must not outlive the GUI. The app reaps its children when it quits normally, but a
// quit that skips its shutdown — a `wails dev` rebuild, a force quit, a crash — left
// `qar session` running with its Chrome, holding the session lock, so the next
// session could not start. The GUI therefore passes its pid in QAR_GUI_PID, and the
// child stops itself once that process is gone.

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        // EPERM: it exists, but belongs to someone else.
        return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
}

// Calls `onGone` once, when the GUI named in QAR_GUI_PID has exited. Does nothing
// without the variable (a session started by hand from a terminal). Returns a stopper.
export function onGuiGone(
    onGone: () => void,
    env: NodeJS.ProcessEnv = process.env,
    isAlive: (pid: number) => boolean = pidAlive,
    intervalMs = 2_000
): () => void {
    const pid = Number(env.QAR_GUI_PID)
    if (!Number.isInteger(pid) || pid <= 0) return () => {}
    const timer = setInterval(() => {
        if (isAlive(pid)) return
        clearInterval(timer)
        onGone()
    }, intervalMs)
    return () => clearInterval(timer)
}

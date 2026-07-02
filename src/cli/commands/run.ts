import type { Page } from '@playwright/test'
import {
    parseControlLine,
    pausedLine,
    resultLine,
    screencastLine,
    stepLine,
} from '@/cli/step-stream'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { defaultDeps, runEngine } from '@/engine/run'
import { headedDeps } from '@/engine/run-headed'
import { ScreencastServer } from '@/engine/screencast'
import type { Vars } from '@/engine/settings'
import type { Role, StepEvent } from '@/engine/types'

export async function runCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const role = (opts.role ?? 'admin') as Role
    const suite = opts.suite ?? 'signin'
    const json = opts.json === 'true'
    const headed = opts.headed === 'true'
    const screencast = opts.screencast === 'true'

    const envConfig = opts.pr
        ? resolvePrEnv(Number(opts.pr), vars)
        : resolveEnv(opts.env ?? 'qa', vars)

    const onStep = json ? (e: StepEvent) => process.stdout.write(stepLine(e)) : undefined

    let server: ScreencastServer | undefined
    const onPage = screencast
        ? async (page: Page) => {
              server = await ScreencastServer.start(page)
              process.stdout.write(screencastLine({ port: server.port }))
          }
        : undefined

    // --- Pause/resume control channel ---
    // Pre-run pauses arrive as a launch arg (deterministic, no startup stdin race);
    // live toggles arrive as {type:'pause-set'} on stdin. The set carries the full
    // current selection each time, so replacing it wholesale keeps us in sync.
    const pausedSet = new Set<string>(
        (opts['pause-before'] ?? '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
    )
    // A re-armable "resume" deferred: waitForResume awaits the current promise;
    // a {type:'resume'} control message resolves it, and we immediately re-arm for
    // the next pause.
    let resumeResolve: (() => void) | undefined
    let resumePromise: Promise<void> | undefined
    const armResume = () => {
        resumePromise = new Promise<void>(r => (resumeResolve = r))
    }
    const controlDeps = {
        shouldPause: (name: string) => pausedSet.has(name),
        onPaused: (name: string) => process.stdout.write(pausedLine({ name })),
        waitForResume: async () => {
            armResume()
            await resumePromise
        },
    }

    // Read NDJSON control messages from stdin. Only the `run` command opts into
    // reading stdin, so `list`/`build-suites` (which share the Go spawn path) are
    // unaffected — an unread stdin pipe is inert.
    let stdinBuf = ''
    const onStdin = (chunk: Buffer) => {
        stdinBuf += chunk.toString('utf8')
        let nl = stdinBuf.indexOf('\n')
        while (nl >= 0) {
            const line = stdinBuf.slice(0, nl)
            stdinBuf = stdinBuf.slice(nl + 1)
            const msg = parseControlLine(line)
            if (msg) {
                if (msg.type === 'pause-set') {
                    pausedSet.clear()
                    for (const s of msg.steps) pausedSet.add(s)
                } else if (msg.type === 'resume') {
                    // Tolerate a resume with nothing pending (no-op).
                    resumeResolve?.()
                }
            }
            nl = stdinBuf.indexOf('\n')
        }
    }
    process.stdin.on('data', onStdin)
    process.stdin.resume()

    // Graceful stop: the GUI's Stop button makes Go SIGTERM this process group.
    // Handle it explicitly so a user-initiated stop exits IMMEDIATELY and cleanly
    // — rather than letting Chromium (also in the group) die first and make the
    // in-flight Playwright call throw "Target page... has been closed", which the
    // run loop would otherwise report as a spurious step failure. Exit 0 (not a
    // failure); the reader goroutine in Go sees proc-exit and returns the UI to idle.
    let stopping = false
    const onStop = () => {
        if (stopping) return
        stopping = true
        // No result line, no failed step — this was intentional. Flush stdout and go.
        try {
            server?.close().catch(() => {})
        } finally {
            process.exit(0)
        }
    }
    process.on('SIGTERM', onStop)
    process.on('SIGINT', onStop)

    // Screencast IS the view, so it doesn't need a headed window. Use headed only
    // if explicitly asked AND not screencasting.
    const base = headed && !screencast ? headedDeps(onStep, vars) : { ...defaultDeps(vars), onStep }
    const deps = { ...base, onPage, ...controlDeps }

    try {
        const result = await runEngine({ suite, env: envConfig.name, role, envConfig }, deps)
        if (json) {
            process.stdout.write(resultLine(result))
        } else {
            for (const s of result.steps) {
                const mark = s.status === 'passed' ? 'PASS' : s.status === 'failed' ? 'FAIL' : '...'
                console.log(mark, s.name, s.error ? `:: ${s.error}` : '')
            }
            console.log(`\nok: ${result.ok} | category: ${result.failureCategory ?? '-'}`)
            console.log(`cleanup ok: ${result.cleanup.ok}`)
            if (!result.cleanup.ok && result.cleanup.statuses) {
                console.log(`cleanup statuses: ${JSON.stringify(result.cleanup.statuses)}`)
            }
            console.log(`report: ${result.bundleDir}/report.html`)
        }
        if (!result.ok) process.exitCode = 1

        // Screencast: the suite's browser work is short, but the GUI panel should
        // keep showing the live view (and its last frame) a bit longer. Hold the
        // server open until the GUI client disconnects, or a grace timeout — so
        // the panel never loses the connection race or blanks the instant the run
        // ends. (The page is still open here; runEngine's teardown ran inside it,
        // but we keep the ws alive for the final frames + viewing grace.)
        if (server) await server.waitForClientThenClose(15000)
    } finally {
        await server?.close()
        // Detach the stdin listener and unref it so an idle control channel never
        // keeps the process alive past the run.
        process.stdin.off('data', onStdin)
        process.stdin.pause()
        process.off('SIGTERM', onStop)
        process.off('SIGINT', onStop)
    }
}

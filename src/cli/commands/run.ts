import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { compileSuite } from '@/cli/commands/build-suites'
import {
    errorHoldLine,
    parseControlLine,
    pausedLine,
    resultLine,
    screencastLine,
    stepFailedLine,
    stepLine,
} from '@/cli/step-stream'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { repoDir, runStatePath, suitesCompiledDir } from '@/engine/paths'
import { defaultDeps, runEngine } from '@/engine/run'
import { headedDeps } from '@/engine/run-headed'
import { ScreencastServer } from '@/engine/screencast'
import type { Vars } from '@/engine/settings'
import type { Role, RunState, StepEvent } from '@/engine/types'
import { discoverSuites } from '@/suites/discover'
import type { Suite } from '@/suites/types'

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

    // Captured from the run browser's handle so the screencast line can carry the
    // CDP port. Set by wrappedOpenBrowser (below) before onPage runs — runEngine
    // awaits openBrowser before calling onPage, so this is populated in time.
    let runCdpPort = 0

    let server: ScreencastServer | undefined
    const onPage = screencast
        ? async (page: Page) => {
              server = await ScreencastServer.start(page)
              process.stdout.write(screencastLine({ port: server.port, cdpPort: runCdpPort }))
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
    // A re-armable "step-failure resolution" deferred, parallel to resume but carrying
    // the user's choice: waitForResolution awaits it; {type:'retry-step'} resolves
    // 'retry' and {type:'give-up'} resolves 'giveUp'. Re-armed after each hold so
    // multiple retries work.
    let resolutionResolve: ((d: 'retry' | 'giveUp') => void) | undefined
    let resolutionPromise: Promise<'retry' | 'giveUp'> | undefined
    const armResolution = () => {
        resolutionPromise = new Promise<'retry' | 'giveUp'>(r => (resolutionResolve = r))
    }
    // Recompile ONE suite from its .ts source, then cache-bust import it so an edited
    // suite's new code is picked up on retry. A monotonic counter (not Date.now) busts
    // Node's ESM URL cache. Reuses discoverSuites for import + Suite-shape validation.
    let reloadCounter = 0
    const reloadSuite = async (name: string): Promise<Suite> => {
        const src = path.join(repoDir(), 'src', 'suites', `${name}.ts`)
        const mjs = await compileSuite(src, suitesCompiledDir())
        const bust = `${pathToFileURL(mjs).href}?t=${++reloadCounter}`
        const found = await discoverSuites([bust], f => import(f))
        const fresh = found.find(s => s.name === name) ?? found[0]
        if (!fresh) throw new Error(`Reloaded ${name} but found no Suite export`)
        return fresh
    }
    const controlDeps = {
        shouldPause: (name: string) => pausedSet.has(name),
        onPaused: (name: string) => process.stdout.write(pausedLine({ name })),
        waitForResume: async () => {
            armResume()
            await resumePromise
        },
        // On a failed run the engine emits this then awaits waitForResume — holding
        // the browser open so the companion can attach to its CDP port. The GUI's
        // existing resume/stop path releases the hold (a {type:'resume'} control
        // message resolves waitForResume; Stop SIGTERMs the process group). Harmless
        // to always wire — the engine ONLY calls it when a run actually fails.
        onErrorHold: (info: {
            failureCategory?: import('@/engine/types').FailureCategory
            error?: string
        }) => process.stdout.write(errorHoldLine(info)),
        // In-process step retry. On a step throw the engine emits step-failed (holding
        // the browser open), then awaits waitForResolution. The companion edits the
        // suite; the user sends retry-step or give-up. reloadSuite picks up the edit.
        onStepFailed: (info: import('@/engine/types').StepFailedInfo) =>
            process.stdout.write(stepFailedLine(info)),
        waitForResolution: async () => {
            armResolution()
            const d = await resolutionPromise
            return d ?? 'giveUp'
        },
        reloadSuite,
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
                } else if (msg.type === 'retry-step') {
                    resolutionResolve?.('retry')
                } else if (msg.type === 'give-up') {
                    resolutionResolve?.('giveUp')
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
    // Wrap openBrowser to capture the run browser's CDP port for the screencast line.
    const baseOpenBrowser = base.openBrowser
    const wrappedOpenBrowser = async (env: Parameters<typeof baseOpenBrowser>[0]) => {
        const handle = await baseOpenBrowser(env)
        // cdpPort 0 = "no CDP port" (test fakes / headed deps omit it; production
        // always sets a real one). Consumers must treat 0 as "companion unavailable".
        runCdpPort = handle.cdpPort ?? 0
        return handle
    }
    // Persist the live run-state to <bundleDir>/run-state.json so the run companion
    // (Claude) can read the run's progress at a pause/error and after it finishes.
    let bundleDirForState: string | undefined
    let runStateWriteWarned = false
    const onBundleDir = (dir: string) => {
        bundleDirForState = dir
    }
    const onRunState = (state: RunState) => {
        if (!bundleDirForState) return
        const target = runStatePath(bundleDirForState)
        try {
            // Write to a temp file in the SAME directory, then rename over the
            // target — an atomic swap on the same filesystem — so the run companion
            // never observes a half-written (truncated) run-state.json.
            const tmp = `${target}.tmp`
            writeFileSync(tmp, JSON.stringify(state, null, 2))
            renameSync(tmp, target)
        } catch (e) {
            // best-effort: persisting run-state must never fail the run. Warn ONCE
            // (to stderr, which the GUI folds into stdout and ignores as non-JSON) so
            // a persistent failure is debuggable without spamming per step.
            if (!runStateWriteWarned) {
                runStateWriteWarned = true
                process.stderr.write(`[qar] could not write run-state.json: ${String(e)}\n`)
            }
        }
    }

    const deps = {
        ...base,
        openBrowser: wrappedOpenBrowser,
        onBundleDir,
        onRunState,
        onPage,
        ...controlDeps,
    }

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

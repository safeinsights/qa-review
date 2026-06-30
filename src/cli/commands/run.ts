import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { runEngine, defaultDeps } from '@/engine/run'
import { headedDeps } from '@/engine/run-headed'
import { stepLine, resultLine, screencastLine } from '@/cli/step-stream'
import { ScreencastServer } from '@/engine/screencast'
import type { Vars } from '@/engine/settings'
import type { Role, StepEvent } from '@/engine/types'
import type { Page } from '@playwright/test'

export async function runCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const role = (opts.role ?? 'admin') as Role
    const suite = opts.suite ?? 'signin'
    const json = opts.json === 'true'
    const headed = opts.headed === 'true'
    const screencast = opts.screencast === 'true'

    const envConfig = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)

    const onStep = json ? (e: StepEvent) => process.stdout.write(stepLine(e)) : undefined

    let server: ScreencastServer | undefined
    const onPage = screencast
        ? async (page: Page) => {
              server = await ScreencastServer.start(page)
              process.stdout.write(screencastLine({ port: server.port }))
          }
        : undefined

    // Screencast IS the view, so it doesn't need a headed window. Use headed only
    // if explicitly asked AND not screencasting.
    const base = headed && !screencast ? headedDeps(onStep, vars) : { ...defaultDeps(vars), onStep }
    const deps = { ...base, onPage }

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
    }
}

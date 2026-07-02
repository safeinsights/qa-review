import { sessionLine } from '@/cli/step-stream'
import { loginAs } from '@/engine/auth'
import { launchChromeWithCdp } from '@/engine/cdp-launch'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { ScreencastServer } from '@/engine/screencast'
import type { Vars } from '@/engine/settings'
import type { Role } from '@/engine/types'

// `qar session --role <r> (--env <name> | --pr <n>)` — a LONG-LIVED authoring
// session. Launches a logged-in browser with a CDP port, starts the screencast,
// prints `{"type":"session","cdpPort","screencastPort"}`, then stays alive until
// stdin closes or it receives SIGTERM/SIGINT — at which point it tears everything
// down. Unlike `run`, it never runs a suite and has no after-run teardown.
export async function sessionCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const role = (opts.role ?? 'admin') as Role
    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)

    // Launch with a fixed CDP port (retry once if the picked port got taken).
    const { browser, context, page, cdpPort } = await launchChromeWithCdp({ baseURL: env.baseURL })

    await loginAs(page, env, role)

    const server = await ScreencastServer.start(page)
    process.stdout.write(sessionLine({ cdpPort, screencastPort: server.port }))

    // Stay alive until told to stop. Shutdown signals:
    //  - SIGTERM/SIGINT (Go sends SIGTERM; Ctrl-C for manual testing).
    //  - stdin `end` when the GUI keeps stdin as a live pipe and later closes it.
    // A keepalive timer holds the event loop open; we deliberately do NOT exit on
    // a bare immediate stdin EOF (a backgrounded/redirected process would die at
    // once), so the primary stop signal is SIGTERM.
    await new Promise<void>(resolve => {
        let stopped = false
        const keepalive = setInterval(() => {}, 1 << 30)
        const stop = () => {
            if (stopped) return
            stopped = true
            clearInterval(keepalive)
            resolve()
        }
        process.on('SIGTERM', stop)
        process.on('SIGINT', stop)
    })

    await server.close().catch(() => {})
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
}

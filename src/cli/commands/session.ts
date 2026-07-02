import net from 'node:net'
import { sessionLine } from '@/cli/step-stream'
import { loginAs } from '@/engine/auth'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { ScreencastServer } from '@/engine/screencast'
import type { Vars } from '@/engine/settings'
import type { Role } from '@/engine/types'

// Pick a currently-free TCP port by binding to 0 and reading the assignment.
// There's a small TOCTOU window before chromium grabs it; the caller retries once.
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address()
            const port = typeof addr === 'object' && addr ? addr.port : 0
            srv.close(() => resolve(port))
        })
    })
}

// Launch the user's Chrome with a fixed remote-debugging port so chrome-devtools-mcp
// can attach over CDP (--browserUrl). Playwright's isolated temp user-data-dir
// satisfies Chrome 136+'s "no remote debugging on the default profile" rule.
async function launchWithCdp(baseURL: string, cdpPort: number) {
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({
        channel: 'chrome',
        args: [`--remote-debugging-port=${cdpPort}`],
    })
    const context = await browser.newContext({ baseURL })
    const page = await context.newPage()
    return { browser, context, page }
}

// `qar session --role <r> (--env <name> | --pr <n>)` — a LONG-LIVED authoring
// session. Launches a logged-in browser with a CDP port, starts the screencast,
// prints `{"type":"session","cdpPort","screencastPort"}`, then stays alive until
// stdin closes or it receives SIGTERM/SIGINT — at which point it tears everything
// down. Unlike `run`, it never runs a suite and has no after-run teardown.
export async function sessionCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const role = (opts.role ?? 'admin') as Role
    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)

    // Launch with a fixed CDP port (retry once if the picked port got taken).
    let launched: Awaited<ReturnType<typeof launchWithCdp>> | undefined
    let cdpPort = 0
    for (let attempt = 0; attempt < 2 && !launched; attempt++) {
        cdpPort = await freePort()
        try {
            launched = await launchWithCdp(env.baseURL, cdpPort)
        } catch (e) {
            if (attempt === 1) throw e
        }
    }
    if (!launched) throw new Error('Failed to launch browser with CDP')
    const { browser, context, page } = launched

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

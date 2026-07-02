import net from 'node:net'
import type { Browser, BrowserContext, Page } from '@playwright/test'

// Pick a currently-free TCP port by binding to 0 and reading the assignment.
// There's a small TOCTOU window before chromium grabs it; callers retry once.
export function freePort(): Promise<number> {
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

export interface CdpLaunch {
    browser: Browser
    context: BrowserContext
    page: Page
    cdpPort: number
}

// Launch the user's Chrome with a fixed remote-debugging port so chrome-devtools-mcp
// can attach over CDP (--browserUrl). Playwright's isolated temp user-data-dir
// satisfies Chrome 136+'s "no remote debugging on the default profile" rule.
// `contextOptions` lets callers add e.g. recordVideo without duplicating launch code.
// Retries once if the picked port is taken in the TOCTOU window.
export async function launchChromeWithCdp(
    contextOptions: Parameters<Browser['newContext']>[0]
): Promise<CdpLaunch> {
    const { chromium } = await import('@playwright/test')
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
        const cdpPort = await freePort()
        let browser: Browser | undefined
        try {
            browser = await chromium.launch({
                channel: 'chrome',
                args: [`--remote-debugging-port=${cdpPort}`],
            })
            const context = await browser.newContext(contextOptions)
            const page = await context.newPage()
            return { browser, context, page, cdpPort }
        } catch (e) {
            // A partial launch (context/page failed after the browser started)
            // would orphan a Chrome process — close it before retrying/throwing.
            await browser?.close().catch(() => {})
            lastErr = e
        }
    }
    throw lastErr ?? new Error('launchChromeWithCdp: exhausted retries')
}

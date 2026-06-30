import path from 'node:path'
import { resultsRoot as resultsRootDir } from '@/engine/paths'
import { defaultDeps } from '@/engine/run'
import type { RunDeps } from '@/engine/run'
import type { StepEvent } from '@/engine/types'

// Like defaultDeps(), but launches a VISIBLE Chromium so a QA tester can watch
// the run, and wires an optional live step sink. Reuses defaultDeps for
// everything except the browser launch.
export function headedDeps(onStep?: (e: StepEvent) => void, vars?: RunDeps['vars']): RunDeps {
    const base = defaultDeps(vars)
    const resultsRoot = resultsRootDir()
    return {
        ...base,
        onStep,
        openBrowser: async (env) => {
            const { chromium } = await import('@playwright/test')
            // Visible browser, but still the user's installed Chrome (channel:'chrome').
            const browser = await chromium.launch({ headless: false, channel: 'chrome' })
            const context = await browser.newContext({
                baseURL: env.baseURL,
                recordVideo: { dir: resultsRoot },
            })
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {})
            const page = await context.newPage()
            const video = page.video()
            let browserClosed = false
            const closeBrowser = async () => {
                if (browserClosed) return
                browserClosed = true
                await browser.close().catch(() => {})
            }
            return {
                page,
                cookieHeader: '',
                close: async () => {
                    await context.close().catch(() => {})
                },
                saveTraceTo: async (bundleDir: string) => {
                    await context.tracing.stop({ path: path.join(bundleDir, 'trace.zip') }).catch(() => {})
                },
                saveVideoTo: async (bundleDir: string) => {
                    try {
                        if (video) {
                            await video.saveAs(path.join(bundleDir, 'video.webm'))
                            await video.delete().catch(() => {})
                        }
                    } finally {
                        await closeBrowser()
                    }
                },
            }
        },
    }
}

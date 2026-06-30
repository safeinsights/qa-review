import path from 'node:path'
import { resultsRoot as resultsRootDir } from '@/engine/paths'
import { resolveEnv } from '@/engine/env'
import { Recorder } from '@/engine/recorder'
import { CleanupClient } from '@/engine/cleanup'
import { getSuite } from '@/engine/suite-registry'
import { loginAs, AuthError } from '@/engine/auth'
import type { RunRequest, RunResult, StepEvent, FailureCategory } from '@/engine/types'
import type { Suite, RunContext } from '@/suites/types'

export interface BrowserHandle {
    page: import('@playwright/test').Page
    cookieHeader: string
    close: () => Promise<void>
    // Stop tracing into <bundleDir>/trace.zip. Called BEFORE close() (tracing must
    // stop while the context is still open). Optional so test fakes can omit it.
    saveTraceTo?: (bundleDir: string) => Promise<void>
    saveVideoTo?: (bundleDir: string) => Promise<void>
}

// Injectable dependencies — production defaults in defaultDeps(); tests pass fakes.
export interface RunDeps {
    vars: Record<string, string | undefined>
    resultsRoot: string
    openBrowser: (env: { name: string; baseURL: string }) => Promise<BrowserHandle>
    login: (
        handle: BrowserHandle,
        env: ReturnType<typeof resolveEnv>,
        role: RunRequest['role'],
        bundleDir: string,
    ) => Promise<string>
    runCleanup: (client: CleanupClient) => Promise<RunResult['cleanup']>
    // Optional live step sink (the CLI --json mode prints each event). When
    // omitted, runs proceed without streaming.
    onStep?: (event: StepEvent) => void
    // Called once with the live Playwright page just after it's created, so a
    // caller (the CLI --screencast mode) can attach a screencast to it.
    onPage?: (page: import('@playwright/test').Page) => void | Promise<void>
}

function categorize(error: Error): FailureCategory {
    if (error instanceof AuthError) return 'auth'
    const m = error.message.toLowerCase()
    if (m.includes('econnrefused') || m.includes('net::') || m.includes('timeout') || m.includes('5xx')) return 'environment'
    // A failed web-first assertion / visibility wait reads as a real app issue.
    if (m.includes('visible') || m.includes('expect') || m.includes('tobe')) return 'app-assertion'
    return 'tool-crash'
}

export async function runEngine(req: RunRequest, deps: RunDeps, suiteOverride?: Suite): Promise<RunResult> {
    const startedAt = Date.now()
    const mode = req.mode ?? 'suite'
    const env = req.envConfig ?? resolveEnv(req.env, deps.vars)
    const suite = suiteOverride ?? (await getSuite(req.suite))

    // Collected step events for a future live-streaming consumer (e.g. the CLI/GUI
    // progress view). Not read here; recorder.finish() is the source of truth for steps.
    const events: StepEvent[] = []
    const recorder = new Recorder(
        { root: deps.resultsRoot, suite: suite.name, env: env.name, role: req.role, mode, startedAt },
        (e) => {
            events.push(e)
            deps.onStep?.(e)
        },
    )

    const cleanup = new CleanupClient(env.baseURL, '')
    const tag = `qa-${suite.name}-${startedAt}`

    let ok = true
    let failureCategory: FailureCategory | undefined
    let handle: BrowserHandle | undefined
    let cleanupResult: RunResult['cleanup'] = { ok: true, deleted: [], failed: [] }

    try {
        handle = await deps.openBrowser({ name: env.name, baseURL: env.baseURL })

        let cookieHeader: string
        try {
            cookieHeader = await deps.login(handle, env, req.role, recorder.bundleDir)
        } catch (cause) {
            // A failure in the login phase is always an auth failure, regardless
            // of the thrown error's class (tests inject a plain Error).
            throw new AuthError((cause as Error).message)
        }
        // The cleanup client authorizes via the admin session cookie.
        ;(cleanup as unknown as { cookieHeader: string }).cookieHeader = cookieHeader
        await deps.onPage?.(handle.page)

        let stepIndex = 0
        const page = handle.page
        const captureScreenshot = async (label: string): Promise<string | undefined> => {
            // Best-effort per-step still saved into the bundle. The recorder stays
            // Playwright-free; we hand it only the bundle-relative path. A capture
            // failure must never fail the step.
            const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)
            const rel = path.join('screenshots', `${String(++stepIndex).padStart(2, '0')}-${slug}.png`)
            try {
                // fullPage: capture the entire scrollable page, not just the
                // 1280×720 viewport, so the snapshot shows the whole page (the GUI
                // scrolls it within a fixed-size pane).
                //
                // `style` is injected only for the duration of this shot (Playwright
                // reverts it afterward). fullPage expands the viewport to the page's
                // scroll height and takes ONE shot — which leaves the app's
                // fixed-position footer stranded mid-image as a dark band. Hide just
                // the footer for the capture so the page reads top-to-bottom cleanly.
                await page.screenshot({
                    path: path.join(recorder.bundleDir, rel),
                    fullPage: true,
                    style: '.mantine-AppShell-footer{ display: none !important }',
                })
                return rel
            } catch {
                return undefined
            }
        }
        const ctx: RunContext = {
            page: handle.page,
            baseURL: env.baseURL,
            tag,
            async step(name, action) {
                recorder.step(name, 'running')
                try {
                    const out = await action()
                    const screenshot = await captureScreenshot(name)
                    recorder.step(name, 'passed', { screenshot })
                    return out
                } catch (cause) {
                    const screenshot = await captureScreenshot(name)
                    recorder.step(name, 'failed', { error: (cause as Error).message, screenshot })
                    throw cause
                }
            },
            trackStudy: (id) => cleanup.trackStudy(id),
            trackUser: (id) => cleanup.trackUser(id),
        }

        await suite.run(ctx)
    } catch (cause) {
        ok = false
        failureCategory = categorize(cause as Error)
    } finally {
        // Guaranteed teardown: cleanup runs no matter how we got here.
        cleanupResult = await deps.runCleanup(cleanup).catch((e): RunResult['cleanup'] => ({
            ok: false,
            deleted: [],
            failed: ['cleanup-call-threw'],
            error: (e as Error).message,
        }))
        // Stop tracing into the bundle BEFORE closing the context.
        await handle?.saveTraceTo?.(recorder.bundleDir).catch(() => {})
        await handle?.close().catch(() => {})
        // Best-effort: the recorded video is only finalized after the context
        // closes, so persist it into the bundle now. A missing video never fails the run.
        await handle?.saveVideoTo?.(recorder.bundleDir).catch(() => {})
    }

    // A passing run whose cleanup failed is surfaced with the 'cleanup' category
    // (leftover test data may remain) without marking the test itself as failed.
    if (ok && !cleanupResult.ok) failureCategory = 'cleanup'

    return recorder.finish({ ok, failureCategory, cleanup: cleanupResult })
}

// --- Production default deps ---

export function defaultDeps(vars: RunDeps['vars'] = process.env): RunDeps {
    const resultsRoot = resultsRootDir()
    return {
        vars,
        resultsRoot,
        openBrowser: async (env) => {
            const { chromium } = await import('@playwright/test')
            // channel:'chrome' drives the user's installed Google Chrome instead of
            // Playwright's bundled Chromium, so the packaged app needs no browser download.
            const browser = await chromium.launch({ channel: 'chrome' })
            const context = await browser.newContext({
                baseURL: env.baseURL,
                recordVideo: { dir: resultsRoot }, // moved into bundle after finish
            })
            // Capture a Playwright trace (DOM snapshots + screenshots + network +
            // console) so a tester can replay the whole run at trace.playwright.dev.
            // Best-effort: tracing must never fail the run.
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
                // Stop tracing (writing trace.zip into the bundle) BEFORE the
                // context closes, then close the context — which finalizes the
                // video while keeping `video.saveAs()` usable. Browser closes in
                // saveVideoTo (or the fallback below).
                close: async () => {
                    await context.close().catch(() => {})
                },
                saveTraceTo: async (bundleDir: string) => {
                    // Stop tracing straight into the bundle. Must run BEFORE close().
                    await context.tracing.stop({ path: path.join(bundleDir, 'trace.zip') }).catch(() => {})
                },
                saveVideoTo: async (bundleDir: string) => {
                    // Persist the finalized video into the run bundle so
                    // report.html's <video src="video.webm"> resolves, then remove
                    // the orphan source so results/ doesn't accumulate junk. Runs
                    // after close() (context already closed → video is finalized).
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
        login: async (handle, env, role, bundleDir) => loginAs(handle.page, env, role, bundleDir),
        runCleanup: async (client) => client.run(),
    }
}

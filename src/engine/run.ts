import path from 'node:path'
import { resultsRoot as resultsRootDir } from '@/engine/paths'
import { resolveEnv } from '@/engine/env'
import { Recorder } from '@/engine/recorder'
import { CleanupClient } from '@/engine/cleanup'
import { getSuite } from '@/engine/suite-registry'
import { loginAs, AuthError } from '@/engine/auth'
import type { RunRequest, RunResult, RunState, StepEvent, FailureCategory, ConsoleLine } from '@/engine/types'
import { buildRunState } from '@/engine/run-state'
import { mapConsoleLevel } from '@/engine/screencast-codec'
import type { Suite, RunContext } from '@/suites/types'

export interface BrowserHandle {
    page: import('@playwright/test').Page
    cookieHeader: string
    // The Chrome remote-debugging port this browser exposes, if launched with one
    // (production runs do; test fakes may omit). Lets the run companion attach.
    cdpPort?: number
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
    // Called ONCE with the run's bundle dir, right after the recorder is created
    // (before any step) — so a live consumer knows where to write run-state.json.
    onBundleDir?: (dir: string) => void
    // Called with the accumulated snapshot after each step event AND once with the
    // final result. The CLI persists it to <bundleDir>/run-state.json.
    onRunState?: (state: RunState) => void
    // Pause-before-step control (the CLI wires these to a stdin control channel).
    // Consulted before each step: if shouldPause returns true, onPaused fires and
    // the run blocks on waitForResume until the user resumes. All optional so a
    // run without a controller proceeds straight through.
    shouldPause?: (stepName: string) => boolean
    waitForResume?: () => Promise<void>
    onPaused?: (stepName: string) => void
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
            deps.onRunState?.(buildRunState(events))
        },
    )
    // Emit the bundle dir before any step so a live consumer knows where to
    // write run-state.json (recorder.bundleDir is ready right after construction).
    deps.onBundleDir?.(recorder.bundleDir)

    const cleanup = new CleanupClient(env.baseURL, '')
    const tag = `qa-${suite.name}-${startedAt}`

    let ok = true
    let failureCategory: FailureCategory | undefined
    let handle: BrowserHandle | undefined
    let cleanupResult: RunResult['cleanup'] = { ok: true, deleted: [], failed: [] }

    try {
        handle = await deps.openBrowser({ name: env.name, baseURL: env.baseURL })

        const page = handle.page
        // Attach the live view + console capture BEFORE login, so the screencast
        // and console see every page load from the very first — including the
        // login flow (e.g. the on-load Clerk "development keys" warning).
        await deps.onPage?.(page)

        let authToken: string
        try {
            authToken = await deps.login(handle, env, req.role, recorder.bundleDir)
        } catch (cause) {
            // A failure in the login phase is always an auth failure, regardless
            // of the thrown error's class (tests inject a plain Error).
            throw new AuthError((cause as Error).message)
        }
        // The cleanup client authorizes with the logged-in user's Clerk session
        // JWT (Bearer). deps.login returns it (loginAs -> getClerkToken).
        ;(cleanup as unknown as { authToken: string }).authToken = authToken

        let stepIndex = 0
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
        // Best-effort top-frame URL for the step's metadata — like the screenshot,
        // a failure here must never fail the step.
        const currentUrl = (): string | undefined => {
            try {
                return page.url()
            } catch {
                return undefined
            }
        }
        // Per-step console capture: buffer every console.* line + uncaught page
        // error for the whole run; ctx.step drains the slice accumulated since the
        // previous step. A single attachment survives navigations and loginAs().
        const consoleBuf: ConsoleLine[] = []
        const onConsole = (msg: import('@playwright/test').ConsoleMessage) =>
            consoleBuf.push({ level: mapConsoleLevel(msg.type()), text: msg.text(), at: Date.now(), url: msg.location()?.url })
        const onPageError = (err: Error) => consoleBuf.push({ level: 'error', text: String(err?.stack || err), at: Date.now() })
        page.on('console', onConsole)
        page.on('pageerror', onPageError)
        // Drain the console captured since the previous step (best-effort metadata;
        // undefined when a step logged nothing, matching currentUrl's optionality).
        const drainConsole = (): ConsoleLine[] | undefined => {
            const lines = consoleBuf.splice(0)
            return lines.length ? lines : undefined
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
                    recorder.step(name, 'passed', { screenshot, url: currentUrl(), console: drainConsole() })
                    return out
                } catch (cause) {
                    const screenshot = await captureScreenshot(name)
                    recorder.step(name, 'failed', { error: (cause as Error).message, screenshot, url: currentUrl(), console: drainConsole() })
                    throw cause
                }
            },
            trackStudy: (id) => cleanup.trackStudy(id),
            trackUser: (id) => cleanup.trackUser(id),
            // Results are decrypted as the reviewer, so surface the reviewer
            // account's private key. Undefined when unset (the suite errors clearly).
            resultsKey: env.accounts.reviewer.privateKey,
            async loginAs(role) {
                // Guaranteed clean slate before re-authenticating. Visiting
                // /account/signin while still signed in trips the app's
                // auto-signout (the sign-in form renders null while it clears the
                // session), which races the form hydration. Clearing cookies +
                // web storage first lands loginAs() on a hydrated, logged-out form.
                await handle!.page.context().clearCookies()
                await handle!.page
                    .evaluate(() => {
                        try {
                            localStorage.clear()
                            sessionStorage.clear()
                        } catch {
                            // storage may be inaccessible on some pages; best-effort.
                        }
                    })
                    .catch(() => {})
                // Re-drive Clerk as the new role (auth.ts navigates to /signin itself).
                const newToken = await deps.login(handle!, env, role, recorder.bundleDir)
                // Keep id-based cleanup authorized as the now-current user.
                ;(cleanup as unknown as { authToken: string }).authToken = newToken
            },
            // Per-run scratch bag threaded between steps (replaces the shared
            // locals a single run() body used to close over).
            state: {},
        }

        // Run the suite's steps in order. The pause gate sits BEFORE each step so
        // the browser idles at the boundary — the user can interact with the live
        // Chrome, then resume — before any of the step's actions fire.
        for (const step of suite.steps) {
            if (deps.shouldPause?.(step.name)) {
                deps.onPaused?.(step.name)
                await deps.waitForResume?.()
            }
            await step.run(ctx)
        }
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

    const result = recorder.finish({ ok, failureCategory, cleanup: cleanupResult })
    // Final snapshot carrying the result (running=false) — the last write the
    // CLI persists to run-state.json.
    deps.onRunState?.(buildRunState(events, result))
    return result
}

// --- Production default deps ---

export function defaultDeps(vars: RunDeps['vars'] = process.env): RunDeps {
    const resultsRoot = resultsRootDir()
    return {
        vars,
        resultsRoot,
        openBrowser: async (env) => {
            const { launchChromeWithCdp } = await import('@/engine/cdp-launch')
            // channel:'chrome' + a remote-debugging port: drives the user's installed
            // Google Chrome (so the packaged app needs no browser download) AND lets
            // the run companion attach chrome-devtools-mcp to this same browser when
            // the run is idle.
            const { browser, context, page, cdpPort } = await launchChromeWithCdp({
                baseURL: env.baseURL,
                recordVideo: { dir: resultsRoot }, // moved into bundle after finish
            })
            // Capture a Playwright trace (DOM snapshots + screenshots + network +
            // console) so a tester can replay the whole run at trace.playwright.dev.
            // Best-effort: tracing must never fail the run.
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {})
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
                cdpPort,
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

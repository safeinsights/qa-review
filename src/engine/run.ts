import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
    saveVideoTo?: (bundleDir: string) => Promise<void>
}

// Injectable dependencies — production defaults in defaultDeps(); tests pass fakes.
export interface RunDeps {
    vars: Record<string, string | undefined>
    resultsRoot: string
    openBrowser: (env: { name: string; baseURL: string }) => Promise<BrowserHandle>
    login: (handle: BrowserHandle, env: ReturnType<typeof resolveEnv>, role: RunRequest['role']) => Promise<string>
    runCleanup: (client: CleanupClient) => Promise<RunResult['cleanup']>
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
    const env = resolveEnv(req.env, deps.vars)
    const suite = suiteOverride ?? getSuite(req.suite)

    // Collected step events for a future live-streaming consumer (e.g. the CLI/GUI
    // progress view). Not read here; recorder.finish() is the source of truth for steps.
    const events: StepEvent[] = []
    const recorder = new Recorder(
        { root: deps.resultsRoot, suite: suite.name, env: env.name, role: req.role, mode, startedAt },
        (e) => events.push(e),
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
            cookieHeader = await deps.login(handle, env, req.role)
        } catch (cause) {
            // A failure in the login phase is always an auth failure, regardless
            // of the thrown error's class (tests inject a plain Error).
            throw new AuthError((cause as Error).message)
        }
        // The cleanup client authorizes via the admin session cookie.
        ;(cleanup as unknown as { cookieHeader: string }).cookieHeader = cookieHeader

        let stepIndex = 0
        const page = handle.page
        const captureScreenshot = async (label: string): Promise<string | undefined> => {
            // Best-effort per-step still saved into the bundle. The recorder stays
            // Playwright-free; we hand it only the bundle-relative path. A capture
            // failure must never fail the step.
            const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)
            const rel = path.join('screenshots', `${String(++stepIndex).padStart(2, '0')}-${slug}.png`)
            try {
                await page.screenshot({ path: path.join(recorder.bundleDir, rel) })
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

export function defaultDeps(): RunDeps {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const resultsRoot = path.resolve(here, '../../results')
    return {
        vars: process.env,
        resultsRoot,
        openBrowser: async (env) => {
            const { chromium } = await import('@playwright/test')
            const browser = await chromium.launch()
            const context = await browser.newContext({
                baseURL: env.baseURL,
                recordVideo: { dir: resultsRoot }, // moved into bundle after finish
            })
            const page = await context.newPage()
            const video = page.video()
            return {
                page,
                cookieHeader: '',
                close: async () => {
                    await context.close()
                    await browser.close()
                },
                saveVideoTo: async (bundleDir: string) => {
                    // Video is finalized only after context.close(); persist it into
                    // the run bundle so report.html's <video src="video.webm"> resolves,
                    // then remove the orphan source so results/ doesn't accumulate junk.
                    if (!video) return
                    await video.saveAs(path.join(bundleDir, 'video.webm'))
                    await video.delete().catch(() => {})
                },
            }
        },
        login: async (handle, env, role) => loginAs(handle.page, env, role),
        runCleanup: async (client) => client.run(),
    }
}

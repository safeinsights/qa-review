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

        const ctx: RunContext = {
            page: handle.page,
            baseURL: env.baseURL,
            tag,
            async step(name, action) {
                recorder.step(name, 'running')
                try {
                    const out = await action()
                    recorder.step(name, 'passed')
                    return out
                } catch (cause) {
                    recorder.step(name, 'failed', { error: (cause as Error).message })
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
    }

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
            return {
                page,
                cookieHeader: '',
                close: async () => {
                    await context.close()
                    await browser.close()
                },
            }
        },
        login: async (handle, env, role) => loginAs(handle.page, env, role),
        runCleanup: async (client) => client.run(),
    }
}

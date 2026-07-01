import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runEngine } from '@/engine/run'
import type { BrowserHandle } from '@/engine/run'
import type { Suite } from '@/suites/types'

const made: string[] = []
afterEach(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    made.length = 0
})
function tmpRoot() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-run-'))
    made.push(d)
    return d
}

const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    ADMIN_EMAIL: 'a@example.com', ADMIN_PASSWORD: 'p', ADMIN_MFA_CODE: '424242',
    RESEARCHER_EMAIL: 'r@example.com', RESEARCHER_PASSWORD: 'p', RESEARCHER_MFA_CODE: '424242',
    REVIEWER_EMAIL: 'v@example.com', REVIEWER_PASSWORD: 'p', REVIEWER_MFA_CODE: '424242',
}

function deps(overrides: Partial<Parameters<typeof runEngine>[1]> = {}) {
    return {
        vars: ENV_VARS,
        resultsRoot: tmpRoot(),
        openBrowser: vi.fn(async () => ({
            // Minimal fake page: ctx.loginAs() clears the context + web storage
            // before re-authenticating, so expose context().clearCookies + evaluate.
            // on/off are no-op stubs so the console-capture listeners attach.
            page: {
                context: () => ({ clearCookies: vi.fn(async () => {}) }),
                evaluate: vi.fn(async () => {}),
                url: () => 'https://app.qa.safeinsights.org/',
                on: vi.fn(),
                off: vi.fn(),
            } as never,
            cookieHeader: 'sid=abc',
            close: vi.fn(async () => {}),
        })),
        login: vi.fn(async () => 'sid=abc'),
        runCleanup: vi.fn(async () => ({ ok: true, deleted: [], failed: [] })),
        ...overrides,
    }
}

const passingSuite: Suite = {
    name: 'demo', description: '', roles: ['admin'],
    steps: [{ name: 'do thing', run: async (ctx) => { await ctx.step('do thing', async () => {}) } }],
}

describe('runEngine', () => {
    it('runs a passing suite and writes an ok bundle', async () => {
        const d = deps()
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(d.runCleanup).toHaveBeenCalledOnce()
        expect(fs.existsSync(path.join(result.bundleDir, 'summary.json'))).toBe(true)
    })

    it('attaches the console captured DURING a step to that step event', async () => {
        // Capture the page.on('console') handler the engine registers, then fire a
        // synthetic console message from inside the step so it lands in the buffer
        // that ctx.step drains onto the resolving event.
        let consoleHandler: ((msg: unknown) => void) | undefined
        const d = deps({
            openBrowser: vi.fn(async () => ({
                page: {
                    context: () => ({ clearCookies: vi.fn(async () => {}) }),
                    evaluate: vi.fn(async () => {}),
                    url: () => 'https://app.qa.safeinsights.org/',
                    on: vi.fn((event: string, handler: (msg: unknown) => void) => {
                        if (event === 'console') consoleHandler = handler
                    }),
                    off: vi.fn(),
                } as never,
                cookieHeader: 'sid=abc',
                close: vi.fn(async () => {}),
            })),
        })
        const suite: Suite = {
            name: 'demo', description: '', roles: ['admin'],
            steps: [{
                name: 'logs',
                run: async (ctx) => {
                    await ctx.step('logs', async () => {
                        // Simulate a Playwright ConsoleMessage during the step.
                        consoleHandler?.({ type: () => 'error', text: () => 'kaboom', location: () => ({ url: 'x.js' }) })
                    })
                },
            }],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, suite)
        const step = result.steps.find((s) => s.name === 'logs' && s.status === 'passed')
        expect(step?.console).toBeDefined()
        expect(step?.console?.[0]).toMatchObject({ level: 'error', text: 'kaboom', url: 'x.js' })
    })

    it('categorizes a thrown assertion as app-assertion and STILL runs cleanup', async () => {
        const d = deps()
        const failingSuite: Suite = {
            name: 'demo', description: '', roles: ['admin'],
            steps: [{ name: 'boom', run: async (ctx) => { await ctx.step('boom', async () => { throw new Error('expected X to be visible') }) } }],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, failingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('app-assertion')
        expect(d.runCleanup).toHaveBeenCalledOnce() // guaranteed teardown
    })

    it('categorizes login failure as auth and still runs cleanup', async () => {
        const d = deps({ login: vi.fn(async () => { throw new Error('OTP rejected') }) })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('auth')
        expect(d.runCleanup).toHaveBeenCalledOnce()
    })

    it('surfaces a cleanup failure on an otherwise-passing run', async () => {
        const d = deps({ runCleanup: vi.fn(async () => ({ ok: false, deleted: [], failed: ['study:s1'] })) })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true) // the test itself passed
        expect(result.cleanup.ok).toBe(false)
        expect(result.cleanup.failed).toEqual(['study:s1'])
    })

    it('categorizes an openBrowser failure as environment and still runs cleanup', async () => {
        const d = deps({
            openBrowser: vi.fn(async () => {
                throw new Error('net::ERR_CONNECTION_REFUSED')
            }),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('environment')
        expect(d.runCleanup).toHaveBeenCalledOnce()
    })

    it('records cleanup-call-threw when runCleanup itself throws', async () => {
        const d = deps({
            runCleanup: vi.fn(async () => {
                throw new Error('boom')
            }),
        })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.cleanup.ok).toBe(false)
        expect(result.cleanup.failed).toEqual(['cleanup-call-threw'])
        expect(result.cleanup.error).toBe('boom')
    })

    it('assigns the cleanup failure category on a passing run whose cleanup failed', async () => {
        const d = deps({ runCleanup: vi.fn(async () => ({ ok: false, deleted: [], failed: ['study:s1'] })) })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(result.failureCategory).toBe('cleanup')
    })

    it('lets a suite switch roles mid-run via ctx.loginAs (re-drives login)', async () => {
        const d = deps()
        const twoRoleSuite: Suite = {
            name: 'demo', description: '', roles: ['researcher'],
            steps: [
                { name: 'as researcher', run: async (ctx) => { await ctx.step('as researcher', async () => {}) } },
                { name: 'as reviewer', run: async (ctx) => { await ctx.loginAs('reviewer'); await ctx.step('as reviewer', async () => {}) } },
            ],
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'researcher' }, d, twoRoleSuite)
        expect(result.ok).toBe(true)
        // Once for the initial engine login, once for the mid-run switch.
        const login = d.login as ReturnType<typeof vi.fn>
        expect(login).toHaveBeenCalledTimes(2)
        expect(login.mock.calls[1][2]).toBe('reviewer')
    })

    it('invokes deps.onStep for each step event as it happens', async () => {
        const seen: string[] = []
        const d = deps({ onStep: (e) => seen.push(`${e.name}:${e.status}`) })
        await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(seen).toContain('do thing:running')
        expect(seen).toContain('do thing:passed')
    })

    it('halts BEFORE a paused step: onPaused fires and waitForResume is awaited before running', async () => {
        const seen: string[] = []
        let resolveResume!: () => void
        const resumeGate = new Promise<void>((r) => (resolveResume = r))
        const twoStep: Suite = {
            name: 'demo', description: '', roles: ['admin'],
            steps: [
                { name: 'first', run: async (ctx) => { await ctx.step('first', async () => {}) } },
                { name: 'second', run: async (ctx) => { await ctx.step('second', async () => {}) } },
            ],
        }
        const d = deps({
            onStep: (e) => seen.push(`${e.name}:${e.status}`),
            shouldPause: (name) => name === 'second',
            onPaused: (name) => seen.push(`paused:${name}`),
            // Resolve on the next tick so the ordering assertion is meaningful:
            // the run must be blocked here until we let it go.
            waitForResume: () => resumeGate,
        })
        const runPromise = runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, twoStep)
        // Let the first step finish and the gate register before resuming.
        await new Promise((r) => setTimeout(r, 10))
        expect(seen).toContain('first:passed')
        expect(seen).toContain('paused:second')
        // Crucially, 'second' has NOT started running while paused.
        expect(seen).not.toContain('second:running')
        resolveResume()
        const result = await runPromise
        expect(result.ok).toBe(true)
        // After resume, the second step runs to completion.
        expect(seen.indexOf('paused:second')).toBeLessThan(seen.indexOf('second:running'))
        expect(seen).toContain('second:passed')
    })

    it('exposes the browser handle cdpPort to an onPage/screencast consumer', async () => {
        // The handle openBrowser returns carries the Chrome remote-debugging port;
        // a consumer (the run companion / screencast) reads it right after openBrowser.
        const handle: BrowserHandle = {
            page: {
                context: () => ({ clearCookies: vi.fn(async () => {}) }),
                evaluate: vi.fn(async () => {}),
                url: () => 'https://app.qa.safeinsights.org/',
                on: vi.fn(),
                off: vi.fn(),
            } as never,
            cookieHeader: 'sid=abc',
            cdpPort: 54321,
            close: vi.fn(async () => {}),
        }
        let seenPort: number | undefined
        const d = deps({
            openBrowser: vi.fn(async () => handle),
            onPage: async () => {
                seenPort = handle.cdpPort
            },
        })
        await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(seenPort).toBe(54321)
    })

    it('runs straight through when shouldPause returns false', async () => {
        const onPaused = vi.fn()
        const d = deps({ shouldPause: () => false, onPaused, waitForResume: async () => {} })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(onPaused).not.toHaveBeenCalled()
    })
})

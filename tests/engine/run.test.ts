import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runEngine } from '@/engine/run'
import type { Suite } from '@/suites/types'

const made: string[] = []
afterEach(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    made.length = 0
})
function tmpRoot() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qatest-run-'))
    made.push(d)
    return d
}

const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    QA_ADMIN_EMAIL: 'a@example.com', QA_ADMIN_PASSWORD: 'p',
    QA_RESEARCHER_EMAIL: 'r@example.com', QA_RESEARCHER_PASSWORD: 'p',
    QA_REVIEWER_EMAIL: 'v@example.com', QA_REVIEWER_PASSWORD: 'p',
}

function deps(overrides: Partial<Parameters<typeof runEngine>[1]> = {}) {
    return {
        vars: ENV_VARS,
        resultsRoot: tmpRoot(),
        openBrowser: vi.fn(async () => ({
            page: {} as never,
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
    async run(ctx) { await ctx.step('do thing', async () => {}) },
}

describe('runEngine', () => {
    it('runs a passing suite and writes an ok bundle', async () => {
        const d = deps()
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(d.runCleanup).toHaveBeenCalledOnce()
        expect(fs.existsSync(path.join(result.bundleDir, 'summary.json'))).toBe(true)
    })

    it('categorizes a thrown assertion as app-assertion and STILL runs cleanup', async () => {
        const d = deps()
        const failingSuite: Suite = {
            name: 'demo', description: '', roles: ['admin'],
            async run(ctx) { await ctx.step('boom', async () => { throw new Error('expected X to be visible') }) },
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
})

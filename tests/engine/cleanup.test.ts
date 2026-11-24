import { describe, expect, it, vi } from 'vitest'
import { CleanupClient, parseIdList } from '@/engine/cleanup'

type Reply = { status: number; body?: unknown; html?: boolean }

// Real Response objects, so the JSON-vs-HTML 404 distinction is exercised as the
// client actually reads it.
function reply({ status, body, html }: Reply): Response {
    if (html) {
        return new Response('<!DOCTYPE html><html></html>', {
            status,
            headers: { 'content-type': 'text/html' },
        })
    }
    const text = body === undefined ? '' : JSON.stringify(body)
    return new Response(status === 204 ? null : text, {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function fakeFetch(responses: Record<string, Reply>) {
    return vi.fn(async (url: string, _init?: RequestInit) => {
        const key = Object.keys(responses).find(k => url.endsWith(k))
        return reply(key ? responses[key] : { status: 500, body: { error: 'boom' } })
    })
}

const notFound = (what: string): Reply => ({ status: 404, body: { error: `${what} not found` } })

describe('CleanupClient', () => {
    it('deletes every tracked id and reports success', async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/study-1': { status: 200, body: { deleted: 'study-1' } },
            '/api/qa/users/user-1': { status: 200, body: { deleted: 'user-1' } },
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('study-1')
        client.trackUser('user-1')

        const result = await client.run()

        expect(result.ok).toBe(true)
        expect(result.deleted.sort()).toEqual(['study:study-1', 'user:user-1'])
        expect(result.failed).toEqual([])
        expect(result.errors).toBeUndefined()
        // Studies first: a study's owner FK references the user.
        expect(fetchImpl.mock.calls[0][0] as string).toContain('/api/qa/studies/study-1')
        // Bearer, not a cookie: the /api/qa endpoints only read the Authorization header.
        const init = fetchImpl.mock.calls[0][1] as RequestInit
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sid=abc')
        expect((init.headers as Record<string, string>).Cookie).toBeUndefined()
    })

    it('deletes all studies before any users when multiple ids are tracked', async () => {
        const ok = { status: 200, body: {} }
        const fetchImpl = fakeFetch({
            '/api/qa/studies/s1': ok,
            '/api/qa/studies/s2': ok,
            '/api/qa/users/u1': ok,
            '/api/qa/users/u2': ok,
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('s1')
        client.trackUser('u1')
        client.trackStudy('s2')
        client.trackUser('u2')

        await client.run()

        const urls = fetchImpl.mock.calls.map(c => c[0] as string)
        const lastStudyIdx = urls.map(u => u.includes('/api/qa/studies/')).lastIndexOf(true)
        const firstUserIdx = urls.findIndex(u => u.includes('/api/qa/users/'))
        expect(lastStudyIdx).toBeLessThan(firstUserIdx)
    })

    it('URL-encodes a user email so "+" and "@" reach the route intact', async () => {
        const fetchImpl = fakeFetch({ '/api/qa/users/qa-a%2B1%40x.org': { status: 200, body: {} } })
        const client = new CleanupClient('https://qa.example.com', 't', fetchImpl)
        client.trackUser('qa-a+1@x.org')

        const result = await client.run()

        expect(result.ok).toBe(true)
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://qa.example.com/api/qa/users/qa-a%2B1%40x.org'
        )
    })

    it('records a failure with the reason (does not throw) when fetch rejects', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNREFUSED')
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('s1')

        const result = await client.run()

        expect(result.ok).toBe(false)
        expect(result.failed).toEqual(['study:s1'])
        expect(result.statuses).toEqual({ 'study:s1': 0 })
        expect(result.errors).toEqual({ 'study:s1': 'ECONNREFUSED' })
    })

    it('marks ok=false and records the failing status when a delete returns non-2xx', async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/study-1': { status: 500, body: { error: 'db down' } },
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('study-1')

        const result = await client.run()

        expect(result.ok).toBe(false)
        expect(result.failed).toEqual(['study:study-1'])
        expect(result.statuses).toEqual({ 'study:study-1': 500 })
        expect(result.errors).toEqual({ 'study:study-1': 'db down' })
    })

    // The server uses 403 for two different refusals; only its message tells them apart.
    it("carries the server's reason for a 403", async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/s1': { status: 403, body: { error: 'admin access required' } },
            '/api/qa/studies/s2': {
                status: 403,
                body: {
                    error: 'study s2 researcher is not a QA account; expected an email starting with "qa-"',
                },
            },
        })
        const client = new CleanupClient('https://qa.example.com', 't', fetchImpl)
        client.trackStudy('s1')
        client.trackStudy('s2')

        const result = await client.run()

        expect(result.errors?.['study:s1']).toBe('admin access required')
        expect(result.errors?.['study:s2']).toMatch(/not a QA account/)
    })

    it("treats the route's own JSON 404 as already-deleted — cleanup is idempotent", async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/gone': notFound('study gone'),
            '/api/qa/users/gone': notFound('user gone'),
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('gone')
        client.trackUser('gone')

        const result = await client.run()

        expect(result.ok).toBe(true)
        expect(result.failed).toEqual([])
        expect(result.deleted.sort()).toEqual(['study:gone', 'user:gone'])
    })

    // An HTML 404 is the app's page for a route that does not exist: nothing was deleted.
    it('fails an HTML 404 instead of reading a missing route as success', async () => {
        const fetchImpl = fakeFetch({ '/api/qa/studies/s1': { status: 404, html: true } })
        const client = new CleanupClient('https://qa.example.com', 't', fetchImpl)
        client.trackStudy('s1')

        const result = await client.run()

        expect(result.ok).toBe(false)
        expect(result.failed).toEqual(['study:s1'])
        expect(result.errors?.['study:s1']).toMatch(/route itself was not found/)
    })

    it('fails a JSON 404 that is not a "not found" message', async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/s1': { status: 404, body: { error: 'gateway' } },
        })
        const client = new CleanupClient('https://qa.example.com', 't', fetchImpl)
        client.trackStudy('s1')

        expect((await client.run()).ok).toBe(false)
    })

    it('is a no-op (ok=true) when nothing was tracked', async () => {
        const fetchImpl = fakeFetch({})
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        const result = await client.run()
        expect(result).toEqual({ ok: true, deleted: [], failed: [], statuses: {} })
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})

describe('parseIdList', () => {
    const A = '01a20ee2-df1e-7538-b33b-5da805ec1563'
    const B = '01a20ee3-3c7e-76ed-8acc-215557ce69a5'

    // Found live: "x, <id>" sent " <id>", got a 404 and reported a real study deleted.
    it('trims entries and drops empty ones', () => {
        expect(parseIdList(` ${A} , ${B},,`, 'study')).toEqual({ ids: [A, B], invalid: [] })
    })

    it('rejects a non-UUID study id', () => {
        expect(parseIdList(`${A},not-a-uuid`, 'study')).toEqual({
            ids: [A],
            invalid: ['not-a-uuid'],
        })
    })

    // `--studies --users X` made the parser hand "--users" over as a study id.
    it('rejects a flag swallowed as a value', () => {
        expect(parseIdList('--users', 'study').invalid).toEqual(['--users'])
    })

    it('accepts an email for a user but not for a study', () => {
        expect(parseIdList('qa-invite-1@qa.safeinsights.org', 'user').ids).toEqual([
            'qa-invite-1@qa.safeinsights.org',
        ])
        expect(parseIdList('qa-invite-1@qa.safeinsights.org', 'study').invalid).toHaveLength(1)
    })

    it('returns nothing for an absent or empty list', () => {
        expect(parseIdList(undefined, 'user')).toEqual({ ids: [], invalid: [] })
        expect(parseIdList('', 'user')).toEqual({ ids: [], invalid: [] })
    })
})

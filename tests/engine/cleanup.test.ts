import { describe, it, expect, vi } from 'vitest'
import { CleanupClient } from '@/engine/cleanup'

function fakeFetch(responses: Record<string, { status: number }>) {
    return vi.fn(async (url: string, _init?: RequestInit) => {
        const key = Object.keys(responses).find((k) => url.endsWith(k))
        const status = key ? responses[key].status : 500
        return { status, ok: status >= 200 && status < 300, json: async () => ({}) } as Response
    })
}

describe('CleanupClient', () => {
    it('deletes every tracked id and reports success', async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/study-1': { status: 200 },
            '/api/qa/users/user-1': { status: 200 },
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('study-1')
        client.trackUser('user-1')

        const result = await client.run()

        expect(result.ok).toBe(true)
        expect(result.deleted.sort()).toEqual(['study:study-1', 'user:user-1'])
        expect(result.failed).toEqual([])
        // Studies deleted before users (a study FK references its owner user).
        expect((fetchImpl.mock.calls[0][0] as string)).toContain('/api/qa/studies/study-1')
    })

    it('deletes all studies before any users when multiple ids are tracked', async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/s1': { status: 200 },
            '/api/qa/studies/s2': { status: 200 },
            '/api/qa/users/u1': { status: 200 },
            '/api/qa/users/u2': { status: 200 },
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('s1')
        client.trackUser('u1')
        client.trackStudy('s2')
        client.trackUser('u2')

        await client.run()

        const urls = fetchImpl.mock.calls.map((c) => c[0] as string)
        const lastStudyIdx = urls.map((u) => u.includes('/api/qa/studies/')).lastIndexOf(true)
        const firstUserIdx = urls.findIndex((u) => u.includes('/api/qa/users/'))
        expect(lastStudyIdx).toBeLessThan(firstUserIdx)
    })

    it('records a failure (does not throw) when fetch rejects', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNREFUSED')
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('s1')

        const result = await client.run()

        expect(result.ok).toBe(false)
        expect(result.failed).toEqual(['study:s1'])
    })

    it('marks ok=false and records the failing status when a delete returns non-2xx', async () => {
        const fetchImpl = fakeFetch({ '/api/qa/studies/study-1': { status: 500 } })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('study-1')

        const result = await client.run()

        expect(result.ok).toBe(false)
        expect(result.failed).toEqual(['study:study-1'])
        expect(result.statuses).toEqual({ 'study:study-1': 500 })
    })

    it('is a no-op (ok=true) when nothing was tracked', async () => {
        const fetchImpl = fakeFetch({})
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        const result = await client.run()
        expect(result).toEqual({ ok: true, deleted: [], failed: [], statuses: {} })
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})

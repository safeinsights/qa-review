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

    it('marks ok=false and records failures when a delete returns non-2xx', async () => {
        const fetchImpl = fakeFetch({ '/api/qa/studies/study-1': { status: 500 } })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('study-1')

        const result = await client.run()

        expect(result.ok).toBe(false)
        expect(result.failed).toEqual(['study:study-1'])
    })

    it('is a no-op (ok=true) when nothing was tracked', async () => {
        const fetchImpl = fakeFetch({})
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        const result = await client.run()
        expect(result).toEqual({ ok: true, deleted: [], failed: [] })
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})

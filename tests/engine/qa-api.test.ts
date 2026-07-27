import { describe, expect, it, vi } from 'vitest'
import { QaApiClient } from '@/engine/qa-api'

const BASE = 'https://app.qa.example.com'
const TOKEN = 'jwt-abc'

function jsonRes(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as Response
}

describe('QaApiClient.provisionUser', () => {
    it('PATCHes the update with a Bearer token and returns the result', async () => {
        const result = {
            userId: 'u1',
            orgs: [{ slug: 'openstax', isAdmin: false }],
            fingerprint: 'ab12',
            passwordSet: true,
        }
        const fetchImpl = vi.fn(async () => jsonRes(200, result))
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)

        await expect(
            api.provisionUser('qa-reviewer@example.com', { password: 's3cret' })
        ).resolves.toEqual(result)

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        // The email travels in the path segment, so it must be encoded.
        expect(url).toBe(`${BASE}/api/qa/users/qa-reviewer%40example.com`)
        expect(init.method).toBe('PATCH')
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
        expect(JSON.parse(init.body as string)).toEqual({ password: 's3cret' })
    })

    it('sends only the fields given, so omitted ones stay untouched', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonRes(200, { userId: 'u1', orgs: [], fingerprint: null, passwordSet: false })
        )
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)
        await api.provisionUser('u1', { publicKey: '-----BEGIN PUBLIC KEY-----\nx\n' })
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        expect(Object.keys(JSON.parse(init.body as string))).toEqual(['publicKey'])
    })

    // An empty orgs array is meaningful (it clears memberships), so it must survive
    // serialization rather than being dropped as falsy.
    it('preserves an explicit empty orgs array', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonRes(200, { userId: 'u1', orgs: [], fingerprint: null, passwordSet: false })
        )
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)
        await api.provisionUser('u1', { orgs: [] })
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        expect(JSON.parse(init.body as string)).toEqual({ orgs: [] })
    })

    it('surfaces the server error text, and explains a 403', async () => {
        const fetchImpl = vi.fn(async () => jsonRes(403, { error: 'is not a QA account' }))
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)
        await expect(api.provisionUser('real@example.com', { password: 'x' })).rejects.toThrow(
            /HTTP 403.*is not a QA account.*local part starts with "qa"/s
        )
    })

    it('includes Zod validation details on a 400', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonRes(400, { error: 'invalid request body', details: [{ path: ['orgs'] }] })
        )
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)
        await expect(api.provisionUser('qa-x@example.com', {})).rejects.toThrow(/orgs/)
    })
})

describe('QaApiClient.createInvite', () => {
    it('POSTs the invite and returns the URL', async () => {
        const result = {
            inviteId: 'i1',
            email: 'qa-new@example.com',
            orgSlug: 'openstax-lab',
            inviteUrl: 'https://app.qa.example.com/invite/abc',
            alreadyInvited: false,
        }
        const fetchImpl = vi.fn(async () => jsonRes(201, result))
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)

        await expect(
            api.createInvite({ email: 'qa-new@example.com', orgSlug: 'openstax-lab' })
        ).resolves.toEqual(result)

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe(`${BASE}/api/qa/invites`)
        expect(init.method).toBe('POST')
        expect(JSON.parse(init.body as string)).toEqual({
            email: 'qa-new@example.com',
            orgSlug: 'openstax-lab',
            isAdmin: undefined,
        })
    })

    // A reused outstanding invite answers 200 (not 201) and is still a success.
    it('accepts a reused invite (200 with alreadyInvited)', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonRes(200, {
                inviteId: 'i1',
                email: 'qa-new@example.com',
                orgSlug: 'openstax',
                inviteUrl: 'https://x/invite/abc',
                alreadyInvited: true,
            })
        )
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)
        const res = await api.createInvite({ email: 'qa-new@example.com', orgSlug: 'openstax' })
        expect(res.alreadyInvited).toBe(true)
    })

    it('surfaces a 409 conflict', async () => {
        const fetchImpl = vi.fn(async () => jsonRes(409, { error: 'already a member' }))
        const api = new QaApiClient(BASE, TOKEN, fetchImpl)
        await expect(
            api.createInvite({ email: 'qa-x@example.com', orgSlug: 'openstax' })
        ).rejects.toThrow(/HTTP 409.*already a member/)
    })
})

// The generated invite address MUST start with "qa": the management-app's QA
// endpoints guard every account they touch with assertQaEmail (local part /^qa/i),
// so a non-qa address is refused with a 403 — and worse, couldn't be cleaned up.
describe('uniqueQaEmail', () => {
    it('always produces a qa-prefixed, unique address', async () => {
        const { uniqueQaEmail } = await import('@/engine/flows/signup')
        const seen = new Set<string>()
        for (let i = 0; i < 50; i++) {
            const email = uniqueQaEmail()
            expect(email.split('@')[0]).toMatch(/^qa/i)
            expect(email).toMatch(/^[^@]+@[^@]+\.[^@]+$/)
            seen.add(email)
        }
        expect(seen.size).toBe(50)
    })
})

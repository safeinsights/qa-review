import { describe, expect, it } from 'vitest'
import { activeDomain, createInbox, deleteInbox, extractSignupUrl } from '@/engine/mailtm'

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

// These once called the real mail.tm. That made a unit test depend on a free-tier
// public API: it 429s under any burst (a few `pnpm test` runs in a row is enough)
// and fails offline, so CI went red for reasons that had nothing to do with our
// code. The client's retry/backoff is covered separately in "mail.tm api retry"
// below — what's left to prove here is that we send the right requests and parse
// the responses, which a fake serves better than the network. It also lets us
// assert the DELETE's URL and auth header, which the live version never could.
describe('mail.tm client', () => {
    // A minimal stand-in for the API: records every request, and answers the four
    // endpoints the client uses with mail.tm's real response shapes.
    function fakeMailTm() {
        const calls: { method: string; path: string; auth?: string; body?: unknown }[] = []
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            const path = String(url).replace('https://api.mail.tm', '')
            const method = init?.method ?? 'GET'
            const headers = (init?.headers ?? {}) as Record<string, string>
            const body = init?.body ? JSON.parse(String(init.body)) : undefined
            calls.push({ method, path, auth: headers.Authorization, body })

            if (path === '/domains') {
                return jsonResponse(
                    {
                        'hydra:member': [
                            { domain: 'inactive.test', isActive: false },
                            { domain: 'web-library.test', isActive: true },
                        ],
                    },
                    200
                )
            }
            if (path === '/accounts' && method === 'POST') {
                // mail.tm echoes the address back on create.
                return jsonResponse({ id: 'acct-42', address: body?.address }, 201)
            }
            if (path === '/token') {
                return jsonResponse({ token: 'a-token-long-enough' }, 200)
            }
            if (path.startsWith('/accounts/') && method === 'DELETE') {
                return new Response(null, { status: 204 })
            }
            throw new Error(`unexpected request: ${method} ${path}`)
        }) as unknown as typeof fetch
        return { calls, fetchImpl }
    }

    it('returns the first ACTIVE domain, skipping inactive ones', async () => {
        const { fetchImpl } = fakeMailTm()
        const realFetch = globalThis.fetch
        globalThis.fetch = fetchImpl
        try {
            expect(await activeDomain()).toBe('web-library.test')
        } finally {
            globalThis.fetch = realFetch
        }
    })

    it('creates a usable inbox and deletes it', async () => {
        const { calls, fetchImpl } = fakeMailTm()
        const realFetch = globalThis.fetch
        globalThis.fetch = fetchImpl
        try {
            const domain = await activeDomain()
            const inbox = await createInbox(domain)
            expect(inbox.address).toContain(`@${domain}`)
            expect(inbox.token.length).toBeGreaterThan(10)
            expect(inbox.id).toBeTruthy()

            await deleteInbox(inbox) // must not throw
        } finally {
            globalThis.fetch = realFetch
        }

        // The account is created and the token fetched with the SAME credentials —
        // a mismatch would yield an inbox whose token can't read its own mail.
        const create = calls.find(c => c.path === '/accounts' && c.method === 'POST')
        const token = calls.find(c => c.path === '/token')
        const creds = create?.body as { address: string; password: string }
        expect(token?.body).toEqual(creds)

        // Cleanup must target the created account and carry its bearer token;
        // without either, the account silently outlives the run.
        const del = calls.find(c => c.method === 'DELETE')
        expect(del?.path).toBe('/accounts/acct-42')
        expect(del?.auth).toBe('Bearer a-token-long-enough')
    })
})

describe('createInbox address (qa-prefixed)', () => {
    // The management-app's QA endpoints run on production and reject any account
    // whose email local part doesn't start with "qa" (assertQaEmail: /^qa/i). If a
    // created inbox weren't qa-prefixed, cleanup would 403 and orphan a real
    // account. Pin the prefix here so a rename of the local part trips CI, not prod.
    // Mock fetch so this is deterministic and offline (no live mail.tm dependency).
    it('generates a local part that starts with "qa"', async () => {
        const realFetch = globalThis.fetch
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            const path = String(url)
            if (path.includes('/token')) {
                return jsonResponse({ token: 'tok' }, 200)
            }
            // POST /accounts: echo back the address it was sent, as mail.tm does —
            // so the test exercises the real generated local part (not a stub).
            const sent = JSON.parse(String(init?.body ?? '{}')) as { address?: string }
            return jsonResponse({ id: 'id-1', address: sent.address }, 201)
        }) as unknown as typeof fetch
        try {
            const { createInbox } = await import('@/engine/mailtm')
            const inbox = await createInbox('example.test')
            const localPart = inbox.address.split('@')[0]
            // Same rule the management-app enforces (assertQaEmail).
            expect(localPart).toMatch(/^qa/i)
        } finally {
            globalThis.fetch = realFetch
        }
    })
})

describe('extractSignupUrl', () => {
    it('pulls the invite/accept URL from message text', () => {
        const msg = {
            id: 'x',
            subject: 'You have been invited',
            from: 'noreply@safeinsights.org',
            text: 'Welcome! Click https://pr123.qa.safeinsights.org/account/signup?invite=abc123 to join. Unsubscribe: https://example.com/unsub',
            html: '',
        }
        expect(extractSignupUrl(msg)).toBe(
            'https://pr123.qa.safeinsights.org/account/signup?invite=abc123'
        )
    })

    it('throws when no signup URL is present', () => {
        const msg = { id: 'x', subject: '', from: '', text: 'no links here', html: '' }
        expect(() => extractSignupUrl(msg)).toThrow(/no signup url/i)
    })

    it('decodes &amp; in an HTML-body invite link', () => {
        const msg = {
            id: 'x',
            subject: 'invite',
            from: 'noreply@safeinsights.org',
            text: '',
            html: '<a href="https://pr9.qa.safeinsights.org/account/signup?token=abc&amp;org=xyz">Accept</a>',
        }
        expect(extractSignupUrl(msg)).toBe(
            'https://pr9.qa.safeinsights.org/account/signup?token=abc&org=xyz'
        )
    })

    it('does not double-unescape a pre-escaped entity in the URL', () => {
        // "&amp;lt;" must decode to the literal "&lt;" (one pass), NOT collapse to
        // "<" — decoding the &amp; first and re-scanning would double-unescape.
        const msg = {
            id: 'x',
            subject: 'invite',
            from: 'noreply@safeinsights.org',
            text: '',
            html: '<a href="https://pr9.qa.safeinsights.org/account/signup?q=a&amp;lt;b">Accept</a>',
        }
        expect(extractSignupUrl(msg)).toBe(
            'https://pr9.qa.safeinsights.org/account/signup?q=a&lt;b'
        )
    })

    it('strips trailing sentence punctuation', () => {
        const msg = {
            id: 'x',
            subject: 'invite',
            from: '',
            text: 'Accept your invite at https://pr9.qa.safeinsights.org/invite/abc123.',
            html: '',
        }
        expect(extractSignupUrl(msg)).toBe('https://pr9.qa.safeinsights.org/invite/abc123')
    })
})

describe('mail.tm api retry', () => {
    it('retries a 429 then succeeds (activeDomain)', async () => {
        const realFetch = globalThis.fetch
        let calls = 0
        globalThis.fetch = (async () => {
            calls += 1
            if (calls === 1) {
                return new Response('rate limited', { status: 429 })
            }
            return new Response(
                JSON.stringify({ 'hydra:member': [{ domain: 'example.test', isActive: true }] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        }) as typeof fetch
        try {
            const { activeDomain } = await import('@/engine/mailtm')
            const domain = await activeDomain()
            expect(domain).toBe('example.test')
            expect(calls).toBe(2) // one 429 + one success
        } finally {
            globalThis.fetch = realFetch
        }
    }, 15_000)
})

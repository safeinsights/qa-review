import { describe, expect, it } from 'vitest'
import { activeDomain, createInbox, deleteInbox, extractSignupUrl } from '@/engine/mailtm'

describe('mail.tm client (live)', () => {
    it('returns an active domain', async () => {
        const domain = await activeDomain()
        expect(domain).toMatch(/\./) // a real hostname
    }, 20_000)

    it('creates a usable inbox and deletes it', async () => {
        const domain = await activeDomain()
        const inbox = await createInbox(domain)
        expect(inbox.address).toContain(`@${domain}`)
        expect(inbox.token.length).toBeGreaterThan(10)
        expect(inbox.id).toBeTruthy()
        await deleteInbox(inbox) // must not throw
    }, 30_000)
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

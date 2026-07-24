import { describe, expect, it } from 'vitest'
import { activeDomain, createInbox, deleteInbox } from '@/engine/mailtm'

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

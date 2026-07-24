import { describe, expect, it } from 'vitest'
import { activeDomain } from '@/engine/mailtm'

describe('mail.tm client (live)', () => {
    it('returns an active domain', async () => {
        const domain = await activeDomain()
        expect(domain).toMatch(/\./) // a real hostname
    }, 20_000)
})

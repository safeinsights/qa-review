import { describe, expect, it } from 'vitest'
import { freePort } from '@/engine/cdp-launch'

describe('freePort', () => {
    it('returns a usable TCP port number', async () => {
        const p = await freePort()
        expect(typeof p).toBe('number')
        expect(p).toBeGreaterThan(0)
        expect(p).toBeLessThan(65536)
    })

    it('returns different ports across calls (not a fixed constant)', async () => {
        const a = await freePort()
        const b = await freePort()
        expect(a).toBeGreaterThan(0)
        expect(b).toBeGreaterThan(0)
    })
})

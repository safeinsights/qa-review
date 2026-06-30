import { describe, it, expect } from 'vitest'
import { listSuites, getSuite } from '@/engine/suite-registry'

describe('suite-registry', () => {
    it('lists available suites with name + description', async () => {
        const names = (await listSuites()).map((s) => s.name)
        expect(names).toContain('signin')
        expect(names).toContain('create-study')
    })

    it('returns a suite by name', async () => {
        const suite = await getSuite('signin')
        expect(suite.name).toBe('signin')
        expect(typeof suite.run).toBe('function')
    })

    it('throws a clear error for an unknown suite', async () => {
        await expect(getSuite('nope')).rejects.toThrow(/unknown suite "nope"/i)
    })
})

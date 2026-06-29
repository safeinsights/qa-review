import { describe, it, expect } from 'vitest'
import { listSuites, getSuite } from '@/engine/suite-registry'

describe('suite-registry', () => {
    it('lists available suites with name + description', () => {
        const names = listSuites().map((s) => s.name)
        expect(names).toContain('signin')
        expect(names).toContain('create-study')
    })

    it('returns a suite by name', () => {
        const suite = getSuite('signin')
        expect(suite.name).toBe('signin')
        expect(typeof suite.run).toBe('function')
    })

    it('throws a clear error for an unknown suite', () => {
        expect(() => getSuite('nope')).toThrow(/unknown suite "nope"/i)
    })
})

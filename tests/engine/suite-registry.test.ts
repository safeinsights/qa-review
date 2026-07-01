import { describe, it, expect } from 'vitest'
import { listSuites, getSuite } from '@/engine/suite-registry'

describe('suite-registry', () => {
    it('lists available suites with name + description', async () => {
        const names = (await listSuites()).map((s) => s.name)
        expect(names).toContain('signin')
        expect(names).toContain('create-study')
    })

    it('lists each suite with its static step names in order', async () => {
        const createStudy = (await listSuites()).find((s) => s.name === 'create-study')
        expect(createStudy?.steps).toEqual([
            'Open the researcher org dashboard',
            'Start a new study proposal',
            'Step 1: choose org and language',
            'Reach Step 2 and capture the study id',
            'Step 2: fill the proposal',
            'Submit the initial request',
        ])
    })

    it('returns a suite by name', async () => {
        const suite = await getSuite('signin')
        expect(suite.name).toBe('signin')
        expect(Array.isArray(suite.steps)).toBe(true)
        expect(typeof suite.steps[0].run).toBe('function')
    })

    it('throws a clear error for an unknown suite', async () => {
        await expect(getSuite('nope')).rejects.toThrow(/unknown suite "nope"/i)
    })
})

import { describe, expect, it } from 'vitest'
import { getSuite, listSuites } from '@/engine/suite-registry'

describe('suite-registry', () => {
    it('lists available suites with name + description', async () => {
        const names = (await listSuites()).map(s => s.name)
        expect(names).toContain('signin')
        expect(names).toContain('study-happy-path')
    })

    it('lists each suite with its static step names in order', async () => {
        const studyHappyPath = (await listSuites()).find(s => s.name === 'study-happy-path')
        expect(studyHappyPath?.steps.slice(0, 3)).toEqual([
            'Open the researcher org dashboard',
            'Start a new study proposal',
            'Step 1: choose org and language, then capture the study id',
        ])
        expect(studyHappyPath?.steps.at(-1)).toBe('Verify the study is deleted')
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

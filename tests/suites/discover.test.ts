import { describe, expect, it } from 'vitest'
import { discoverSuites } from '@/suites/discover'
import type { Suite } from '@/suites/types'

const fakeSuiteA: Suite = {
    name: 'a',
    description: 'A',
    roles: ['admin'],
    steps: [{ name: 's', run: async () => {} }],
}
const fakeSuiteB: Suite = {
    name: 'b',
    description: 'B',
    roles: ['admin'],
    steps: [{ name: 's', run: async () => {} }],
}

describe('discoverSuites', () => {
    it('collects exported objects that match the Suite shape', async () => {
        const files = ['a.ts', 'b.ts', 'types.ts']
        const importer = async (f: string) => {
            if (f.endsWith('a.ts')) return { fakeSuiteA }
            if (f.endsWith('b.ts')) return { fakeSuiteB }
            return { somethingElse: 42 }
        }
        const suites = await discoverSuites(files, importer)
        expect(suites.map(s => s.name).sort()).toEqual(['a', 'b'])
    })

    it('ignores modules with no Suite-shaped export', async () => {
        const suites = await discoverSuites(['x.ts'], async () => ({ notASuite: { name: 'x' } }))
        expect(suites).toEqual([])
    })

    it('skips a suite that throws on import and still loads the rest', async () => {
        const files = ['a.ts', 'broken.ts', 'b.ts']
        const importer = async (f: string) => {
            if (f.endsWith('broken.ts')) throw new Error("Cannot find package '@faker-js/faker'")
            if (f.endsWith('a.ts')) return { fakeSuiteA }
            return { fakeSuiteB }
        }
        const suites = await discoverSuites(files, importer)
        // broken.ts is dropped; a and b still load (no whole-list collapse).
        expect(suites.map(s => s.name).sort()).toEqual(['a', 'b'])
    })
})

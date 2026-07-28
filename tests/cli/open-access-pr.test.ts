import { describe, expect, it } from 'vitest'
import { openAccessPr } from '@/cli/commands/open-access-pr'

describe('openAccessPr', () => {
    it('creates a PR and returns its url', async () => {
        const calls: string[][] = []
        const result = await openAccessPr({
            branch: 'access/ada',
            name: 'Ada',
            gh: async args => {
                calls.push(args)
                return 'https://github.com/o/r/pull/42\n'
            },
        })
        expect(result).toEqual({ url: 'https://github.com/o/r/pull/42', created: true })
        expect(calls[0]).toContain('create')
    })

    // gh fails when a PR already exists. That is success, not failure — reporting it
    // as failure is what made users believe their request had not gone through.
    it('reports the existing PR when gh says one already exists', async () => {
        const result = await openAccessPr({
            branch: 'access/ada',
            name: 'Ada',
            gh: async args => {
                if (args.includes('create')) {
                    throw new Error('a pull request for branch "access/ada" already exists:#7')
                }
                return JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7' }])
            },
        })
        expect(result).toEqual({ url: 'https://github.com/o/r/pull/7', created: false })
    })

    it('propagates a genuine gh failure', async () => {
        await expect(
            openAccessPr({
                branch: 'access/ada',
                name: 'Ada',
                gh: async () => {
                    throw new Error('gh: not authenticated')
                },
            })
        ).rejects.toThrow(/not authenticated/)
    })
})

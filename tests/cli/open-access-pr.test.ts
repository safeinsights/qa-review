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

    // The fallback must not depend on gh's exact error wording: ANY `gh pr create`
    // failure falls through to the `gh pr list --head` lookup. A gh version bump
    // that rewords "already exists" would otherwise silently break this and turn
    // a healthy "PR already open" case back into a thrown failure.
    it('falls through to the PR lookup regardless of the create error wording', async () => {
        const result = await openAccessPr({
            branch: 'access/ada',
            name: 'Ada',
            gh: async args => {
                if (args.includes('create')) {
                    throw new Error('some completely different gh error message')
                }
                return JSON.stringify([{ number: 9, url: 'https://github.com/o/r/pull/9' }])
            },
        })
        expect(result).toEqual({ url: 'https://github.com/o/r/pull/9', created: false })
    })

    // A genuine failure (auth, network, ...) has no PR to find, so the list comes
    // back empty and the ORIGINAL create error must be rethrown — not a confusing
    // secondary error from the list call itself.
    it('propagates a genuine gh failure', async () => {
        await expect(
            openAccessPr({
                branch: 'access/ada',
                name: 'Ada',
                gh: async args => {
                    if (args.includes('create')) throw new Error('gh: not authenticated')
                    return '[]'
                },
            })
        ).rejects.toThrow(/not authenticated/)
    })

    // Covers the case where the fallback list call ALSO fails (e.g. same auth
    // problem) — the original create error must still win, not a parse/list error.
    it('propagates the original error when the fallback list call itself fails', async () => {
        await expect(
            openAccessPr({
                branch: 'access/ada',
                name: 'Ada',
                gh: async args => {
                    if (args.includes('create')) throw new Error('gh: not authenticated')
                    throw new Error('gh: network error')
                },
            })
        ).rejects.toThrow(/not authenticated/)
    })
})

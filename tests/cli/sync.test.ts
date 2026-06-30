import { describe, it, expect } from 'vitest'
import { syncRepo } from '@/cli/commands/sync'

// A fake git runner driven by a scripted map of "args.join(' ')" -> stdout, or a
// thrown error to simulate a non-clean / non-ff state.
function fakeGit(script: Record<string, string | Error>) {
    return async (args: string[]) => {
        const key = args.join(' ')
        const v = script[key]
        if (v instanceof Error) throw v
        if (v === undefined) return ''
        return v
    }
}

describe('sync', () => {
    it('reports synced on a clean fast-forward', async () => {
        const git = fakeGit({ 'status --porcelain': '', 'pull --ff-only': 'Updating abc..def\n' })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('synced')
    })

    it('skips when the working copy is dirty', async () => {
        const git = fakeGit({ 'status --porcelain': ' M src/foo.ts\n' })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('skipped-dirty')
    })

    it('skips when pull cannot fast-forward', async () => {
        const git = fakeGit({ 'status --porcelain': '', 'pull --ff-only': new Error('Not possible to fast-forward') })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('skipped-diverged')
    })
})

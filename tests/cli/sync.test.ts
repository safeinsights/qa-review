import { describe, expect, it } from 'vitest'
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
        const git = fakeGit({
            'status --porcelain': '',
            '-c pull.rebase=false pull --ff-only': new Error('Not possible to fast-forward'),
        })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('skipped-diverged')
    })

    // A user with `pull.rebase true` sends `git pull --ff-only` down the REBASE
    // path, where it fails on config states that are not divergence at all
    // ("Cannot rebase onto multiple branches"). Pinning pull.rebase=false per
    // invocation keeps --ff-only a genuine fast-forward regardless of user config.
    it('pins pull.rebase=false so user rebase config cannot hijack --ff-only', async () => {
        const seen: string[] = []
        const git = async (args: string[]) => {
            seen.push(args.join(' '))
            return ''
        }
        const r = await syncRepo('/repo', git)
        expect(seen).toContain('-c pull.rebase=false pull --ff-only')
        expect(r.status).toBe('synced')
    })

    // Divergence is recoverable by resetting; a broken upstream ref or unusable
    // git config is NOT, and offering "Reset to clean & sync" for it produces a
    // button that reruns the same failure and never clears its own banner.
    it.each([
        ['fatal: Cannot rebase onto multiple branches.'],
        [
            "Your configuration specifies to merge with the ref 'refs/heads/gone'\nfrom the remote, but no such ref was fetched.",
        ],
        ['There is no tracking information for the current branch.'],
    ])('reports a config failure, not divergence, for: %s', async message => {
        const git = fakeGit({
            'status --porcelain': '',
            '-c pull.rebase=false pull --ff-only': new Error(message),
        })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('failed')
        expect(r.detail).toContain(message.split('\n')[0])
    })

    it('surfaces the real git message when a pull fails', async () => {
        const git = fakeGit({
            'status --porcelain': '',
            '-c pull.rebase=false pull --ff-only': new Error('Not possible to fast-forward'),
        })
        const r = await syncRepo('/repo', git)
        expect(r.detail).toContain('Not possible to fast-forward')
    })
})

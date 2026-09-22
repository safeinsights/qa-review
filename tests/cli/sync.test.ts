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

    // Only a genuine non-fast-forward is divergence, because it is the one case a
    // reset resolves. Everything else, including a message never seen before,
    // reports as failed with git's own text, or the banner offers a Reset that
    // reruns the same failure and never clears itself.
    it.each([
        ['fatal: Cannot rebase onto multiple branches.'],
        ['fatal: Cannot fast-forward to multiple branches.'],
        [
            "Your configuration specifies to merge with the ref 'refs/heads/gone'\nfrom the remote, but no such ref was fetched.",
        ],
        ['There is no tracking information for the current branch.'],
        ['fatal: some message git has not printed before'],
    ])('reports any failure other than non-fast-forward as failed, for: %s', async message => {
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

    // The Claude sandbox denies `.claude/skills`, so a pull that must rewrite a
    // skill file aborts half-applied. That message matches no config-failure
    // pattern and no genuine non-fast-forward, so it used to be reported as
    // divergence — sending the user to push a branch with nothing to push.
    it.each([
        [
            "error: unable to unlink old '.claude/skills/qa-validate/SKILL.md': Operation not permitted",
        ],
        ['error: unable to create file .claude/hooks/pre.sh: Permission denied'],
        ["error: cannot stat '.claude/skills/qa-explore/SKILL.md': Permission denied"],
    ])('reports a blocked write as failed, not diverged: %s', async message => {
        const git = fakeGit({
            'status --porcelain': '',
            '-c pull.rebase=false pull --ff-only': new Error(message),
        })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('failed')
        expect(r.detail).toContain(message)
    })

    // git's own stderr names the file but neither the cause nor the recovery,
    // and the half-applied worktree is invisible unless the user is told to look.
    it('tells the user a blocked write may have applied partway', async () => {
        const git = fakeGit({
            'status --porcelain': '',
            '-c pull.rebase=false pull --ff-only': new Error(
                "error: unable to unlink old '.claude/skills/qa-validate/SKILL.md': Operation not permitted"
            ),
        })
        const r = await syncRepo('/repo', git)
        expect(r.detail).toContain('PARTWAY')
        expect(r.detail).toContain('git status')
    })

    // `Permission denied` alone is not enough to mean a blocked write: it also
    // ends an SSH auth failure, which is not half-applied and has a different
    // fix. Matching the write verb is what keeps the two apart.
    it('does not treat an SSH auth failure as a blocked write', async () => {
        const git = fakeGit({
            'status --porcelain': '',
            '-c pull.rebase=false pull --ff-only': new Error(
                'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'
            ),
        })
        const r = await syncRepo('/repo', git)
        expect(r.detail).not.toContain('PARTWAY')
    })
})

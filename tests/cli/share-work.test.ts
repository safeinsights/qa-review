import { describe, expect, it } from 'vitest'
import { shareBranchName, shareWork } from '@/cli/commands/share-work'

// Records every git/gh invocation so tests can assert on the ORDER of operations —
// which is the whole safety story here (branch before commit, push before PR,
// return to main only after the work is safely pushed).
function recorder(script: Record<string, string | Error> = {}) {
    const calls: string[] = []
    const run = async (args: string[]) => {
        const key = args.join(' ')
        calls.push(key)
        const v = script[key]
        if (v instanceof Error) throw v
        return v ?? ''
    }
    return { calls, run }
}

const DIRTY = ' M src/suites/signin.ts\n?? src/suites/new.ts\n'

describe('shareWork', () => {
    it('branches, commits everything, pushes, and opens a PR', async () => {
        const git = recorder({ 'status --porcelain': DIRTY })
        const gh = recorder({
            'pr create --base main --title t --body b --head qa/work-1 --json url':
                '{"url":"https://gh/pr/7"}',
        })
        const r = await shareWork({
            branch: 'qa/work-1',
            title: 't',
            body: 'b',
            git: git.run,
            gh: gh.run,
        })

        expect(r.url).toBe('https://gh/pr/7')
        expect(git.calls).toContain('checkout -b qa/work-1')
        expect(git.calls).toContain('add -A')
        expect(git.calls.some(c => c.startsWith('commit'))).toBe(true)
        expect(git.calls).toContain('push -u origin qa/work-1')
    })

    it('creates the branch BEFORE committing, so work never lands on main', async () => {
        const git = recorder({ 'status --porcelain': DIRTY })
        const gh = recorder({})
        await shareWork({ branch: 'qa/work-1', title: 't', body: 'b', git: git.run, gh: gh.run })

        const branched = git.calls.indexOf('checkout -b qa/work-1')
        const staged = git.calls.indexOf('add -A')
        expect(branched).toBeGreaterThanOrEqual(0)
        expect(branched).toBeLessThan(staged)
    })

    // `git add -A` respects .gitignore, so the age identity and settings.local.json
    // are never staged. Asserting it here pins the guarantee against someone
    // "fixing" this to add -f later, which would publish a user's private key.
    it('never force-adds, so gitignored secrets cannot be committed', async () => {
        const git = recorder({ 'status --porcelain': DIRTY })
        const gh = recorder({})
        await shareWork({ branch: 'qa/work-1', title: 't', body: 'b', git: git.run, gh: gh.run })

        expect(git.calls.some(c => /add .*(-f|--force)/.test(c))).toBe(false)
    })

    it('returns to main and fast-forwards once the work is pushed', async () => {
        const git = recorder({ 'status --porcelain': DIRTY })
        const gh = recorder({})
        await shareWork({ branch: 'qa/work-1', title: 't', body: 'b', git: git.run, gh: gh.run })

        const pushed = git.calls.indexOf('push -u origin qa/work-1')
        const backToMain = git.calls.indexOf('checkout main')
        expect(backToMain).toBeGreaterThan(pushed)
        expect(git.calls).toContain('-c pull.rebase=false pull --ff-only')
    })

    // If the push fails the commits exist ONLY locally. Switching back to main
    // there would strand them on an unpushed branch the user can't see from the
    // app — so the failure must stop before the checkout.
    it('stays on the branch when the push fails, so no work is stranded', async () => {
        const git = recorder({
            'status --porcelain': DIRTY,
            'push -u origin qa/work-1': new Error('network unreachable'),
        })
        const gh = recorder({})
        await expect(
            shareWork({ branch: 'qa/work-1', title: 't', body: 'b', git: git.run, gh: gh.run })
        ).rejects.toThrow(/network unreachable/)
        expect(git.calls).not.toContain('checkout main')
    })

    // Sharing is repeatable, so a fixed branch name would make the SECOND share
    // fail on `checkout -b` against a branch the user already has.
    it('gives repeat shares distinct branch names', () => {
        const a = shareBranchName('suite edits', new Date('2026-08-13T14:00:00Z'))
        const b = shareBranchName('suite edits', new Date('2026-08-13T15:30:00Z'))
        expect(a).not.toBe(b)
        expect(a).toMatch(/^qa\/suite-edits-\d{8}-\d{4}$/)
    })

    // The description is whatever the user typed into a prompt — usually a
    // sentence — so an unbounded slug produces an unwieldy ref.
    it('caps the branch name when the description is a long sentence', () => {
        const b = shareBranchName(
            'Fixed the sync button so it offers a PR instead of only discarding local edits',
            new Date('2026-08-13T14:00:00Z')
        )
        expect(b.length).toBeLessThanOrEqual(60)
        expect(b).not.toMatch(/--/)
        expect(b).toMatch(/-\d{8}-\d{4}$/)
    })

    it('falls back to a usable branch name when the description has no usable chars', () => {
        expect(shareBranchName('!!!', new Date('2026-08-13T14:00:00Z'))).toMatch(
            /^qa\/suite-edits-/
        )
    })

    it('refuses to run when there is nothing to share', async () => {
        const git = recorder({ 'status --porcelain': '' })
        const gh = recorder({})
        await expect(
            shareWork({ branch: 'qa/work-1', title: 't', body: 'b', git: git.run, gh: gh.run })
        ).rejects.toThrow(/nothing to share/i)
        expect(git.calls.some(c => c.startsWith('checkout -b'))).toBe(false)
    })
})

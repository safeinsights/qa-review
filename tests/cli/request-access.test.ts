import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    gitIdentityProblem,
    requestAccess,
    resolveRequestAccessName,
} from '@/cli/commands/request-access'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'reqaccess-'))
}

describe('request-access', () => {
    it('creates an identity and adds the member to the keyring', async () => {
        const dir = tmpDir()
        const calls: string[][] = []
        const result = await requestAccess({
            dir,
            name: 'Jane Smith',
            email: 'jane@x.com',
            date: '2026-06-30',
            git: async args => {
                calls.push(args)
                return ''
            },
        })
        const keyring = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        expect(keyring).toHaveLength(1)
        expect(keyring[0]).toMatchObject({
            name: 'Jane Smith',
            email: 'jane@x.com',
            addedDate: '2026-06-30',
        })
        expect(keyring[0].publicKey).toMatch(/^age1/)
        expect(result.created).toBe(true)
        expect(calls.some(c => c[0] === 'checkout')).toBe(true)
    })

    // The bug that produced a pushed-but-empty access branch: `git commit` was wrapped
    // in a catch that assumed every failure meant "already committed". An unset
    // user.email fails the SAME way, so the branch got pushed with no commit on it and
    // `gh pr create` died with "No commits between main and access/<name>" — a state
    // `open-access-pr` could not repair, because it only retries the create.
    it('throws when the commit fails and there were staged changes', async () => {
        const dir = tmpDir()
        await expect(
            requestAccess({
                dir,
                name: 'Jane',
                email: 'a@x.com',
                date: '2026-06-30',
                git: async args => {
                    // Staged changes present: `diff --cached --quiet` exits non-zero.
                    if (args[0] === 'diff') throw new Error('has staged changes')
                    if (args[0] === 'commit') {
                        const e = new Error('Command failed: git commit')
                        ;(e as { stderr?: string }).stderr =
                            '*** Please tell me who you are.\nfatal: unable to auto-detect email address'
                        throw e
                    }
                    return ''
                },
            })
        ).rejects.toThrow(/Please tell me who you are/)
    })

    // A commit failure must abort BEFORE the push, or the empty branch still reaches
    // the remote and the user is back in the unrecoverable state.
    it('does not push when the commit fails', async () => {
        const dir = tmpDir()
        const calls: string[][] = []
        await expect(
            requestAccess({
                dir,
                name: 'Jane',
                email: 'a@x.com',
                date: '2026-06-30',
                git: async args => {
                    calls.push(args)
                    if (args[0] === 'diff') throw new Error('has staged changes')
                    if (args[0] === 'commit') throw new Error('nope')
                    return ''
                },
            })
        ).rejects.toThrow()
        expect(calls.some(c => c[0] === 'push')).toBe(false)
    })

    // The legitimate re-run: the entry was committed on a previous attempt, so nothing
    // is staged and skipping the commit is correct. This must NOT throw.
    it('skips the commit and still pushes when nothing is staged', async () => {
        const dir = tmpDir()
        const calls: string[][] = []
        await requestAccess({
            dir,
            name: 'Jane',
            email: 'a@x.com',
            date: '2026-06-30',
            git: async args => {
                calls.push(args)
                // `diff --cached --quiet` exits 0 => nothing staged.
                if (args[0] === 'commit') throw new Error('nothing to commit')
                return ''
            },
        })
        expect(calls.some(c => c[0] === 'commit')).toBe(false)
        expect(calls.some(c => c[0] === 'push')).toBe(true)
    })

    it('is idempotent for the same person', async () => {
        const dir = tmpDir()
        const git = async () => ''
        await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        const keyring = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        expect(keyring).toHaveLength(1)
    })

    it('reuses an existing identity instead of generating a new one', async () => {
        const dir = tmpDir()
        const git = async () => ''
        const first = await requestAccess({
            dir,
            name: 'Jane',
            email: 'a@x.com',
            date: '2026-06-30',
            git,
        })
        // Wipe the keyring but keep the identity file, then re-request under a new name.
        fs.rmSync(path.join(dir, 'keyring.json'))
        const second = await requestAccess({
            dir,
            name: 'Jane2',
            email: 'a@x.com',
            date: '2026-06-30',
            git,
        })
        expect(second.publicKey).toBe(first.publicKey)
        expect(second.created).toBe(false)
    })

    // The core bug this branch exists to kill: same key, two different names
    // (e.g. git user.name was edited, or the first request used an explicit
    // --name). Before the fix, the branch was derived fresh from opts.name every
    // time, so the second call computed a DIFFERENT slug and pushed a second
    // branch — and the keyring ended up with two entries sharing one public key.
    // The stored identity metadata must win: same key -> same branch, always.
    it('reuses the first branch when a later request uses a different name for the same key', async () => {
        const dir = tmpDir()
        const git = async () => ''
        const first = await requestAccess({
            dir,
            name: 'Ada Lovelace',
            email: 'a@x.com',
            date: '2026-06-30',
            git,
        })
        const second = await requestAccess({
            dir,
            name: 'Ada L',
            email: 'a@x.com',
            date: '2026-07-01',
            git,
        })
        expect(second.publicKey).toBe(first.publicKey)
        expect(second.branch).toBe(first.branch)
        expect(second.branch).toBe('access/ada-lovelace')

        const keyring = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        expect(keyring).toHaveLength(1)
        expect(keyring[0].publicKey).toBe(first.publicKey)
    })
})

// Checked up front so the user is told what to set BEFORE a branch is pushed —
// after the push, the failure mode is an empty branch that only `request-access`
// (not the "Open pull request" button the GUI offers) can repair.
describe('gitIdentityProblem', () => {
    it('is silent when both are set', () => {
        expect(gitIdentityProblem({ name: 'Ada', email: 'ada@x.com' })).toBe('')
    })

    it('names both when neither is set, and shows the commands', () => {
        const problem = gitIdentityProblem({ name: '', email: '' })
        expect(problem).toMatch(/user\.name or user\.email/)
        expect(problem).toMatch(/git config --global user\.name/)
        expect(problem).toMatch(/git config --global user\.email/)
    })

    it('names only the missing one', () => {
        const problem = gitIdentityProblem({ name: 'Ada', email: '' })
        expect(problem).toMatch(/user\.email/)
        expect(problem).not.toMatch(/user\.name or/)
    })

    // Whitespace-only is what `git config user.name` yields for a key set to "" —
    // treating it as present would put the user right back in the failing commit.
    it('treats whitespace-only values as missing', () => {
        expect(gitIdentityProblem({ name: '   ', email: '\t' })).toMatch(
            /user\.name or user\.email/
        )
    })
})

// Regression coverage for a bug where the GUI passes `--name ''` (meaning "derive
// it") through Go's `RequestAccess`, which always sends the flag literally even
// when empty. `??` doesn't fall through on '' (only null/undefined), so an empty
// string used to be treated as an explicit name and reach the engine unresolved,
// erroring instead of resubmitting. Pinning both branches of the fallback here so
// a future "simplification" back to `??` is caught immediately.
describe('resolveRequestAccessName', () => {
    it('falls back to the resolver when --name is an empty string', async () => {
        const name = await resolveRequestAccessName({ name: '' }, async () => 'Ada Lovelace')
        expect(name).toBe('Ada Lovelace')
    })

    it('throws the "required" error when --name is empty and the resolver also yields nothing', async () => {
        await expect(resolveRequestAccessName({ name: '' }, async () => '')).rejects.toThrow(
            'request-access: --name "Your Name" is required (git user.name is unset)'
        )
    })

    it('uses the explicit --name and never calls the resolver', async () => {
        let resolverCalled = false
        const name = await resolveRequestAccessName({ name: 'Explicit Name' }, async () => {
            resolverCalled = true
            return 'Should Not Be Used'
        })
        expect(name).toBe('Explicit Name')
        expect(resolverCalled).toBe(false)
    })
})

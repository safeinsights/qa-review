import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAccessStatus } from '@/cli/commands/access-status'
import { readIdentityMeta } from '@/engine/access-request'
import { createIdentity } from '@/engine/identity'
import { writeKeyring } from '@/engine/keyring'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'access-status-'))
}

const noGit = async () => ''
const noGh = async () => '[]'

async function seedIdentity(dir: string) {
    await createIdentity(dir, { name: 'Ada Lovelace', branch: 'access/ada-lovelace' })
    return readIdentityMeta(dir)!.publicKey
}

describe('resolveAccessStatus', () => {
    it('reports no-identity when there is no key', async () => {
        const status = await resolveAccessStatus({ dir: tmpDir(), git: noGit, gh: noGh })
        expect(status.state).toBe('no-identity')
    })

    it('reports no-branch when the branch is not on the remote', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({ dir, git: async () => '', gh: noGh })
        expect(status.state).toBe('no-branch')
        expect(status.branch).toBe('access/ada-lovelace')
    })

    it('reports branch-no-pr when the branch exists but gh finds no PR', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: noGh,
        })
        expect(status.state).toBe('branch-no-pr')
    })

    it('reports pr-open with the PR details', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: async () =>
                JSON.stringify([{ number: 21, state: 'OPEN', url: 'https://x/pull/21' }]),
        })
        expect(status.state).toBe('pr-open')
        expect(status.pr).toMatchObject({ number: 21, url: 'https://x/pull/21' })
    })

    it('reports pr-closed for a PR closed without merging', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: async () =>
                JSON.stringify([{ number: 21, state: 'CLOSED', url: 'https://x/pull/21' }]),
        })
        expect(status.state).toBe('pr-closed')
    })

    it('reports merged-awaiting-rekey when the key is in the keyring but secrets do not decrypt', async () => {
        const dir = tmpDir()
        const publicKey = await seedIdentity(dir)
        writeKeyring(dir, [
            { name: 'Ada Lovelace', publicKey, email: 'a@x.com', addedDate: '2026-07-28' },
        ])
        // An armored blob encrypted to somebody else's key.
        fs.writeFileSync(
            path.join(dir, 'settings.secrets.json'),
            JSON.stringify({
                QA_PASSWORD:
                    '-----BEGIN AGE ENCRYPTED FILE-----\nnot-decryptable\n-----END AGE ENCRYPTED FILE-----',
            })
        )
        const status = await resolveAccessStatus({ dir, git: noGit, gh: noGh })
        expect(status.state).toBe('merged-awaiting-rekey')
    })

    it('reports ready when the key is in the keyring and every secret decrypts', async () => {
        const dir = tmpDir()
        const publicKey = await seedIdentity(dir)
        writeKeyring(dir, [
            { name: 'Ada Lovelace', publicKey, email: 'a@x.com', addedDate: '2026-07-28' },
        ])
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'), JSON.stringify({}))
        const status = await resolveAccessStatus({ dir, git: noGit, gh: noGh })
        expect(status.state).toBe('ready')
    })

    // The whole point of the feature: an unreachable GitHub must never look like
    // "you never requested access", which is what restarts the duplicate-PR loop.
    it('degrades to a local state when gh fails, never to no-identity', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: async () => {
                throw new Error('gh: not authenticated')
            },
        })
        expect(status.state).not.toBe('no-identity')
        expect(status.githubReachable).toBe(false)
        expect(status.note).toMatch(/GitHub/i)
    })
})

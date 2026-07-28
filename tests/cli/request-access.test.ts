import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requestAccess, resolveRequestAccessName } from '@/cli/commands/request-access'

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

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { requestAccess } from '@/cli/commands/request-access'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'reqaccess-'))
}

describe('request-access', () => {
    it('creates an identity and adds the member to the keyring', async () => {
        const dir = tmpDir()
        const calls: string[][] = []
        const result = await requestAccess({
            dir, name: 'Jane Smith', email: 'jane@x.com', date: '2026-06-30',
            git: async (args) => { calls.push(args); return '' },
        })
        const keyring = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        expect(keyring).toHaveLength(1)
        expect(keyring[0]).toMatchObject({ name: 'Jane Smith', email: 'jane@x.com', addedDate: '2026-06-30' })
        expect(keyring[0].publicKey).toMatch(/^age1/)
        expect(result.created).toBe(true)
        expect(calls.some((c) => c[0] === 'checkout')).toBe(true)
    })

    it('rejects a duplicate name', async () => {
        const dir = tmpDir()
        const git = async () => ''
        await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        await expect(requestAccess({ dir, name: 'Jane', email: 'b@x.com', date: '2026-06-30', git }))
            .rejects.toThrow(/already in the keyring/)
    })

    it('reuses an existing identity instead of generating a new one', async () => {
        const dir = tmpDir()
        const git = async () => ''
        const first = await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        // Wipe the keyring but keep the identity file, then re-request under a new name.
        fs.rmSync(path.join(dir, 'keyring.json'))
        const second = await requestAccess({ dir, name: 'Jane2', email: 'a@x.com', date: '2026-06-30', git })
        expect(second.publicKey).toBe(first.publicKey)
        expect(second.created).toBe(false)
    })
})

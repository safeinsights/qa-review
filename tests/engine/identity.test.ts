import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { identityPath, readIdentity, hasIdentity, createIdentity } from '@/engine/identity'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'))
}

describe('identity file', () => {
    it('reports no identity in an empty dir', () => {
        const dir = tmpDir()
        expect(hasIdentity(dir)).toBe(false)
        expect(readIdentity(dir)).toBeNull()
    })

    it('creates an identity file and reads it back', async () => {
        const dir = tmpDir()
        const { publicKey } = await createIdentity(dir)
        expect(publicKey).toMatch(/^age1/)
        expect(hasIdentity(dir)).toBe(true)
        const id = readIdentity(dir)
        expect(id).toMatch(/^AGE-SECRET-KEY-1/)
        expect(fs.existsSync(identityPath(dir))).toBe(true)
    })

    it('does not overwrite an existing identity', async () => {
        const dir = tmpDir()
        const first = await createIdentity(dir)
        const second = await createIdentity(dir)
        expect(second.publicKey).toBe(first.publicKey)
        expect(second.created).toBe(false)
    })
})

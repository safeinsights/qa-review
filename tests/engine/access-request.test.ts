import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    branchForName,
    readIdentityMeta,
    slugForName,
    writeIdentityMeta,
} from '@/engine/access-request'
import { createIdentity, identityPath } from '@/engine/identity'
import { generateIdentity, publicKeyFromIdentity } from '@/engine/settings'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'access-meta-'))
}

describe('slugForName', () => {
    it('lowercases and hyphenates', () => {
        expect(slugForName('Greg Fitch')).toBe('greg-fitch')
        expect(branchForName('Greg Fitch')).toBe('access/greg-fitch')
    })

    it('strips punctuation and collapses separators', () => {
        expect(slugForName('Nathan Stitt (dev)')).toBe('nathan-stitt-dev')
    })
})

describe('identity metadata', () => {
    it('round-trips name and branch through the comment header', async () => {
        const dir = tmpDir()
        const { publicKey } = await createIdentity(dir, {
            name: 'Greg Fitch',
            branch: 'access/greg-fitch',
        })
        const meta = readIdentityMeta(dir)
        expect(meta).toMatchObject({
            publicKey,
            name: 'Greg Fitch',
            branch: 'access/greg-fitch',
        })
    })

    it('returns null when there is no identity file', () => {
        expect(readIdentityMeta(tmpDir())).toBeNull()
    })

    it('reads a legacy identity file that has no name/branch comments', async () => {
        const dir = tmpDir()
        const { publicKey } = await createIdentity(dir)
        const meta = readIdentityMeta(dir)
        expect(meta?.publicKey).toBe(publicKey)
        expect(meta?.name).toBeUndefined()
        expect(meta?.branch).toBeUndefined()
    })

    it('adds metadata to an existing identity without changing the secret key', async () => {
        const dir = tmpDir()
        await createIdentity(dir)
        const before = fs
            .readFileSync(path.join(dir, 'age-identity.txt'), 'utf8')
            .split('\n')
            .find(l => l.startsWith('AGE-SECRET-KEY-'))
        await writeIdentityMeta(dir, { name: 'Ada Lovelace', branch: 'access/ada-lovelace' })
        const after = fs
            .readFileSync(path.join(dir, 'age-identity.txt'), 'utf8')
            .split('\n')
            .find(l => l.startsWith('AGE-SECRET-KEY-'))
        expect(after).toBe(before)
        expect(readIdentityMeta(dir)?.name).toBe('Ada Lovelace')
    })

    // readIdentityMeta returns null when the `# public key:` header line is
    // missing (hand-created file, restored from backup, bare secret line). Before
    // the fix, writeIdentityMeta fell back to `existing?.publicKey ?? ''` in that
    // case and wrote a BLANK header line, permanently corrupting the file even
    // though the secret still decrypts fine. The public key must be derived from
    // the secret itself, not read back from a header that may not exist.
    it('derives the public key from the secret when the identity file has no header at all', async () => {
        const dir = tmpDir()
        const secret = await generateIdentity()
        const expectedPublicKey = await publicKeyFromIdentity(secret)
        fs.mkdirSync(dir, { recursive: true })
        // Bare secret line, no comment header — simulates a hand-created/restored file.
        fs.writeFileSync(identityPath(dir), `${secret}\n`, { mode: 0o600 })
        expect(readIdentityMeta(dir)).toBeNull()

        await writeIdentityMeta(dir, { name: 'Restored User', branch: 'access/restored-user' })

        const meta = readIdentityMeta(dir)
        expect(meta?.publicKey).toBe(expectedPublicKey)
        expect(meta?.name).toBe('Restored User')
        expect(meta?.branch).toBe('access/restored-user')
        const rewritten = fs
            .readFileSync(identityPath(dir), 'utf8')
            .split('\n')
            .find(l => l.startsWith('AGE-SECRET-KEY-'))
        expect(rewritten).toBe(secret)
        expect(fs.statSync(identityPath(dir)).mode & 0o777).toBe(0o600)
    })
})

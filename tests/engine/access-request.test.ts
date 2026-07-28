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
import { createIdentity } from '@/engine/identity'

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
        writeIdentityMeta(dir, { name: 'Ada Lovelace', branch: 'access/ada-lovelace' })
        const after = fs
            .readFileSync(path.join(dir, 'age-identity.txt'), 'utf8')
            .split('\n')
            .find(l => l.startsWith('AGE-SECRET-KEY-'))
        expect(after).toBe(before)
        expect(readIdentityMeta(dir)?.name).toBe('Ada Lovelace')
    })
})

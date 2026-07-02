import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    addMember,
    fingerprint,
    isInDrift,
    readKeyring,
    readLock,
    recipients,
    writeKeyring,
    writeLock,
} from '@/engine/keyring'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-'))
}

describe('keyring', () => {
    it('reads an empty keyring from a missing file', () => {
        expect(readKeyring(tmpDir())).toEqual([])
    })

    it('adds a member and lists recipients', () => {
        const dir = tmpDir()
        const next = addMember(readKeyring(dir), {
            name: 'Jane',
            publicKey: 'age1jane',
            email: 'jane@x.com',
            addedDate: '2026-06-30',
        })
        writeKeyring(dir, next)
        expect(recipients(readKeyring(dir))).toEqual(['age1jane'])
    })

    it('rejects a duplicate name', () => {
        const k = addMember([], {
            name: 'Jane',
            publicKey: 'age1a',
            email: 'a',
            addedDate: '2026-06-30',
        })
        expect(() =>
            addMember(k, { name: 'Jane', publicKey: 'age1b', email: 'b', addedDate: '2026-06-30' })
        ).toThrow(/already in the keyring/)
    })

    it('fingerprint is order-independent and changes with membership', () => {
        const f1 = fingerprint(['age1a', 'age1b'])
        const f2 = fingerprint(['age1b', 'age1a'])
        const f3 = fingerprint(['age1a'])
        expect(f1).toBe(f2)
        expect(f1).not.toBe(f3)
    })

    it('drift is true until the lock matches the keyring', () => {
        const dir = tmpDir()
        writeKeyring(
            dir,
            addMember([], { name: 'Jane', publicKey: 'age1a', email: 'a', addedDate: '2026-06-30' })
        )
        expect(isInDrift(dir)).toBe(true)
        writeLock(dir, fingerprint(recipients(readKeyring(dir))))
        expect(readLock(dir)).toBe(fingerprint(['age1a']))
        expect(isInDrift(dir)).toBe(false)
    })
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { rekeyAll } from '@/cli/commands/rekey'
import { setSecret } from '@/cli/commands/set-secret'
import { createIdentity, readIdentity } from '@/engine/identity'
import { addMember, fingerprint, readLock, writeKeyring } from '@/engine/keyring'
import {
    decryptWithIdentity,
    encryptToRecipients,
    generateIdentity,
    publicKeyFromIdentity,
} from '@/engine/settings'

describe('rekey', () => {
    it('re-encrypts a secret so a newly-added recipient can read it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-'))
        const alice = await createIdentity(dir) // alice's identity is the local one
        const aliceId = readIdentity(dir)!
        writeKeyring(
            dir,
            addMember([], {
                name: 'Alice',
                publicKey: alice.publicKey,
                email: 'a',
                addedDate: '2026-06-30',
            })
        )
        // Encrypt a secret to Alice only.
        fs.writeFileSync(
            path.join(dir, 'settings.secrets.json'),
            JSON.stringify({ ADMIN_PASSWORD: await encryptToRecipients('pw', [alice.publicKey]) })
        )

        // Bob joins the keyring.
        const bobId = await generateIdentity()
        const bobPub = await publicKeyFromIdentity(bobId)
        const k = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        k.push({ name: 'Bob', publicKey: bobPub, email: 'b', addedDate: '2026-06-30' })
        fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify(k))

        await rekeyAll(dir, aliceId)

        const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'settings.secrets.json'), 'utf8'))
        expect(await decryptWithIdentity(secrets.ADMIN_PASSWORD, bobId)).toBe('pw')
        expect(readLock(dir)).toBe(fingerprint([alice.publicKey, bobPub]))
    })

    it('set-secret encrypts one value to all recipients and updates the lock', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setsec-'))
        const a = await generateIdentity()
        const aPub = await publicKeyFromIdentity(a)
        writeKeyring(
            dir,
            addMember([], { name: 'A', publicKey: aPub, email: 'a', addedDate: '2026-06-30' })
        )
        await setSecret(dir, 'RESEARCHER_PASSWORD', 'hunter2')
        const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'settings.secrets.json'), 'utf8'))
        expect(await decryptWithIdentity(secrets.RESEARCHER_PASSWORD, a)).toBe('hunter2')
        expect(readLock(dir)).toBe(fingerprint([aPub]))
    })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Encrypter, armor } from 'age-encryption'
import {
    loadSettings,
    isEncryptedValue,
    isSecretVar,
    secretVarNames,
    PROJECT_FILE,
    SECRETS_FILE,
    LOCAL_FILE,
    generateIdentity,
    publicKeyFromIdentity,
    encryptToRecipients,
    decryptWithIdentity,
} from '@/engine/settings'

const PASS = 'correct-horse-battery-staple'
const PASSPHRASE_VAR = 'AGE_PASSPHRASE'

// Local helper: produce a passphrase-encrypted armored blob to seed the
// loadSettings passphrase-path fixtures (the public passphrase encrypt was
// removed in favor of X25519; Task 4 rewrites these tests).
async function encryptWithPassphrase(plain: string, passphrase: string): Promise<string> {
    const e = new Encrypter()
    e.setPassphrase(passphrase)
    return armor.encode(await e.encrypt(plain))
}

let dir: string

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-settings-'))
})
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

function write(file: string, obj: Record<string, string>) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 2))
}

describe('X25519 crypto primitives', () => {
    it('round-trips a value encrypted to one recipient', async () => {
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        const armored = await encryptToRecipients('hello', [pub])
        expect(armored).toContain('-----BEGIN AGE ENCRYPTED FILE-----')
        expect(await decryptWithIdentity(armored, id)).toBe('hello')
    })

    it('round-trips when encrypted to multiple recipients', async () => {
        const a = await generateIdentity()
        const b = await generateIdentity()
        const armored = await encryptToRecipients('multi', [
            await publicKeyFromIdentity(a),
            await publicKeyFromIdentity(b),
        ])
        expect(await decryptWithIdentity(armored, a)).toBe('multi')
        expect(await decryptWithIdentity(armored, b)).toBe('multi')
    })

    it('a non-recipient identity cannot decrypt', async () => {
        const owner = await generateIdentity()
        const stranger = await generateIdentity()
        const armored = await encryptToRecipients('secret', [await publicKeyFromIdentity(owner)])
        await expect(decryptWithIdentity(armored, stranger)).rejects.toThrow()
    })
})

describe('secret classification', () => {
    it('treats passwords + per-account MFA as secret, emails + URLs as not', () => {
        expect(isSecretVar('ADMIN_PASSWORD')).toBe(true)
        expect(isSecretVar('ADMIN_MFA_CODE')).toBe(true)
        expect(isSecretVar('ADMIN_EMAIL')).toBe(false)
        expect(isSecretVar('QA_BASE_URL')).toBe(false)
        expect(secretVarNames()).toContain('REVIEWER_PASSWORD')
        expect(secretVarNames()).toContain('REVIEWER_MFA_CODE')
    })
})

describe('loadSettings layering', () => {
    it('merges project then local (local wins)', async () => {
        write(PROJECT_FILE, { QA_BASE_URL: 'https://project.example', ADMIN_EMAIL: 'p@example' })
        write(LOCAL_FILE, { ADMIN_EMAIL: 'local@example' })
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.QA_BASE_URL).toBe('https://project.example')
        expect(vars.ADMIN_EMAIL).toBe('local@example')
    })

    it('lets a real env var override every file tier', async () => {
        write(PROJECT_FILE, { QA_BASE_URL: 'https://project.example' })
        write(LOCAL_FILE, { QA_BASE_URL: 'https://local.example' })
        const vars = await loadSettings({ dir, env: { QA_BASE_URL: 'https://env.example' } })
        expect(vars.QA_BASE_URL).toBe('https://env.example')
    })

    it('ignores an empty-string env var (treats as unset)', async () => {
        write(LOCAL_FILE, { QA_BASE_URL: 'https://local.example' })
        const vars = await loadSettings({ dir, env: { QA_BASE_URL: '' } })
        expect(vars.QA_BASE_URL).toBe('https://local.example')
    })

    it('tolerates missing files', async () => {
        const vars = await loadSettings({ dir, env: {} })
        expect(vars).toEqual({})
    })

    it('decrypts committed secret values with the passphrase', async () => {
        write(PROJECT_FILE, { QA_BASE_URL: 'https://project.example' })
        write(SECRETS_FILE, {
            ADMIN_PASSWORD: await encryptWithPassphrase('pw-admin', PASS),
            ADMIN_MFA_CODE: await encryptWithPassphrase('424242', PASS),
        })
        const vars = await loadSettings({ dir, env: { [PASSPHRASE_VAR]: PASS } })
        expect(vars.ADMIN_PASSWORD).toBe('pw-admin')
        expect(vars.ADMIN_MFA_CODE).toBe('424242')
    })

    it('throws a clear error when an encrypted secret needs a passphrase that is absent', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: await encryptWithPassphrase('pw-admin', PASS) })
        await expect(loadSettings({ dir, env: {} })).rejects.toThrow(/AGE_PASSPHRASE/)
    })

    it('throws a clear error when the passphrase is wrong', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: await encryptWithPassphrase('pw-admin', PASS) })
        await expect(loadSettings({ dir, env: { [PASSPHRASE_VAR]: 'nope' } })).rejects.toThrow(/Cannot decrypt ADMIN_PASSWORD/)
    })

    it('passes through a plaintext value left in the secrets file (not yet encrypted)', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: 'plain-draft' })
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_PASSWORD).toBe('plain-draft')
    })

    it('lets a local override beat a decrypted committed secret', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: await encryptWithPassphrase('shared', PASS) })
        write(LOCAL_FILE, { ADMIN_PASSWORD: 'my-own' })
        const vars = await loadSettings({ dir, env: { [PASSPHRASE_VAR]: PASS } })
        expect(vars.ADMIN_PASSWORD).toBe('my-own')
    })
})

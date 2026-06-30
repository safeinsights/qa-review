import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    loadSettings,
    encryptValue,
    decryptValue,
    isEncryptedValue,
    isSecretVar,
    secretVarNames,
    PROJECT_FILE,
    SECRETS_FILE,
    LOCAL_FILE,
    PASSPHRASE_VAR,
} from '@/engine/settings'

const PASS = 'correct-horse-battery-staple'

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

describe('encrypt/decrypt round-trip', () => {
    it('encrypts to an armored age blob and decrypts back', async () => {
        const armored = await encryptValue('s3cret', PASS)
        expect(isEncryptedValue(armored)).toBe(true)
        expect(armored).toContain('BEGIN AGE ENCRYPTED FILE')
        expect(await decryptValue(armored, PASS)).toBe('s3cret')
    })

    it('fails to decrypt with the wrong passphrase', async () => {
        const armored = await encryptValue('s3cret', PASS)
        await expect(decryptValue(armored, 'wrong')).rejects.toThrow()
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
            ADMIN_PASSWORD: await encryptValue('pw-admin', PASS),
            ADMIN_MFA_CODE: await encryptValue('424242', PASS),
        })
        const vars = await loadSettings({ dir, env: { [PASSPHRASE_VAR]: PASS } })
        expect(vars.ADMIN_PASSWORD).toBe('pw-admin')
        expect(vars.ADMIN_MFA_CODE).toBe('424242')
    })

    it('throws a clear error when an encrypted secret needs a passphrase that is absent', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: await encryptValue('pw-admin', PASS) })
        await expect(loadSettings({ dir, env: {} })).rejects.toThrow(/AGE_PASSPHRASE/)
    })

    it('throws a clear error when the passphrase is wrong', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: await encryptValue('pw-admin', PASS) })
        await expect(loadSettings({ dir, env: { [PASSPHRASE_VAR]: 'nope' } })).rejects.toThrow(/Cannot decrypt ADMIN_PASSWORD/)
    })

    it('passes through a plaintext value left in the secrets file (not yet encrypted)', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: 'plain-draft' })
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_PASSWORD).toBe('plain-draft')
    })

    it('lets a local override beat a decrypted committed secret', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: await encryptValue('shared', PASS) })
        write(LOCAL_FILE, { ADMIN_PASSWORD: 'my-own' })
        const vars = await loadSettings({ dir, env: { [PASSPHRASE_VAR]: PASS } })
        expect(vars.ADMIN_PASSWORD).toBe('my-own')
    })
})

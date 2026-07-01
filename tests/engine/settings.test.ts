import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    loadSettings,
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

let dir: string

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-settings-'))
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

    it('treats each account per-env results private key as a secret', () => {
        expect(isSecretVar('REVIEWER_RESULTS_PRIVATE_KEY_QA')).toBe(true)
        expect(isSecretVar('REVIEWER_RESULTS_PRIVATE_KEY_STAGING')).toBe(true)
        expect(isSecretVar('ADMIN_RESULTS_PRIVATE_KEY_QA')).toBe(true)
        expect(secretVarNames()).toContain('REVIEWER_RESULTS_PRIVATE_KEY_QA')
        expect(secretVarNames()).toContain('RESEARCHER_RESULTS_PRIVATE_KEY_STAGING')
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

    it('passes through a plaintext value left in the secrets file (not yet encrypted)', async () => {
        write(SECRETS_FILE, { ADMIN_PASSWORD: 'plain-draft' })
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_PASSWORD).toBe('plain-draft')
    })
})

describe('loadSettings with identities', () => {
    function settingsDir(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'))
    }

    it('decrypts secrets with the identity file in the dir', async () => {
        const dir = settingsDir()
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        fs.writeFileSync(path.join(dir, 'age-identity.txt'), `${id}\n`)
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'),
            JSON.stringify({ ADMIN_PASSWORD: await encryptToRecipients('pw', [pub]) }))
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_PASSWORD).toBe('pw')
    })

    it('skips encrypted secrets (no throw) when no identity is present', async () => {
        const dir = settingsDir()
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'),
            JSON.stringify({ ADMIN_PASSWORD: await encryptToRecipients('pw', [pub]) }))
        // No identity file written. process.env override supplies the value instead.
        const vars = await loadSettings({ dir, env: { ADMIN_PASSWORD: 'from-env' } })
        expect(vars.ADMIN_PASSWORD).toBe('from-env')
    })

    it('passes plaintext secrets through unchanged', async () => {
        const dir = settingsDir()
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'), JSON.stringify({ ADMIN_EMAIL: 'a@x.com' }))
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_EMAIL).toBe('a@x.com')
    })

    it('lets a local override beat a decrypted committed secret', async () => {
        const dir = settingsDir()
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        fs.writeFileSync(path.join(dir, 'age-identity.txt'), `${id}\n`)
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'),
            JSON.stringify({ ADMIN_PASSWORD: await encryptToRecipients('committed', [pub]) }))
        fs.writeFileSync(path.join(dir, 'settings.local.json'),
            JSON.stringify({ ADMIN_PASSWORD: 'local-wins' }))
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_PASSWORD).toBe('local-wins')
    })
})

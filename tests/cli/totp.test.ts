import { afterEach, describe, expect, it, vi } from 'vitest'
import { totpCommand } from '@/cli/commands/totp'
import { totp } from '@/engine/totp'

// A valid base32 TOTP seed, and the per-env vars the account form resolves from.
const SEED = 'JBSWY3DPEHPK3PXP'

const VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    STAGING_BASE_URL: 'https://staging.example.com',
    ADMIN_EMAIL_QA: 'a@example.com',
    ADMIN_PASSWORD_QA: 'pw-a',
    ADMIN_MFA_CODE_QA: '111111',
    RESEARCHER_EMAIL_QA: 'r@example.com',
    RESEARCHER_PASSWORD_QA: 'pw-r',
    RESEARCHER_MFA_SEED_QA: SEED,
    REVIEWER_EMAIL_QA: 'v@example.com',
    REVIEWER_PASSWORD_QA: 'pw-v',
    REVIEWER_MFA_CODE_QA: '333333',
    ADMIN_EMAIL_STAGING: 'a@staging.example.com',
    ADMIN_PASSWORD_STAGING: 'pw-a-staging',
    ADMIN_MFA_CODE_STAGING: '444444',
    RESEARCHER_EMAIL_STAGING: 'r@staging.example.com',
    RESEARCHER_PASSWORD_STAGING: 'pw-r-staging',
    RESEARCHER_MFA_CODE_STAGING: '555555',
    REVIEWER_EMAIL_STAGING: 'v@staging.example.com',
    REVIEWER_PASSWORD_STAGING: 'pw-v-staging',
    REVIEWER_MFA_CODE_STAGING: '666666',
}

function captureStdout() {
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        written.push(String(chunk))
        return true
    })
    return { written, spy }
}

afterEach(() => vi.restoreAllMocks())

describe('totpCommand', () => {
    it('computes a code from a raw --secret', async () => {
        const { written } = captureStdout()
        await totpCommand({ secret: SEED }, VARS)
        expect(written.join('')).toBe(`${totp(SEED)}\n`)
    })

    it('strips whitespace from a --secret', async () => {
        const { written } = captureStdout()
        await totpCommand({ secret: 'JBSW Y3DP EHPK 3PXP' }, VARS)
        expect(written.join('')).toBe(`${totp(SEED)}\n`)
    })

    it('resolves a fixed MFA code for --role on the default (qa) env', async () => {
        const { written } = captureStdout()
        await totpCommand({ role: 'admin' }, VARS)
        expect(written.join('')).toBe('111111\n')
    })

    it('computes a TOTP when the account has a seed rather than a fixed code', async () => {
        const { written } = captureStdout()
        await totpCommand({ role: 'researcher' }, VARS)
        expect(written.join('')).toBe(`${totp(SEED)}\n`)
    })

    it('honors --env', async () => {
        const { written } = captureStdout()
        await totpCommand({ role: 'reviewer', env: 'staging' }, VARS)
        expect(written.join('')).toBe('666666\n')
    })

    // A PR preview reuses the QA accounts, so --pr must resolve the QA secrets.
    it('resolves the QA account for --pr', async () => {
        const { written } = captureStdout()
        await totpCommand({ role: 'admin', pr: '839' }, VARS)
        expect(written.join('')).toBe('111111\n')
    })

    it('requires either --secret or --role', async () => {
        await expect(totpCommand({}, VARS)).rejects.toThrow(/--secret .* or --role/)
    })

    it('rejects an unknown role', async () => {
        await expect(totpCommand({ role: 'nope' }, VARS)).rejects.toThrow(/unknown role "nope"/i)
    })
})

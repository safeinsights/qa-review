import { describe, it, expect } from 'vitest'
import { resolveEnv, resolvePrEnv } from '@/engine/env'

// Shared accounts (email + password + per-account MFA), plus the per-env base URL.
const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    ADMIN_EMAIL: 'a@example.com',
    ADMIN_PASSWORD: 'pw-a',
    ADMIN_MFA_CODE: '111111',
    RESEARCHER_EMAIL: 'r@example.com',
    RESEARCHER_PASSWORD: 'pw-r',
    RESEARCHER_MFA_CODE: '222222',
    REVIEWER_EMAIL: 'v@example.com',
    REVIEWER_PASSWORD: 'pw-v',
    REVIEWER_MFA_CODE: '333333',
}

describe('resolveEnv', () => {
    it('merges the committed declaration with shared credentials + MFA', () => {
        const cfg = resolveEnv('qa', ENV_VARS)
        expect(cfg.name).toBe('qa')
        expect(cfg.baseURL).toBe('https://qa.example.com')
        expect(cfg.accounts.admin).toEqual({ email: 'a@example.com', password: 'pw-a', mfaCode: '111111' })
        expect(cfg.accounts.researcher).toEqual({ email: 'r@example.com', password: 'pw-r', mfaCode: '222222' })
        expect(cfg.accounts.reviewer.email).toBe('v@example.com')
        expect(cfg.accounts.admin.mfaCode).toBe('111111')
        expect(cfg.accounts.reviewer.mfaCode).toBe('333333')
    })

    it('throws a clear error for an unknown environment', () => {
        expect(() => resolveEnv('nope', ENV_VARS)).toThrow(/unknown environment "nope"/i)
    })

    it('throws a clear error when a required secret is missing', () => {
        const incomplete = { ...ENV_VARS, ADMIN_PASSWORD: '' }
        expect(() => resolveEnv('qa', incomplete)).toThrow(/ADMIN_PASSWORD/)
    })

    it('throws a clear error when the base URL is undefined', () => {
        const withoutBase: Record<string, string | undefined> = { ...ENV_VARS }
        delete withoutBase.QA_BASE_URL
        expect(() => resolveEnv('qa', withoutBase)).toThrow(/QA_BASE_URL/)
    })

    it('throws a clear error when an account MFA code is missing', () => {
        const withoutMfa: Record<string, string | undefined> = { ...ENV_VARS }
        delete withoutMfa.ADMIN_MFA_CODE
        expect(() => resolveEnv('qa', withoutMfa)).toThrow(/ADMIN_MFA_CODE/)
    })

    it('surfaces the per-account, per-env results private key for the running env', () => {
        const qaPem = '-----BEGIN PRIVATE KEY-----\nqa\n'
        const stagingPem = '-----BEGIN PRIVATE KEY-----\nstaging\n'
        const withKeys = {
            ...ENV_VARS,
            STAGING_BASE_URL: 'https://staging.example.com',
            REVIEWER_RESULTS_PRIVATE_KEY_QA: qaPem,
            REVIEWER_RESULTS_PRIVATE_KEY_STAGING: stagingPem,
        }
        expect(resolveEnv('qa', withKeys).accounts.reviewer.privateKey).toBe(qaPem)
        expect(resolveEnv('staging', withKeys).accounts.reviewer.privateKey).toBe(stagingPem)
    })

    it('leaves the results private key undefined (no throw) when unset', () => {
        expect(resolveEnv('qa', ENV_VARS).accounts.reviewer.privateKey).toBeUndefined()
    })
})

describe('resolvePrEnv', () => {
    it('derives the PR preview base URL from the PR number and reuses shared creds', () => {
        const cfg = resolvePrEnv(839, ENV_VARS)
        expect(cfg.name).toBe('pr839')
        expect(cfg.baseURL).toBe('https://pr839.qa.safeinsights.org')
        expect(cfg.accounts.admin).toEqual({ email: 'a@example.com', password: 'pw-a', mfaCode: '111111' })
    })

    it('rejects a non-positive or non-integer PR number', () => {
        expect(() => resolvePrEnv(0, ENV_VARS)).toThrow(/invalid pr number/i)
        expect(() => resolvePrEnv(-5, ENV_VARS)).toThrow(/invalid pr number/i)
        expect(() => resolvePrEnv(1.5, ENV_VARS)).toThrow(/invalid pr number/i)
    })

    it('still requires the shared credentials', () => {
        const incomplete = { ...ENV_VARS, ADMIN_EMAIL: '' }
        expect(() => resolvePrEnv(839, incomplete)).toThrow(/ADMIN_EMAIL/)
    })

    it('reuses the QA results private key for PR previews', () => {
        const qaPem = '-----BEGIN PRIVATE KEY-----\nqa\n'
        const withKey = { ...ENV_VARS, REVIEWER_RESULTS_PRIVATE_KEY_QA: qaPem }
        expect(resolvePrEnv(839, withKey).accounts.reviewer.privateKey).toBe(qaPem)
    })
})

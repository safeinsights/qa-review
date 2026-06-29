import { describe, it, expect } from 'vitest'
import { resolveEnv, resolvePrEnv } from '@/engine/env'

// Shared, un-prefixed credentials + MFA, plus the per-env base URL.
const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    ADMIN_EMAIL: 'a@example.com',
    ADMIN_PASSWORD: 'pw-a',
    RESEARCHER_EMAIL: 'r@example.com',
    RESEARCHER_PASSWORD: 'pw-r',
    REVIEWER_EMAIL: 'v@example.com',
    REVIEWER_PASSWORD: 'pw-v',
    MFA_CODE: '424242',
}

describe('resolveEnv', () => {
    it('merges the committed declaration with shared credentials + MFA', () => {
        const cfg = resolveEnv('qa', ENV_VARS)
        expect(cfg.name).toBe('qa')
        expect(cfg.baseURL).toBe('https://qa.example.com')
        expect(cfg.accounts.admin).toEqual({ email: 'a@example.com', password: 'pw-a' })
        expect(cfg.accounts.researcher).toEqual({ email: 'r@example.com', password: 'pw-r' })
        expect(cfg.accounts.reviewer.email).toBe('v@example.com')
        expect(cfg.mfaCode).toBe('424242')
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

    it('throws a clear error when MFA_CODE is missing', () => {
        const withoutMfa: Record<string, string | undefined> = { ...ENV_VARS }
        delete withoutMfa.MFA_CODE
        expect(() => resolveEnv('qa', withoutMfa)).toThrow(/MFA_CODE/)
    })
})

describe('resolvePrEnv', () => {
    it('derives the PR preview base URL from the PR number and reuses shared creds', () => {
        const cfg = resolvePrEnv(839, ENV_VARS)
        expect(cfg.name).toBe('pr839')
        expect(cfg.baseURL).toBe('https://pr839.qa.safeinsights.org')
        expect(cfg.accounts.admin).toEqual({ email: 'a@example.com', password: 'pw-a' })
        expect(cfg.mfaCode).toBe('424242')
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
})

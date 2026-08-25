import { describe, expect, it } from 'vitest'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { totp } from '@/engine/totp'

// All account fields are per-env (email, password, MFA code/seed). qa is the
// default env used by most tests here.
const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    ADMIN_EMAIL_QA: 'a@example.com',
    ADMIN_PASSWORD_QA: 'pw-a',
    ADMIN_MFA_CODE_QA: '111111',
    RESEARCHER_EMAIL_QA: 'r@example.com',
    RESEARCHER_PASSWORD_QA: 'pw-r',
    RESEARCHER_MFA_CODE_QA: '222222',
    REVIEWER_EMAIL_QA: 'v@example.com',
    REVIEWER_PASSWORD_QA: 'pw-v',
    REVIEWER_MFA_CODE_QA: '333333',
}

describe('resolveEnv', () => {
    it('merges the committed declaration with per-env credentials + MFA', () => {
        const cfg = resolveEnv('qa', ENV_VARS)
        expect(cfg.name).toBe('qa')
        expect(cfg.baseURL).toBe('https://qa.example.com')
        expect(cfg.accounts.admin).toEqual({
            email: 'a@example.com',
            password: 'pw-a',
            mfaCode: '111111',
        })
        expect(cfg.accounts.researcher).toEqual({
            email: 'r@example.com',
            password: 'pw-r',
            mfaCode: '222222',
        })
        expect(cfg.accounts.reviewer.email).toBe('v@example.com')
        expect(cfg.accounts.admin.mfaCode).toBe('111111')
        expect(cfg.accounts.reviewer.mfaCode).toBe('333333')
    })

    it('throws a clear error for an unknown environment', () => {
        expect(() => resolveEnv('nope', ENV_VARS)).toThrow(/unknown environment "nope"/i)
    })

    it('throws a clear error when a required secret is missing', () => {
        const incomplete = { ...ENV_VARS, ADMIN_PASSWORD_QA: '' }
        expect(() => resolveEnv('qa', incomplete)).toThrow(/ADMIN_PASSWORD_QA/)
    })

    it('throws a clear error when the base URL is undefined', () => {
        const withoutBase: Record<string, string | undefined> = { ...ENV_VARS }
        delete withoutBase.QA_BASE_URL
        expect(() => resolveEnv('qa', withoutBase)).toThrow(/QA_BASE_URL/)
    })

    it('resolves a different env from its own per-env credentials', () => {
        const withStaging = {
            ...ENV_VARS,
            STAGING_BASE_URL: 'https://staging.example.com',
            ADMIN_EMAIL_STAGING: 'a-stg@example.com',
            ADMIN_PASSWORD_STAGING: 'pw-a-stg',
            ADMIN_MFA_CODE_STAGING: '444444',
            RESEARCHER_EMAIL_STAGING: 'r-stg@example.com',
            RESEARCHER_PASSWORD_STAGING: 'pw-r-stg',
            RESEARCHER_MFA_CODE_STAGING: '555555',
            REVIEWER_EMAIL_STAGING: 'v-stg@example.com',
            REVIEWER_PASSWORD_STAGING: 'pw-v-stg',
            REVIEWER_MFA_CODE_STAGING: '666666',
        }
        const cfg = resolveEnv('staging', withStaging)
        // Staging uses its OWN account, not qa's.
        expect(cfg.accounts.admin.email).toBe('a-stg@example.com')
        expect(cfg.accounts.admin.mfaCode).toBe('444444')
    })

    it('throws when an env has neither a fixed MFA code nor a TOTP seed', () => {
        const withoutMfa: Record<string, string | undefined> = { ...ENV_VARS }
        delete withoutMfa.ADMIN_MFA_CODE_QA
        // The error names both acceptable vars for that account+env.
        expect(() => resolveEnv('qa', withoutMfa)).toThrow(/ADMIN_MFA_CODE_QA or ADMIN_MFA_SEED_QA/)
    })

    it('surfaces the per-account, per-env results private key for the running env', () => {
        const qaPem = '-----BEGIN PRIVATE KEY-----\nqa\n'
        const stagingPem = '-----BEGIN PRIVATE KEY-----\nstaging\n'
        const withKeys = {
            ...ENV_VARS,
            STAGING_BASE_URL: 'https://staging.example.com',
            // staging needs its own account too (per-env).
            ADMIN_EMAIL_STAGING: 'a@example.com',
            ADMIN_PASSWORD_STAGING: 'pw-a',
            ADMIN_MFA_CODE_STAGING: '444444',
            RESEARCHER_EMAIL_STAGING: 'r@example.com',
            RESEARCHER_PASSWORD_STAGING: 'pw-r',
            RESEARCHER_MFA_CODE_STAGING: '555555',
            REVIEWER_EMAIL_STAGING: 'v@example.com',
            REVIEWER_PASSWORD_STAGING: 'pw-v',
            REVIEWER_MFA_CODE_STAGING: '666666',
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

describe('resolveEnv MFA seed vs fixed code', () => {
    // A valid RFC 4648 base32 secret (the same one totp.test.ts uses).
    const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

    // A full production account (email + password per role), minus the second factor.
    const PROD_BASE = {
        PRODUCTION_BASE_URL: 'https://app.safeinsights.org',
        ADMIN_EMAIL_PRODUCTION: 'a@example.com',
        ADMIN_PASSWORD_PRODUCTION: 'pw-a',
        RESEARCHER_EMAIL_PRODUCTION: 'r@example.com',
        RESEARCHER_PASSWORD_PRODUCTION: 'pw-r',
        REVIEWER_EMAIL_PRODUCTION: 'v@example.com',
        REVIEWER_PASSWORD_PRODUCTION: 'pw-v',
    }
    const PROD_SEEDS = {
        ADMIN_MFA_SEED_PRODUCTION: SEED,
        RESEARCHER_MFA_SEED_PRODUCTION: SEED,
        REVIEWER_MFA_SEED_PRODUCTION: SEED,
    }

    it('resolves the production base URL and its own results private key', () => {
        const prodPem = '-----BEGIN PRIVATE KEY-----\nprod\n'
        const cfg = resolveEnv('production', {
            ...PROD_BASE,
            ...PROD_SEEDS,
            REVIEWER_RESULTS_PRIVATE_KEY_PRODUCTION: prodPem,
            // A QA key is present too, to prove production does NOT fall back to it.
            REVIEWER_RESULTS_PRIVATE_KEY_QA: '-----BEGIN PRIVATE KEY-----\nqa\n',
        })
        expect(cfg.name).toBe('production')
        expect(cfg.baseURL).toBe('https://app.safeinsights.org')
        expect(cfg.accounts.reviewer.privateKey).toBe(prodPem)
    })

    it('computes the MFA code from the per-env TOTP seed', () => {
        const cfg = resolveEnv('production', { ...PROD_BASE, ...PROD_SEEDS })
        const code = cfg.accounts.reviewer.mfaCode
        expect(code).toMatch(/^\d{6}$/)
        // Prove the getter derives from the seed. Guard the 30s TOTP window boundary:
        // if the getter read and our expected computation straddled a step, recompute
        // once so the assertion stays deterministic.
        for (let i = 0; i < 2; i++) {
            if (cfg.accounts.reviewer.mfaCode === totp(SEED)) return
        }
        expect(cfg.accounts.reviewer.mfaCode).toBe(totp(SEED))
    })

    it('lets the seed override a fixed code set for the same env', () => {
        const cfg = resolveEnv('production', {
            ...PROD_BASE,
            ...PROD_SEEDS,
            REVIEWER_MFA_CODE_PRODUCTION: '000000',
        })
        // Seed wins: the value is a live TOTP code, not the fixed one.
        expect(cfg.accounts.reviewer.mfaCode).not.toBe('000000')
        expect(cfg.accounts.reviewer.mfaCode).toMatch(/^\d{6}$/)
    })

    it('falls back to the fixed code when no seed is set (any env)', () => {
        const cfg = resolveEnv('production', {
            ...PROD_BASE,
            ADMIN_MFA_CODE_PRODUCTION: '101010',
            RESEARCHER_MFA_CODE_PRODUCTION: '202020',
            REVIEWER_MFA_CODE_PRODUCTION: '303030',
        })
        expect(cfg.accounts.reviewer.mfaCode).toBe('303030')
    })

    it('recomputes the code on each read (getter, not a snapshot)', () => {
        // Sanity: the seed produces different codes in different windows, so a live
        // getter (vs. a value captured once at resolve time) is what keeps a
        // minutes-long run from typing a stale code.
        expect(totp(SEED, { nowMs: 0 })).not.toBe(totp(SEED, { nowMs: 60_000 }))
    })
})

describe('demo environment', () => {
    const DEMO_VARS = {
        DEMO_BASE_URL: 'https://app.demo.safeinsights.org',
        ADMIN_EMAIL_DEMO: 'a@demo.example.com',
        ADMIN_PASSWORD_DEMO: 'pw-a-demo',
        ADMIN_MFA_CODE_DEMO: '444444',
        RESEARCHER_EMAIL_DEMO: 'r@demo.example.com',
        RESEARCHER_PASSWORD_DEMO: 'pw-r-demo',
        RESEARCHER_MFA_CODE_DEMO: '555555',
        REVIEWER_EMAIL_DEMO: 'v@demo.example.com',
        REVIEWER_PASSWORD_DEMO: 'pw-v-demo',
        REVIEWER_MFA_CODE_DEMO: '666666',
    }

    it('resolves from its own per-env credentials', () => {
        // QA values are present throughout to prove demo reads DEMO_* and never
        // silently falls back to them.
        const cfg = resolveEnv('demo', { ...ENV_VARS, ...DEMO_VARS })
        expect(cfg.name).toBe('demo')
        expect(cfg.baseURL).toBe('https://app.demo.safeinsights.org')
        expect(cfg.accounts.admin).toEqual({
            email: 'a@demo.example.com',
            password: 'pw-a-demo',
            mfaCode: '444444',
        })
        expect(cfg.accounts.reviewer.email).toBe('v@demo.example.com')
    })

    it('uses its OWN results private key, not QA fallback', () => {
        // The regression this guards: privateKeyEnvFor used to hardcode
        // `staging || production`, so any newly added env silently decrypted with
        // QA's key — surfacing much later as an opaque wrong-key failure.
        const demoPem = '-----BEGIN PRIVATE KEY-----\ndemo\n'
        const cfg = resolveEnv('demo', {
            ...ENV_VARS,
            ...DEMO_VARS,
            REVIEWER_RESULTS_PRIVATE_KEY_DEMO: demoPem,
            REVIEWER_RESULTS_PRIVATE_KEY_QA: '-----BEGIN PRIVATE KEY-----\nqa\n',
        })
        expect(cfg.accounts.reviewer.privateKey).toBe(demoPem)
    })

    it('does not fall back to QA credentials when its own are missing', () => {
        // Demo is a peer of staging/production, so an unpopulated secret must fail
        // loudly rather than run against the wrong tenant's account.
        expect(() => resolveEnv('demo', ENV_VARS)).toThrow()
    })
})

describe('resolvePrEnv', () => {
    it('derives the PR preview base URL from the PR number and reuses QA creds', () => {
        const cfg = resolvePrEnv(839, ENV_VARS)
        expect(cfg.name).toBe('pr839')
        expect(cfg.baseURL).toBe('https://pr839.qa.safeinsights.org')
        expect(cfg.accounts.admin).toEqual({
            // PR previews reuse QA's account (privateKeyEnvFor maps pr* -> qa).
            email: 'a@example.com',
            password: 'pw-a',
            mfaCode: '111111',
        })
    })

    it('rejects a non-positive or non-integer PR number', () => {
        expect(() => resolvePrEnv(0, ENV_VARS)).toThrow(/invalid pr number/i)
        expect(() => resolvePrEnv(-5, ENV_VARS)).toThrow(/invalid pr number/i)
        expect(() => resolvePrEnv(1.5, ENV_VARS)).toThrow(/invalid pr number/i)
    })

    it('still requires the (QA) credentials', () => {
        const incomplete = { ...ENV_VARS, ADMIN_EMAIL_QA: '' }
        expect(() => resolvePrEnv(839, incomplete)).toThrow(/ADMIN_EMAIL_QA/)
    })

    it('reuses the QA results private key for PR previews', () => {
        const qaPem = '-----BEGIN PRIVATE KEY-----\nqa\n'
        const withKey = { ...ENV_VARS, REVIEWER_RESULTS_PRIVATE_KEY_QA: qaPem }
        expect(resolvePrEnv(839, withKey).accounts.reviewer.privateKey).toBe(qaPem)
    })
})

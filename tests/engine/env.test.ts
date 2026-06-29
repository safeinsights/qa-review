import { describe, it, expect } from 'vitest'
import { resolveEnv } from '@/engine/env'

const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    QA_ADMIN_EMAIL: 'a+clerk_test@example.com',
    QA_ADMIN_PASSWORD: 'pw-a',
    QA_RESEARCHER_EMAIL: 'r+clerk_test@example.com',
    QA_RESEARCHER_PASSWORD: 'pw-r',
    QA_REVIEWER_EMAIL: 'v+clerk_test@example.com',
    QA_REVIEWER_PASSWORD: 'pw-v',
}

describe('resolveEnv', () => {
    it('merges the committed declaration with secret env vars', () => {
        const cfg = resolveEnv('qa', ENV_VARS)
        expect(cfg.name).toBe('qa')
        expect(cfg.baseURL).toBe('https://qa.example.com')
        expect(cfg.accounts.admin).toEqual({ email: 'a+clerk_test@example.com', password: 'pw-a' })
        expect(cfg.accounts.reviewer.email).toBe('v+clerk_test@example.com')
    })

    it('throws a clear error for an unknown environment', () => {
        expect(() => resolveEnv('nope', ENV_VARS)).toThrow(/unknown environment "nope"/i)
    })

    it('throws a clear error when a required secret is missing', () => {
        const incomplete = { ...ENV_VARS, QA_ADMIN_PASSWORD: '' }
        expect(() => resolveEnv('qa', incomplete)).toThrow(/QA_ADMIN_PASSWORD/)
    })
})

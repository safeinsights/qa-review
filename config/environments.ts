// Committed declaration of which STABLE environments exist. NO secrets here —
// only the *names* of the env vars to read from .env. resolveEnv() merges this
// with process.env.
//
// Accounts are fully PER-ENV: each env has its own email, password, and second
// factor for every role, so qa/staging/production can use different test users.
// All account fields are secret (encrypted). The actual var names are derived
// per-env from the prefixes in SHARED_ACCOUNTS (`<ROLE>_EMAIL_<ENV>`,
// `<ROLE>_PASSWORD_<ENV>`, `<ROLE>_MFA_CODE_<ENV>`, `<ROLE>_MFA_SEED_<ENV>`). The
// second factor is a fixed code and/or a base32 TOTP seed — the seed wins when
// both are set. Environments otherwise differ only by base URL (the one non-secret
// per-env value).
//
// PR preview environments are NOT listed here — they are ephemeral. A PR run is
// derived from a PR number via prBaseUrl() and is otherwise identical to QA
// (same shared accounts). See resolvePrEnv() in src/engine/env.ts.

// Per-account var-name prefixes. Every field is per-env: the actual var is
// `<prefix>_<ENV>`, derived by the helpers below (emailVar/passwordVar/
// privateKeyVar/mfaCodeVar/mfaSeedVar). All are secret (encrypted).
export interface AccountVars {
    emailPrefix: string
    passwordPrefix: string
    // Results-decryption private key (PEM). Used by study-happy-path to decrypt
    // results (as the reviewer). Each QA user sets their own, for each env.
    privateKeyPrefix: string
    // Fixed second-factor code, typed verbatim at login.
    mfaCodePrefix: string
    // Base32 TOTP seed. When set for the running env, the login code is computed
    // with totp() at type-time and OVERRIDES the fixed code.
    mfaSeedPrefix: string
}

// The stable env names that have their own per-account, per-env secrets (results
// private key, MFA code, MFA seed). PR previews are NOT listed — they reuse QA.
export const PRIVATE_KEY_ENVS = ['qa', 'staging', 'production', 'demo'] as const
export type PrivateKeyEnv = (typeof PRIVATE_KEY_ENVS)[number]

// The per-account, per-env email/password var names, e.g.
// emailVar(SHARED_ACCOUNTS.reviewer, 'qa') -> 'REVIEWER_EMAIL_QA'.
export function emailVar(account: AccountVars, env: PrivateKeyEnv): string {
    return `${account.emailPrefix}_${env.toUpperCase()}`
}
export function passwordVar(account: AccountVars, env: PrivateKeyEnv): string {
    return `${account.passwordPrefix}_${env.toUpperCase()}`
}

// The per-account, per-env private-key var name, e.g.
// privateKeyVar(SHARED_ACCOUNTS.reviewer, 'qa') -> 'REVIEWER_RESULTS_PRIVATE_KEY_QA'.
export function privateKeyVar(account: AccountVars, env: PrivateKeyEnv): string {
    return `${account.privateKeyPrefix}_${env.toUpperCase()}`
}

// Which private-key env an environment name maps to. A stable env with its own key
// maps to itself; anything else — PR previews like "pr839", and any unrecognized
// name — reuses the QA key.
//
// Derived from PRIVATE_KEY_ENVS rather than listing the names again: the previous
// hardcoded `staging || production` check meant adding an env silently routed it to
// QA's key, which fails as a wrong-key decryption error far from its cause.
export function privateKeyEnvFor(envName: string): PrivateKeyEnv {
    const known = (PRIVATE_KEY_ENVS as readonly string[]).includes(envName)
    return known ? (envName as PrivateKeyEnv) : 'qa'
}

// The per-account, per-env fixed-code var name, e.g.
// mfaCodeVar(SHARED_ACCOUNTS.reviewer, 'qa') -> 'REVIEWER_MFA_CODE_QA'.
export function mfaCodeVar(account: AccountVars, env: PrivateKeyEnv): string {
    return `${account.mfaCodePrefix}_${env.toUpperCase()}`
}

// The per-account, per-env TOTP-seed var name, e.g.
// mfaSeedVar(SHARED_ACCOUNTS.reviewer, 'production') -> 'REVIEWER_MFA_SEED_PRODUCTION'.
export function mfaSeedVar(account: AccountVars, env: PrivateKeyEnv): string {
    return `${account.mfaSeedPrefix}_${env.toUpperCase()}`
}

export interface EnvDeclaration {
    name: string
    baseUrlVar: string
}

// The three roles and their per-account var-name prefixes. Every field is per-env
// (see the *Var helpers). The name SHARED_ACCOUNTS is historical — the ROLE SET is
// shared across envs, but each role's credentials are now env-specific.
export const SHARED_ACCOUNTS: Record<'admin' | 'researcher' | 'reviewer', AccountVars> = {
    admin: {
        emailPrefix: 'ADMIN_EMAIL',
        passwordPrefix: 'ADMIN_PASSWORD',
        privateKeyPrefix: 'ADMIN_RESULTS_PRIVATE_KEY',
        mfaCodePrefix: 'ADMIN_MFA_CODE',
        mfaSeedPrefix: 'ADMIN_MFA_SEED',
    },
    researcher: {
        emailPrefix: 'RESEARCHER_EMAIL',
        passwordPrefix: 'RESEARCHER_PASSWORD',
        privateKeyPrefix: 'RESEARCHER_RESULTS_PRIVATE_KEY',
        mfaCodePrefix: 'RESEARCHER_MFA_CODE',
        mfaSeedPrefix: 'RESEARCHER_MFA_SEED',
    },
    reviewer: {
        emailPrefix: 'REVIEWER_EMAIL',
        passwordPrefix: 'REVIEWER_PASSWORD',
        privateKeyPrefix: 'REVIEWER_RESULTS_PRIVATE_KEY',
        mfaCodePrefix: 'REVIEWER_MFA_CODE',
        mfaSeedPrefix: 'REVIEWER_MFA_SEED',
    },
}

export const ENVIRONMENTS: EnvDeclaration[] = [
    { name: 'qa', baseUrlVar: 'QA_BASE_URL' },
    { name: 'staging', baseUrlVar: 'STAGING_BASE_URL' },
    { name: 'production', baseUrlVar: 'PRODUCTION_BASE_URL' },
    { name: 'demo', baseUrlVar: 'DEMO_BASE_URL' },
]

// Derive a PR preview base URL from its PR number, e.g. 839 -> the pr839 host.
// PR previews live under the qa.safeinsights.org domain and behave like QA.
export function prBaseUrl(prNumber: number): string {
    return `https://pr${prNumber}.qa.safeinsights.org`
}

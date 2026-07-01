// Committed declaration of which STABLE environments exist. NO secrets here —
// only the *names* of the env vars to read from .env. resolveEnv() merges this
// with process.env.
//
// Accounts are SHARED across all environments (same test users everywhere), so
// they are declared once in SHARED_ACCOUNTS and reused. Each account carries its
// OWN second-factor code (per-account MFA). Each environment only differs by its
// base URL.
//
// PR preview environments are NOT listed here — they are ephemeral. A PR run is
// derived from a PR number via prBaseUrl() and is otherwise identical to QA
// (same shared accounts). See resolvePrEnv() in src/engine/env.ts.

export interface AccountVars {
    emailVar: string
    passwordVar: string
    mfaVar: string
    // Prefix for this account's per-ENV results-decryption private key (PEM).
    // Unlike email/password/MFA (shared across all envs), the key differs per
    // environment, so the actual var is `<privateKeyPrefix>_<ENV>` — see
    // privateKeyVar(). Secret; used by study-happy-path to decrypt results (as
    // the reviewer). Each QA user sets their own, for each env.
    privateKeyPrefix: string
}

// The env names that have their own per-account results private key. PR previews
// are NOT listed — they reuse the QA key (previews behave like qa).
export const PRIVATE_KEY_ENVS = ['qa', 'staging'] as const
export type PrivateKeyEnv = (typeof PRIVATE_KEY_ENVS)[number]

// The per-account, per-env private-key var name, e.g.
// privateKeyVar(SHARED_ACCOUNTS.reviewer, 'qa') -> 'REVIEWER_RESULTS_PRIVATE_KEY_QA'.
export function privateKeyVar(account: AccountVars, env: PrivateKeyEnv): string {
    return `${account.privateKeyPrefix}_${env.toUpperCase()}`
}

// Which private-key env an environment name maps to. Stable envs map to
// themselves; anything else (PR previews like "pr839") reuses the QA key.
export function privateKeyEnvFor(envName: string): PrivateKeyEnv {
    return envName === 'staging' ? 'staging' : 'qa'
}

export interface EnvDeclaration {
    name: string
    baseUrlVar: string
}

// Shared, un-prefixed credential var names — the same test accounts are used on
// every environment, stable or PR preview. Each account has its own MFA code var
// and its own results-decryption private key.
export const SHARED_ACCOUNTS: Record<'admin' | 'researcher' | 'reviewer', AccountVars> = {
    admin: {
        emailVar: 'ADMIN_EMAIL',
        passwordVar: 'ADMIN_PASSWORD',
        mfaVar: 'ADMIN_MFA_CODE',
        privateKeyPrefix: 'ADMIN_RESULTS_PRIVATE_KEY',
    },
    researcher: {
        emailVar: 'RESEARCHER_EMAIL',
        passwordVar: 'RESEARCHER_PASSWORD',
        mfaVar: 'RESEARCHER_MFA_CODE',
        privateKeyPrefix: 'RESEARCHER_RESULTS_PRIVATE_KEY',
    },
    reviewer: {
        emailVar: 'REVIEWER_EMAIL',
        passwordVar: 'REVIEWER_PASSWORD',
        mfaVar: 'REVIEWER_MFA_CODE',
        privateKeyPrefix: 'REVIEWER_RESULTS_PRIVATE_KEY',
    },
}

export const ENVIRONMENTS: EnvDeclaration[] = [
    { name: 'qa', baseUrlVar: 'QA_BASE_URL' },
    { name: 'staging', baseUrlVar: 'STAGING_BASE_URL' },
]

// Derive a PR preview base URL from its PR number, e.g. 839 -> the pr839 host.
// PR previews live under the qa.safeinsights.org domain and behave like QA.
export function prBaseUrl(prNumber: number): string {
    return `https://pr${prNumber}.qa.safeinsights.org`
}

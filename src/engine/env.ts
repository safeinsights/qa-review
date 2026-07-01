import { ENVIRONMENTS, SHARED_ACCOUNTS, prBaseUrl, privateKeyVar, privateKeyEnvFor } from '../../config/environments'
import type { EnvConfig, Role } from '@/engine/types'

type Vars = Record<string, string | undefined>

function read(vars: Vars, key: string): string {
    const value = vars[key]
    if (!value) throw new Error(`Missing required secret: ${key} (set it in the Settings panel or config/settings.local.json)`)
    return value
}

// Resolve the shared test accounts (email + password + per-account MFA code) used
// by every environment (stable or PR preview). Throws clear, actionable errors so
// a run never starts half-configured. Email/password/MFA are shared across all
// envs; the results-decryption private key is PER-ENV, so it's looked up for
// `envName` (PR previews reuse the QA key). The key lookup is NON-throwing: it's
// optional (only study-happy-path needs it), so a run that doesn't use it must
// not fail when it's unset.
function resolveSharedCredentials(vars: Vars, envName: string): Pick<EnvConfig, 'accounts'> {
    const keyEnv = privateKeyEnvFor(envName)
    const accounts = {} as EnvConfig['accounts']
    for (const role of Object.keys(SHARED_ACCOUNTS) as Role[]) {
        const a = SHARED_ACCOUNTS[role]
        accounts[role] = {
            email: read(vars, a.emailVar),
            password: read(vars, a.passwordVar),
            mfaCode: read(vars, a.mfaVar),
            privateKey: vars[privateKeyVar(a, keyEnv)] || undefined,
        }
    }
    return { accounts }
}

// Resolve a named, stable environment (qa, staging) from the committed
// declaration + secret values in `vars` (defaults to process.env).
export function resolveEnv(name: string, vars: Vars = process.env): EnvConfig {
    const decl = ENVIRONMENTS.find((e) => e.name === name)
    if (!decl) {
        const known = ENVIRONMENTS.map((e) => e.name).join(', ')
        throw new Error(`Unknown environment "${name}". Known environments: ${known}`)
    }
    return {
        name: decl.name,
        baseURL: read(vars, decl.baseUrlVar),
        ...resolveSharedCredentials(vars, decl.name),
    }
}

// Resolve an ephemeral PR preview environment from its PR number. The base URL
// is derived (no committed config / no per-PR env var); accounts + MFA are the
// shared ones, identical to QA.
export function resolvePrEnv(prNumber: number, vars: Vars = process.env): EnvConfig {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error(`Invalid PR number "${prNumber}". Expected a positive integer.`)
    }
    return {
        name: `pr${prNumber}`,
        baseURL: prBaseUrl(prNumber),
        // PR previews reuse the QA private key (privateKeyEnvFor maps pr* -> qa).
        ...resolveSharedCredentials(vars, `pr${prNumber}`),
    }
}

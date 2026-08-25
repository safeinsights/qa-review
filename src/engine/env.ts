import { totp } from '@/engine/totp'
import type { EnvConfig, Role } from '@/engine/types'
import {
    ENVIRONMENTS,
    emailVar,
    mfaCodeVar,
    mfaSeedVar,
    type PrivateKeyEnv,
    passwordVar,
    prBaseUrl,
    privateKeyEnvFor,
    privateKeyVar,
    SHARED_ACCOUNTS,
} from '../../config/environments'

type Vars = Record<string, string | undefined>

function read(vars: Vars, key: string): string {
    const value = vars[key]
    if (!value)
        throw new Error(
            `Missing required secret: ${key} (set it in the Settings panel or config/settings.local.json)`
        )
    return value
}

// Resolve the per-env test accounts (email + password + second factor) for a run.
// Throws clear, actionable errors so a run never starts half-configured. Every
// account field is PER-ENV, looked up for `envName` via privateKeyEnvFor (stable
// envs map to themselves; PR previews reuse QA). The results-decryption private key
// lookup is NON-throwing: it's optional (only study-happy-path needs it), so a run
// that doesn't use it must not fail when it's unset.
//
// The second factor is a fixed code (`<ROLE>_MFA_CODE_<ENV>`) and/or a base32 TOTP
// seed (`<ROLE>_MFA_SEED_<ENV>`). At least one must be set. MFA is resolved LAZILY
// via a getter: when a seed is present the code is recomputed with totp() on EVERY
// read — a TOTP code expires every 30s and a run spans minutes (login, then the
// later Coder step), so computing once at resolve time would hand out a stale code.
// When only a fixed code is set it's typed verbatim.
function resolveAccount(
    vars: Vars,
    accEnv: PrivateKeyEnv,
    role: Role
): EnvConfig['accounts'][Role] {
    const a = SHARED_ACCOUNTS[role]
    // A seed (TOTP) takes precedence over a fixed code. Exactly one is required.
    const seed = vars[mfaSeedVar(a, accEnv)] || undefined
    const fixedCode = vars[mfaCodeVar(a, accEnv)] || undefined
    if (!seed && !fixedCode) {
        throw new Error(
            `Missing required secret: ${mfaCodeVar(a, accEnv)} or ${mfaSeedVar(a, accEnv)} ` +
                `(set a fixed MFA code or a TOTP seed for ${role} on ${accEnv} in the ` +
                `Accounts panel or config/settings.local.json)`
        )
    }
    return {
        email: read(vars, emailVar(a, accEnv)),
        password: read(vars, passwordVar(a, accEnv)),
        get mfaCode(): string {
            return seed ? totp(seed) : (fixedCode as string)
        },
        privateKey: vars[privateKeyVar(a, accEnv)] || undefined,
    }
}

function resolveSharedCredentials(vars: Vars, envName: string): Pick<EnvConfig, 'accounts'> {
    const accEnv = privateKeyEnvFor(envName)
    const accounts = {} as EnvConfig['accounts']
    for (const role of Object.keys(SHARED_ACCOUNTS) as Role[]) {
        accounts[role] = resolveAccount(vars, accEnv, role)
    }
    return { accounts }
}

// Resolve a named, stable environment (qa, staging) from the committed
// declaration + secret values in `vars` (defaults to process.env).
export function resolveEnv(name: string, vars: Vars = process.env): EnvConfig {
    const decl = ENVIRONMENTS.find(e => e.name === name)
    if (!decl) {
        const known = ENVIRONMENTS.map(e => e.name).join(', ')
        throw new Error(`Unknown environment "${name}". Known environments: ${known}`)
    }
    return {
        name: decl.name,
        baseURL: read(vars, decl.baseUrlVar),
        ...resolveSharedCredentials(vars, decl.name),
    }
}

// Resolve the base URL plus ONE role's account, for commands that genuinely need
// only that role (`qar totp --role`). Note `fix-account` is NOT one of them: it also
// signs in as `admin` to get the token the QA API authorizes with, so it keeps
// resolveEnv.
//
// resolveEnv() deliberately resolves all three roles eagerly so a RUN never starts
// half-configured. For a single-role command that eagerness is a false failure: it
// reports the FIRST unconfigured role rather than the one asked for, so `totp --role
// reviewer --env demo` died on `ADMIN_MFA_CODE_DEMO` while the reviewer it was asked
// about was fully configured — which is exactly what an env is like mid-setup, one
// role at a time.
export function resolveEnvForRole(
    name: string,
    role: Role,
    vars: Vars = process.env
): { name: string; baseURL: string; account: EnvConfig['accounts'][Role] } {
    const decl = ENVIRONMENTS.find(e => e.name === name)
    if (!decl) {
        const known = ENVIRONMENTS.map(e => e.name).join(', ')
        throw new Error(`Unknown environment "${name}". Known environments: ${known}`)
    }
    return {
        name: decl.name,
        baseURL: read(vars, decl.baseUrlVar),
        account: resolveAccount(vars, privateKeyEnvFor(decl.name), role),
    }
}

// The PR-preview counterpart of resolveEnvForRole. Accounts are the shared ones,
// identical to QA (privateKeyEnvFor maps pr* -> qa).
export function resolvePrEnvForRole(
    prNumber: number,
    role: Role,
    vars: Vars = process.env
): { name: string; baseURL: string; account: EnvConfig['accounts'][Role] } {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error(`Invalid PR number "${prNumber}". Expected a positive integer.`)
    }
    return {
        name: `pr${prNumber}`,
        baseURL: prBaseUrl(prNumber),
        account: resolveAccount(vars, privateKeyEnvFor(`pr${prNumber}`), role),
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

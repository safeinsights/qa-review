import { resolveEnvForRole, resolvePrEnvForRole } from '@/engine/env'
import type { Vars } from '@/engine/settings'
import { totp } from '@/engine/totp'
import type { Role } from '@/engine/types'

const ROLES: Role[] = ['admin', 'researcher', 'reviewer']

function assertRole(role: string): Role {
    if (!(ROLES as string[]).includes(role)) {
        throw new Error(`Unknown role "${role}". Known roles: ${ROLES.join(', ')}`)
    }
    return role as Role
}

// `qar totp` — print the current 6-digit second-factor code.
//
// Two forms:
//   --secret <base32>            compute from a raw seed (e.g. the authenticator
//                                secret shown on the MFA setup page). Lets the
//                                MCP-driven validation derive codes via Bash.
//   --role <role> [--env <env>]  resolve the account's second factor from the
//   --role <role> --pr <n>       settings files, exactly as a run would.
//
// The account form goes through the env resolver rather than reading the vars
// directly, so seed-vs-fixed-code precedence and the per-env var lookup stay in ONE
// place. `mfaCode` is a lazy getter recomputed per read, so this always prints a
// code valid at THIS moment, not one captured at resolve time.
//
// It resolves ONLY the requested role (resolveEnvForRole, not resolveEnv): a run
// must fail fast if any role is unconfigured, but printing one role's code must not
// depend on the other two — otherwise setting an env up one role at a time reports
// a missing secret for a role that was never asked about.
export async function totpCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const secret = (opts.secret ?? '').replace(/\s+/g, '')
    if (secret) {
        process.stdout.write(`${totp(secret)}\n`)
        return
    }

    const role = opts.role
    if (!role) {
        throw new Error('totp requires --secret <base32-secret> or --role <role> [--env <env>]')
    }

    const resolved = opts.pr
        ? resolvePrEnvForRole(Number(opts.pr), assertRole(role), vars)
        : resolveEnvForRole(opts.env ?? 'qa', assertRole(role), vars)

    process.stdout.write(`${resolved.account.mfaCode}\n`)
}

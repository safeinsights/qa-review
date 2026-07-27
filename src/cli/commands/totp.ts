import { resolveEnv, resolvePrEnv } from '@/engine/env'
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
// The account form goes through resolveEnv/resolvePrEnv rather than reading the
// vars directly, so seed-vs-fixed-code precedence and the per-env var lookup stay
// in ONE place. `mfaCode` is a lazy getter recomputed per read, so this always
// prints a code valid at THIS moment, not one captured at resolve time.
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

    const envConfig = opts.pr
        ? resolvePrEnv(Number(opts.pr), vars)
        : resolveEnv(opts.env ?? 'qa', vars)

    process.stdout.write(`${envConfig.accounts[assertRole(role)].mfaCode}\n`)
}

import type { InvitedRole } from '@/engine/flows/signup'
import { dispatchSessionAction, type SessionResult } from '@/engine/session-rpc'

// Build the one JSON line the command prints. The default line is byte-for-byte
// what it has always been, so existing readers of userId/email are unaffected —
// `mfaSecret` is strictly additive and appears ONLY when explicitly asked for.
// This is the single place the secret can reach stdout; it crosses the session-RPC
// boundary regardless, so keeping the gate here keeps it auditable in one spot.
export function createUserOutputLine(result: SessionResult, printMfaSecret: boolean): string {
    const printed: Record<string, string | undefined> = {
        userId: result.userId,
        email: result.email,
    }
    if (printMfaSecret) printed.mfaSecret = result.mfaSecret
    return JSON.stringify(printed)
}

// `qar session-create-user --role researcher|reviewer` — create a brand-new user
// from scratch on a running `qar session`'s held (streamed) browser: log in as
// admin, mint an invite through the QA API for the org implying the role, and
// complete the full signup from its URL (create-account → MFA → recovery → security
// key). Prints one JSON line `{ "userId", "email" }` so Claude can track the user for
// cleanup (`qar cleanup --users <id>`). Exits non-zero on failure so Claude can react.
// Reuses the exact tested signup flow — no MCP hand-driving.
//
// `--print-mfa-secret` adds the account's base32 TOTP secret to that JSON, which is
// what makes it possible to sign back IN as the created user (pair it with
// `qar totp --secret <v>`; the password is the constant SIGNUP_PASSWORD). Without it
// the account is unreachable once the session moves on. It's opt-in because the value
// lands in the GUI's streamed session output and any transcript of it — printing a
// secret should be a deliberate act by the caller, not a side effect of creating a user.
export async function sessionCreateUserCommand(opts: Record<string, string>): Promise<void> {
    const role = opts.role as InvitedRole
    if (role !== 'researcher' && role !== 'reviewer') {
        throw new Error(
            `--role must be one of researcher, reviewer (got "${opts.role ?? ''}") — ` +
                'the invited role is implied by the org (researcher→openstax-lab, reviewer→openstax)'
        )
    }

    // The invite URL now comes straight from the QA API (no ~2min email wait), but the
    // signup itself is still a full Clerk chain — create account, TOTP, recovery codes,
    // security key — so keep a generous window.
    const result = await dispatchSessionAction(
        { action: 'create-user', role },
        120_000,
        'create the user'
    )
    if (!result.ok) {
        throw new Error(`create-user (${role}) failed: ${result.error ?? 'unknown error'}`)
    }
    process.stdout.write(`${createUserOutputLine(result, Boolean(opts['print-mfa-secret']))}\n`)
}

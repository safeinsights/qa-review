import type { InvitedRole } from '@/engine/flows/signup'
import { dispatchSessionAction } from '@/engine/session-rpc'

// `qar session-create-user --role researcher|reviewer` — create a brand-new user
// from scratch on a running `qar session`'s held (streamed) browser: log in as
// admin, mint an invite through the QA API for the org implying the role, and
// complete the full signup from its URL (create-account → MFA → recovery → security
// key). Prints one JSON line `{ "userId", "email" }` so Claude can track the user for
// cleanup (`qar cleanup --users <id>`). Exits non-zero on failure so Claude can react.
// Reuses the exact tested signup flow — no MCP hand-driving.
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
    process.stdout.write(`${JSON.stringify({ userId: result.userId, email: result.email })}\n`)
}

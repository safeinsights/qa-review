import type { InvitedRole } from '@/engine/flows/signup'
import { newRequestId, waitForSessionResult, writeSessionRequest } from '@/engine/session-rpc'

// `qar session-create-user --role researcher|reviewer` — create a brand-new user
// from scratch on a running `qar session`'s held (streamed) browser: log in as
// admin, invite a fresh mail.tm address into the org implying the role, wait for the
// invite email, and complete the full signup (create-account → MFA → recovery →
// security key). Prints one JSON line `{ "userId", "email" }` so Claude can track
// the user for cleanup (`qar cleanup --users <id>`). Exits non-zero on failure so
// Claude can react. Reuses the exact tested signup flow — no MCP hand-driving.
export async function sessionCreateUserCommand(opts: Record<string, string>): Promise<void> {
    const role = opts.role as InvitedRole
    if (role !== 'researcher' && role !== 'reviewer') {
        throw new Error(
            `--role must be one of researcher, reviewer (got "${opts.role ?? ''}") — ` +
                'the invited role is implied by the org (researcher→openstax-lab, reviewer→openstax)'
        )
    }

    const id = newRequestId()
    writeSessionRequest(id, { action: 'create-user', role })

    // The full invite → email delivery → signup + MFA chain is slow; allow a wide
    // window (invite email alone can take ~2 min).
    const result = await waitForSessionResult(id, 240_000)
    if (!result) {
        throw new Error(
            'timed out waiting for the session to create the user — is a `qar session` running?'
        )
    }
    if (!result.ok) {
        throw new Error(`create-user (${role}) failed: ${result.error ?? 'unknown error'}`)
    }
    process.stdout.write(`${JSON.stringify({ userId: result.userId, email: result.email })}\n`)
}

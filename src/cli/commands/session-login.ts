import { dispatchSessionAction } from '@/engine/session-rpc'
import type { Role } from '@/engine/types'

// `qar session-login --role <r>` — trigger an on-demand login of a running
// `qar session`'s browser. Writes a login request to the rendezvous file the session
// watches, then waits for the session to write back a result. Prints the outcome
// and exits non-zero on failure/timeout so Claude (which invokes this) can react.
export async function sessionLoginCommand(opts: Record<string, string>): Promise<void> {
    const role = opts.role as Role
    if (role !== 'admin' && role !== 'researcher' && role !== 'reviewer') {
        throw new Error(
            `--role must be one of admin, researcher, reviewer (got "${opts.role ?? ''}")`
        )
    }

    // loginAs runs a full Clerk+MFA flow, so allow a generous window.
    const result = await dispatchSessionAction({ action: 'login', role }, 90_000, 'log in')
    if (!result.ok) {
        throw new Error(`login as ${role} failed: ${result.error ?? 'unknown error'}`)
    }
    process.stdout.write(`Logged in as ${role}.\n`)
}

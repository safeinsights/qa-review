import { SIGNUP_PASSWORD } from '@/engine/flows/signup'
import { dispatchSessionAction, type SessionResult, type SignInRequest } from '@/engine/session-rpc'

// `qar session-signin --email <e> [--password <p>]` — sign the RUNNING session's
// browser in as an ARBITRARY account and stop at the second-factor code entry,
// without submitting a code.
//
// This is the entry point for validating the auth screens' own error states (an
// incomplete code, a code Clerk rejects, a spent recovery code): they can only be
// reached by FAILING the second factor, which `session-login` cannot do because it
// only submits codes it expects to work.
//
// `--password` defaults to the signup flow's fixed test password, so a user made by
// `qar session-create-user` needs only its printed email. Intended for exactly that
// throwaway user — wrong codes count against the account's rate limit, and the shared
// accounts are what CI depends on.

// Validate the flags and build the request. Split out from the command so the
// wire payload — including the password default — is testable without standing up a
// session and waiting out its timeout.
export function signInRequestFor(opts: Record<string, string>): SignInRequest {
    const email = opts.email
    if (!email) throw new Error('--email is required (the account to sign in as)')
    return { action: 'signin', email, password: opts.password || SIGNUP_PASSWORD }
}

// Decide whether the session actually signed in, and throw a diagnosis if not.
//
// The `atMfa` check is what catches a version skew, and it is not theoretical: the
// session is a LONG-LIVED process started from whatever engine build was current at
// the time, while this client is whatever the clone has now. An older session's
// action switch has no `signin` case, so it falls through and reports `ok: true` with
// an empty payload — which without this check would print a cheerful success while
// the browser sat untouched on the page it was already on. The clone routinely runs
// ahead of the packaged app, so this is the normal state during an upgrade, not an
// edge case. Split out from the command so it is testable without a live session.
export function assertSignedInAtMfa(result: SessionResult, email: string): void {
    if (!result.ok) {
        throw new Error(`sign-in as ${email} failed: ${result.error ?? 'unknown error'}`)
    }
    if (!result.atMfa) {
        throw new Error(
            `the running session accepted the request but did not report reaching the MFA step — ` +
                `it is almost certainly an older engine build that does not support ` +
                `session-signin. Restart the session (and rebuild the engine bundle if this is ` +
                `the packaged app) before retrying.`
        )
    }
}

export async function sessionSignInCommand(opts: Record<string, string>): Promise<void> {
    const request = signInRequestFor(opts)
    const email = request.email

    // A full Clerk sign-in up to the MFA picker, so allow the same window as login.
    const result = await dispatchSessionAction(request, 90_000, 'sign in')
    assertSignedInAtMfa(result, email)
    process.stdout.write(`${JSON.stringify({ email, atMfa: true })}\n`)
}

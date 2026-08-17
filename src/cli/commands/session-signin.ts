import { SIGNUP_PASSWORD } from '@/engine/flows/signup'
import {
    newRequestId,
    type SignInRequest,
    waitForSessionResult,
    writeSessionRequest,
} from '@/engine/session-rpc'

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

export async function sessionSignInCommand(opts: Record<string, string>): Promise<void> {
    const request = signInRequestFor(opts)
    const email = request.email

    const id = newRequestId()
    writeSessionRequest(id, request)

    // A full Clerk sign-in up to the MFA picker, so allow the same window as login.
    const result = await waitForSessionResult(id, 90_000)
    if (!result) {
        throw new Error(
            'timed out waiting for the session to sign in — is a `qar session` running?'
        )
    }
    if (!result.ok) {
        throw new Error(`sign-in as ${email} failed: ${result.error ?? 'unknown error'}`)
    }
    process.stdout.write(`${JSON.stringify({ email, atMfa: true })}\n`)
}

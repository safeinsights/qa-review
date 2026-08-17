import { describe, expect, it } from 'vitest'
import { assertSignedInAtMfa, signInRequestFor } from '@/cli/commands/session-signin'
import { SIGNUP_PASSWORD } from '@/engine/flows/signup'

// `qar session-signin` is the only path that reaches the auth screens' FAILURE
// states (an incomplete code, a Clerk-rejected code, a spent recovery code) — it
// stops at the second-factor step instead of submitting a code. The behaviour worth
// pinning is the payload it puts on the wire: it must name the account to sign in
// as, and must default the password to the signup flow's fixed test password so a
// user created by `session-create-user` needs only its printed email.
describe('qar session-signin', () => {
    it('requires --email', () => {
        expect(() => signInRequestFor({})).toThrow(/--email is required/)
        expect(() => signInRequestFor({ password: 'p' })).toThrow(/--email is required/)
    })

    it('defaults the password to the signup flow password so only the email is needed', () => {
        expect(signInRequestFor({ email: 'qar+new@example.com' })).toEqual({
            action: 'signin',
            email: 'qar+new@example.com',
            password: SIGNUP_PASSWORD,
        })
    })

    it('passes an explicit --password through instead of the default', () => {
        const request = signInRequestFor({ email: 'someone@example.com', password: 'other-pw' })
        expect(request.password).toBe('other-pw')
        expect(request.password).not.toBe(SIGNUP_PASSWORD)
    })

    it('treats an empty --password as absent rather than signing in with a blank one', () => {
        // The GUI and shell wrappers can pass an empty flag value; a blank password
        // would fail Clerk in a way that looks like wrong credentials.
        expect(signInRequestFor({ email: 'a@b.co', password: '' }).password).toBe(SIGNUP_PASSWORD)
    })
})

// A long-lived session runs whatever engine build was current when it started, while
// this client is whatever the clone has now. An older session has no `signin` case in
// its action switch, so it falls through and reports success with an empty payload.
// Without the `atMfa` check that prints a false success while the browser sits
// untouched — and the clone routinely runs ahead of the packaged app, so this is the
// normal upgrade state rather than an edge case.
describe('assertSignedInAtMfa', () => {
    it('accepts a session that reports reaching the MFA step', () => {
        expect(() =>
            assertSignedInAtMfa({ id: '1', ok: true, atMfa: true }, 'a@b.co')
        ).not.toThrow()
    })

    it('rejects an ok-but-empty result from an older session build', () => {
        expect(() => assertSignedInAtMfa({ id: '1', ok: true }, 'a@b.co')).toThrow(
            /older engine build/
        )
    })

    it('surfaces the session error when the sign-in itself failed', () => {
        expect(() =>
            assertSignedInAtMfa({ id: '1', ok: false, error: 'bad credentials' }, 'a@b.co')
        ).toThrow(/bad credentials/)
    })

    it('reports a missing result as a timeout rather than a version problem', () => {
        expect(() => assertSignedInAtMfa(null, 'a@b.co')).toThrow(/timed out/)
    })
})

import { describe, expect, it } from 'vitest'
import { signInRequestFor } from '@/cli/commands/session-signin'
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

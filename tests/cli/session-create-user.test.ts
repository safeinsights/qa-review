import { describe, expect, it } from 'vitest'
import { createUserOutputLine } from '@/cli/commands/session-create-user'
import type { SessionResult } from '@/engine/session-rpc'

// A user created by `session-create-user` used to be unreachable the moment the
// session moved on: its TOTP secret was generated during signup and thrown away, so
// nothing could ever sign back in as it. The secret is now threaded out, but printing
// it is opt-in — it lands in the GUI's streamed session output and any transcript of
// it, so it must never appear unless the caller asked. Both halves are pinned here:
// the default line must stay byte-identical for existing readers, and the flag must
// actually surface a usable secret.
const result: SessionResult = {
    id: 'req-1',
    ok: true,
    userId: 'user-uuid-1',
    email: 'qa+123@example.com',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
}

describe('createUserOutputLine', () => {
    it('omits the secret by default, printing exactly the fields it always printed', () => {
        const line = createUserOutputLine(result, false)
        expect(line).toBe('{"userId":"user-uuid-1","email":"qa+123@example.com"}')
        expect(line).not.toContain('JBSWY3DPEHPK3PXP')
        expect(line).not.toContain('mfaSecret')
    })

    it('includes the secret alongside userId/email when explicitly requested', () => {
        expect(JSON.parse(createUserOutputLine(result, true))).toEqual({
            userId: 'user-uuid-1',
            email: 'qa+123@example.com',
            mfaSecret: 'JBSWY3DPEHPK3PXP',
        })
    })

    it('stays valid JSON when the session reports no secret', () => {
        // An older long-lived session predates the field and reports nothing for it;
        // asking for the secret then must not emit a `"mfaSecret":undefined` line.
        const line = createUserOutputLine({ ...result, mfaSecret: undefined }, true)
        expect(JSON.parse(line)).toEqual({
            userId: 'user-uuid-1',
            email: 'qa+123@example.com',
        })
    })
})

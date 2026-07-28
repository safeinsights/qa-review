import { describe, expect, it } from 'vitest'
import { totp } from '@/engine/totp'

describe('totp', () => {
    // RFC 6238 test vector: secret "12345678901234567890" (ASCII) = base32
    // "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", SHA-1, 6 digits, 30s step.
    // At Unix time 59 (T=1) the expected TOTP is 287082.
    it('matches the RFC 6238 SHA-1 test vector at T=59', () => {
        const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        expect(totp(secret, { nowMs: 59_000 })).toBe('287082')
    })

    it('matches the RFC 6238 vector at T=1111111109', () => {
        const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        expect(totp(secret, { nowMs: 1111111109_000 })).toBe('081804')
    })

    it('ignores spaces and lowercase in the secret', () => {
        expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', { nowMs: 59_000 })).toBe('287082')
    })
})

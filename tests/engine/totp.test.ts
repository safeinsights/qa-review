import { beforeEach, describe, expect, it } from 'vitest'
import { freshTotp, resetFreshTotpForTests, totp } from '@/engine/totp'

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

// A clock that only moves when the code under test sleeps.
function fakeClock(startMs: number) {
    let nowMs = startMs
    const slept: number[] = []
    return {
        now: () => nowMs,
        sleep: async (ms: number) => {
            slept.push(ms)
            nowMs += ms
        },
        advance: (ms: number) => {
            nowMs += ms
        },
        slept,
    }
}

describe('freshTotp', () => {
    beforeEach(() => resetFreshTotpForTests())

    it('returns the current code at once early in a window', async () => {
        const clock = fakeClock(1_000_000_020_000)
        expect(await freshTotp(SECRET, clock)).toBe(totp(SECRET, { nowMs: 1_000_000_020_000 }))
        expect(clock.slept).toEqual([])
    })

    it('waits for the next window instead of reusing a code in the same window', async () => {
        const clock = fakeClock(1_000_000_020_000)
        const first = await freshTotp(SECRET, clock)
        clock.advance(2_000)
        const second = await freshTotp(SECRET, clock)
        expect(clock.slept).toHaveLength(1)
        expect(second).not.toBe(first)
        expect(second).toBe(totp(SECRET, { nowMs: clock.now() }))
    })

    it('does not wait for a second sign-in in a later window', async () => {
        const clock = fakeClock(1_000_000_020_000)
        await freshTotp(SECRET, clock)
        clock.advance(30_000)
        await freshTotp(SECRET, clock)
        expect(clock.slept).toEqual([])
    })

    it('steps over a code about to expire', async () => {
        const clock = fakeClock(1_000_000_048_000)
        await freshTotp(SECRET, clock)
        expect(clock.slept).toEqual([2_500])
    })

    it('tracks each secret on its own', async () => {
        const clock = fakeClock(1_000_000_020_000)
        await freshTotp(SECRET, clock)
        await freshTotp('JBSWY3DPEHPK3PXP', clock)
        expect(clock.slept).toEqual([])
    })
})

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

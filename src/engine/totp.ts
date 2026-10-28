import { createHmac } from 'node:crypto'

// Decode an RFC 4648 base32 string (A–Z, 2–7) into bytes. Ignores spaces and is
// case-insensitive, so a secret copied from an authenticator setup screen works
// whether or not it's grouped/lowercased.
function base32Decode(input: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
    let bits = ''
    for (const ch of clean) {
        const val = alphabet.indexOf(ch)
        if (val === -1) throw new Error(`invalid base32 character: ${ch}`)
        bits += val.toString(2).padStart(5, '0')
    }
    const bytes: number[] = []
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
    }
    return Buffer.from(bytes)
}

export interface TotpOptions {
    // Milliseconds since epoch; defaults to Date.now(). Injectable for tests.
    nowMs?: number
    // Seconds per step (default 30) and number of digits (default 6).
    stepSeconds?: number
    digits?: number
}

// Compute a TOTP code (RFC 6238, HMAC-SHA1) from a base32 secret. Used to satisfy
// the authenticator-app MFA a newly-invited user must set up during signup — the
// signup page shows the secret in plaintext, and we derive the current code.
export function totp(secret: string, options: TotpOptions = {}): string {
    const { nowMs = Date.now(), stepSeconds = 30, digits = 6 } = options
    const counter = Math.floor(nowMs / 1000 / stepSeconds)
    const buf = Buffer.alloc(8)
    buf.writeBigInt64BE(BigInt(counter))
    const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest()
    const offset = hmac[hmac.length - 1] & 0xf
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
    return code.toString().padStart(digits, '0')
}

export interface FreshTotpOptions {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    // A code read this close to the end of its window can expire before it is typed.
    minMsLeft?: number
}

const STEP_MS = 30_000

// The last 30s window a code was handed out for, per secret. Clerk refuses a TOTP code
// that was already accepted, so two sign-ins as the same account inside one window fail
// the second with "Invalid verification code". release-happy-path hit exactly that: it
// signs in as reviewer, then switches back to reviewer about 25 s later.
const lastWindowBySecret = new Map<string, number>()

// A TOTP code that is safe to submit: never one this process has already used, and never
// one about to expire. Waits for the next window when either would happen.
export async function freshTotp(secret: string, options: FreshTotpOptions = {}): Promise<string> {
    const {
        now = Date.now,
        sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
        minMsLeft = 8_000,
    } = options
    let nowMs = now()
    const window = Math.floor(nowMs / STEP_MS)
    const msLeft = STEP_MS - (nowMs % STEP_MS)
    if (lastWindowBySecret.get(secret) === window || msLeft < minMsLeft) {
        await sleep(msLeft + 500)
        nowMs = now()
    }
    lastWindowBySecret.set(secret, Math.floor(nowMs / STEP_MS))
    return totp(secret, { nowMs })
}

// Tests only: forget which windows were used.
export function resetFreshTotpForTests(): void {
    lastWindowBySecret.clear()
}

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

import { totp } from '@/engine/totp'

// `qar totp --secret <base32>` — print the current 6-digit TOTP code for a base32
// secret (e.g. the authenticator secret shown on the MFA setup page). Lets the
// MCP-driven validation derive MFA codes via Bash using the tested TOTP impl.
export async function totpCommand(opts: Record<string, string>): Promise<void> {
    const secret = (opts.secret ?? '').replace(/\s+/g, '')
    if (!secret) throw new Error('totp requires --secret <base32-secret>')
    process.stdout.write(`${totp(secret)}\n`)
}

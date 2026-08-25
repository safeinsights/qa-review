export interface ParseArgsOptions {
    booleans: string[]
}

// ONE list shared by every subcommand, so a name listed here is valueless
// EVERYWHERE — `--key FOO` yields 'true' and drops FOO no matter which command
// reads it. That is why get-secret and set-secret both name the var with `--name`.
//
// `help` MUST be here: otherwise `qar session --help` parses `--help` as a key
// expecting a value, silently launches a session, and reports nothing.
export const BOOLEANS = [
    'json',
    'headed',
    'screencast',
    'help',
    // invite / fix-account flags: valueless switches, so the parser must not swallow
    // the following argument as their value.
    'admin',
    'password',
    'key',
    'yes',
    // get-secret: valueless switch that permits printing a secret to a terminal.
    'force',
    // session-create-user: opt in to printing the new account's TOTP secret.
    'print-mfa-secret',
]

// Minimal `--key value` / `--bool` parser. Returns a flat string map. Boolean
// flags (listed in options.booleans) take no value and resolve to 'true'.
export function parseArgs(argv: string[], options: ParseArgsOptions): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]
        if (!token.startsWith('--')) continue
        const key = token.slice(2)
        if (options.booleans.includes(key)) {
            out[key] = 'true'
        } else {
            out[key] = argv[++i] ?? ''
        }
    }
    return out
}

export interface ParseArgsOptions {
    booleans: string[]
}

// Valueless switches, scoped to the subcommand that actually declares them.
//
// This used to be ONE list shared by every subcommand, which made a name listed
// here valueless EVERYWHERE. That is a trap rather than a rule: adding `password`
// for fix-account's `--password` switch silently broke `session-signin --password
// <value>`, which had shipped earlier and takes a real value. The parser sent Clerk
// the literal string 'true' and the sign-in failed as "credentials rejected",
// naming nothing that pointed at the parser.
//
// Scoping the sets means a new switch can only ever affect its own command.
const COMMAND_BOOLEANS: Record<string, readonly string[]> = {
    run: ['json', 'headed', 'screencast'],
    invite: ['admin'],
    'fix-account': ['password', 'key', 'yes'],
    'session-create-user': ['print-mfa-secret'],
    // `key` stays valueless on both secret commands even though only fix-account
    // declares it as a switch. `--key <VAR>` once encrypted under a var literally
    // named "true" and reported success; keeping it valueless is what lets both
    // commands REJECT it by name instead of quietly accepting it as an alias for
    // `--name`. Aliasing would be a behaviour change, not a bug fix.
    'get-secret': ['force', 'key'],
    'set-secret': ['key'],
}

// `help` MUST be here: otherwise `qar session --help` parses `--help` as a key
// expecting a value, silently launches a session, and reports nothing. It is the
// one flag every subcommand answers, so it is the one flag that stays global.
const GLOBAL_BOOLEANS = ['help'] as const

// The valueless switches for one subcommand. An unknown subcommand still gets the
// globals, so `qar nonsense --help` reaches the unknown-command message rather than
// consuming the next token.
export function booleansFor(command: string | undefined): string[] {
    return [...GLOBAL_BOOLEANS, ...(COMMAND_BOOLEANS[command ?? ''] ?? [])]
}

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

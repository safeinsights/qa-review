import type { Vars } from '@/engine/settings'

// Read ONE decrypted value out of the merged settings. The counterpart to
// set-secret, which could previously only be written — the sole read path was an
// ad-hoc `tsx -e` calling loadSettings(), which bypasses the CLI's error messages.
//
// An absent key and an empty one are distinguished: a var that exists but decrypted
// to nothing means the secrets file holds a blank, which is a different fix from a
// typo'd name.
export function readSecret(vars: Vars, key: string): string {
    if (!(key in vars)) {
        throw new Error(
            `get-secret: ${key} is not set — check the name, or that your key is a ` +
                'recipient (qar access-status)'
        )
    }
    const value = vars[key]
    if (!value) throw new Error(`get-secret: ${key} is set but empty`)
    return value
}

// The var is named with --name, NOT --key. `key` is listed valueless for this command
// in src/cli/args.ts, so `--key FOO` parses to 'true' and drops FOO. That is
// deliberate: `--key` was the documented flag once, and letting it through now would
// look up a var called "true" — a silent wrong answer. Kept valueless so the guard
// below can name the mistake instead.
export async function getSecretCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const key = opts.name
    if (!key && opts.key) {
        throw new Error(
            'get-secret: `--key <VAR>` is parsed as a valueless switch and loses the name. ' +
                'Use `--name <VAR>` instead.'
        )
    }
    if (!key) throw new Error('get-secret: --name <VAR> is required')
    const value = readSecret(vars, key)

    // Refuse to print to a terminal without --force. These values are RSA private
    // keys and account passwords; landing one in scrollback (or a shared screen)
    // is the failure this guard exists for. Redirecting to a file or piping is the
    // normal path and passes through untouched.
    if (process.stdout.isTTY && opts.force !== 'true') {
        throw new Error(
            `get-secret: refusing to print ${key} to a terminal — redirect it ` +
                `(qar get-secret --name ${key} > out.pem) or pass --force`
        )
    }

    // write(), not console.log(): a trailing newline corrupts a PEM for consumers
    // that hash or byte-compare it.
    process.stdout.write(value)
}

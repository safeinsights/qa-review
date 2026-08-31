import { describe, expect, it } from 'vitest'
import { booleansFor, parseArgs } from '@/cli/args'
import { getSecretCommand, readSecret } from '@/cli/commands/get-secret'

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n'

describe('readSecret', () => {
    it('returns the decrypted value', () => {
        expect(
            readSecret({ REVIEWER_RESULTS_PRIVATE_KEY_QA: PEM }, 'REVIEWER_RESULTS_PRIVATE_KEY_QA')
        ).toBe(PEM)
    })

    it('names the missing var and points at access-status', () => {
        expect(() => readSecret({}, 'NOPE')).toThrow(/NOPE is not set/)
        expect(() => readSecret({}, 'NOPE')).toThrow(/access-status/)
    })

    // A blank value means the secrets file holds an empty string — a different fix
    // from a typo'd name, so the two must not collapse into one message.
    it('distinguishes an empty value from an absent one', () => {
        expect(() => readSecret({ EMPTY: '' }, 'EMPTY')).toThrow(/set but empty/)
    })
})

describe('getSecretCommand', () => {
    // Capture stdout rather than asserting on a mock: the no-trailing-newline
    // behavior is the point, and console.log would hide it.
    async function capture(opts: Record<string, string>, vars: Record<string, string>) {
        const written: string[] = []
        const orig = process.stdout.write
        process.stdout.write = ((s: string) => {
            written.push(s)
            return true
        }) as typeof process.stdout.write
        try {
            await getSecretCommand(opts, vars)
        } finally {
            process.stdout.write = orig
        }
        return written.join('')
    }

    it('writes the value with no trailing newline, so a PEM is byte-exact', async () => {
        const out = await capture({ name: 'K', force: 'true' }, { K: PEM })
        expect(out).toBe(PEM)
    })

    it('requires --name', async () => {
        await expect(getSecretCommand({}, { K: PEM })).rejects.toThrow(/--name <VAR> is required/)
    })

    // Without this the message is the generic "--name is required", which does not
    // tell someone who typed `--key K` what they got wrong.
    it('names --key as the mistake rather than reporting a missing --name', async () => {
        await expect(getSecretCommand({ key: 'true' }, { K: PEM })).rejects.toThrow(
            /Use `--name <VAR>` instead/
        )
    })

    it('suggests redirecting rather than --force when refusing a TTY', async () => {
        const orig = process.stdout.isTTY
        process.stdout.isTTY = true
        try {
            await expect(getSecretCommand({ name: 'K' }, { K: PEM })).rejects.toThrow(
                /refusing to print K to a terminal/
            )
        } finally {
            process.stdout.isTTY = orig
        }
    })
})

// `--key` is listed valueless for get-secret: it was the documented flag once, and
// letting it carry a value now would look up a var literally named "true". It stays
// valueless so the command can reject it by name, which is why the flag is --name.
describe('--key is valueless for get-secret and must not be reused', () => {
    const BOOLEANS = booleansFor('get-secret')

    it('swallows the var name if get-secret used --key', () => {
        const opts = parseArgs(['--key', 'REVIEWER_RESULTS_PRIVATE_KEY_QA'], { booleans: BOOLEANS })
        expect(opts.key).toBe('true')
        expect(opts.name).toBeUndefined()
    })

    it('parses --name as a value flag', () => {
        const opts = parseArgs(['--name', 'REVIEWER_RESULTS_PRIVATE_KEY_QA'], {
            booleans: BOOLEANS,
        })
        expect(opts.name).toBe('REVIEWER_RESULTS_PRIVATE_KEY_QA')
    })

    it('treats --force as valueless, not swallowing a following flag', () => {
        const opts = parseArgs(['--force', '--name', 'K'], { booleans: BOOLEANS })
        expect(opts.force).toBe('true')
        expect(opts.name).toBe('K')
    })
})

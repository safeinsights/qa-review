import * as fs from 'node:fs'
import * as path from 'node:path'
import { fingerprint, readKeyring, recipients, writeLock } from '@/engine/keyring'
import { configDir, encryptToRecipients, SECRETS_FILE } from '@/engine/settings'

// Encrypt ONE plaintext value to all current recipients, writing just that key
// into settings.secrets.json. Updates the lock.
export async function setSecret(dir: string, key: string, plain: string): Promise<void> {
    const keys = recipients(readKeyring(dir))
    if (keys.length === 0) throw new Error('set-secret: keyring is empty — add a recipient first')
    const secretsPath = path.join(dir, SECRETS_FILE)
    const secrets: Record<string, string> = fs.existsSync(secretsPath)
        ? JSON.parse(fs.readFileSync(secretsPath, 'utf8') || '{}')
        : {}
    secrets[key] = await encryptToRecipients(plain, keys)
    fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`)
    writeLock(dir, fingerprint(keys))
}

// The var is named with **`--name`, not `--key`** — the same trap that already made
// get-secret use `--name`. `key` is listed valueless for this command in
// src/cli/args.ts, so `--key FOO` parses to 'true' and drops FOO entirely. That wrote
// a secret literally named "true" and reported success, so `--key` is rejected
// outright rather than aliased. The listing is deliberate now that boolean sets are
// per-command: dropping it would turn `--key` into a working alias, which is a
// behaviour change and not one this command wants.
export async function setSecretCommand(opts: Record<string, string>): Promise<void> {
    const key = opts.name
    const value = opts.value
    if (!key && opts.key) {
        throw new Error(
            'set-secret: `--key <VAR>` is parsed as a valueless switch and loses the name. ' +
                'Use `--name <VAR>` instead.'
        )
    }
    if (!key || !value) throw new Error('set-secret: --name and --value are required')
    await setSecret(configDir(), key, value)
    console.log(`Encrypted ${key} to ${readKeyring().length} recipient(s).`)
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir, SECRETS_FILE, encryptToRecipients } from '@/engine/settings'
import { readKeyring, recipients, fingerprint, writeLock } from '@/engine/keyring'

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
    fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n')
    writeLock(dir, fingerprint(keys))
}

export async function setSecretCommand(opts: Record<string, string>): Promise<void> {
    const key = opts.key
    const value = opts.value
    if (!key || !value) throw new Error('set-secret: --key and --value are required')
    await setSecret(configDir(), key, value)
    console.log(`Encrypted ${key} to ${readKeyring().length} recipient(s).`)
}

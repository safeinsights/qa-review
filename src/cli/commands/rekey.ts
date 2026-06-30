import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir, SECRETS_FILE, isEncryptedValue, decryptWithIdentity, encryptToRecipients } from '@/engine/settings'
import { readIdentity } from '@/engine/identity'
import { readKeyring, recipients, fingerprint, writeLock } from '@/engine/keyring'

// Re-encrypt every secret in settings.secrets.json to the CURRENT keyring, then
// update keyring.lock. `identity` must be able to decrypt the existing secrets.
export async function rekeyAll(dir: string = configDir(), identity?: string): Promise<void> {
    const id = identity ?? readIdentity(dir)
    if (!id) throw new Error('rekey: no local identity — run `qar request-access` first')
    const keys = recipients(readKeyring(dir))
    if (keys.length === 0) throw new Error('rekey: keyring is empty')

    const secretsPath = path.join(dir, SECRETS_FILE)
    const secrets: Record<string, string> = fs.existsSync(secretsPath)
        ? JSON.parse(fs.readFileSync(secretsPath, 'utf8') || '{}')
        : {}

    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(secrets)) {
        const plain = isEncryptedValue(value) ? await decryptWithIdentity(value, id) : value
        out[key] = await encryptToRecipients(plain, keys)
    }
    fs.writeFileSync(secretsPath, JSON.stringify(out, null, 2) + '\n')
    writeLock(dir, fingerprint(keys))
}

export async function rekeyCommand(): Promise<void> {
    await rekeyAll()
    console.log('Re-encrypted all secrets to the current keyring and updated keyring.lock.')
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir, generateIdentity, publicKeyFromIdentity } from '@/engine/settings'

export const IDENTITY_FILE = 'age-identity.txt'

// Override path via AGE_IDENTITY_FILE (e.g. tests / non-standard layouts).
export function identityPath(dir: string = configDir()): string {
    const override = process.env.AGE_IDENTITY_FILE
    if (override) return override
    return path.join(dir, IDENTITY_FILE)
}

export function hasIdentity(dir: string = configDir()): boolean {
    return fs.existsSync(identityPath(dir))
}

// Return the secret key string, or null if no identity file exists. Parses the
// first non-comment, non-blank line (standard age identity file format).
export function readIdentity(dir: string = configDir()): string | null {
    const p = identityPath(dir)
    if (!fs.existsSync(p)) return null
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        return line
    }
    return null
}

// Create a new identity file if none exists. Returns its public key and whether
// it was freshly created. Never overwrites an existing identity.
export async function createIdentity(dir: string = configDir()): Promise<{ publicKey: string; created: boolean }> {
    const existing = readIdentity(dir)
    if (existing) {
        return { publicKey: await publicKeyFromIdentity(existing), created: false }
    }
    const secret = await generateIdentity()
    const publicKey = await publicKeyFromIdentity(secret)
    const p = identityPath(dir)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `# public key: ${publicKey}\n${secret}\n`, { mode: 0o600 })
    return { publicKey, created: true }
}

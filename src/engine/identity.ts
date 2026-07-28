import * as fs from 'node:fs'
import * as path from 'node:path'
import { writeIdentityMeta } from '@/engine/access-request'
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
// it was freshly created. Never overwrites an existing identity — but DOES record
// name/branch metadata on a file that lacks it, so a pre-metadata identity gains a
// request record without regenerating the key.
export async function createIdentity(
    dir: string = configDir(),
    meta?: { name: string; branch: string }
): Promise<{ publicKey: string; created: boolean }> {
    const existing = readIdentity(dir)
    if (existing) {
        const publicKey = await publicKeyFromIdentity(existing)
        if (meta) writeIdentityMeta(dir, meta)
        return { publicKey, created: false }
    }
    const secret = await generateIdentity()
    const publicKey = await publicKeyFromIdentity(secret)
    const p = identityPath(dir)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const header = [`# public key: ${publicKey}`]
    if (meta) header.push(`# name: ${meta.name}`, `# branch: ${meta.branch}`)
    fs.writeFileSync(p, `${header.join('\n')}\n${secret}\n`, { mode: 0o600 })
    return { publicKey, created: true }
}

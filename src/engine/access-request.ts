import * as fs from 'node:fs'
import { identityPath, readIdentity } from '@/engine/identity'
import { configDir, publicKeyFromIdentity } from '@/engine/settings'

export function slugForName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
}

export function branchForName(name: string): string {
    return `access/${slugForName(name)}`
}

export interface IdentityMeta {
    publicKey: string
    name?: string
    branch?: string
}

function commentValue(lines: string[], field: string): string | undefined {
    const prefix = `# ${field}:`
    const hit = lines.find(l => l.trim().startsWith(prefix))
    return hit?.trim().slice(prefix.length).trim() || undefined
}

// Read the request record stored alongside the key. `name`/`branch` are absent on
// identity files written before this header existed — callers fall back to
// deriving them from git config rather than treating that as "no request".
export function readIdentityMeta(dir: string = configDir()): IdentityMeta | null {
    const p = identityPath(dir)
    if (!fs.existsSync(p)) return null
    const lines = fs.readFileSync(p, 'utf8').split('\n')
    const publicKey = commentValue(lines, 'public key')
    if (!publicKey) return null
    return {
        publicKey,
        name: commentValue(lines, 'name'),
        branch: commentValue(lines, 'branch'),
    }
}

// Rewrite the comment header, preserving the secret key line verbatim. Used when
// an identity predates the metadata header, or when the branch changes.
//
// The public key is always DERIVED from the secret (never read back from the
// existing header): readIdentityMeta returns null on a headerless file, so
// `existing?.publicKey` would be undefined there and a `?? ''` fallback would
// write a blank `# public key: ` line — which then makes readIdentityMeta keep
// returning null forever, even though the secret still works. Deriving from the
// secret is always correct and never depends on a header that may not exist yet.
export async function writeIdentityMeta(
    dir: string,
    meta: { name: string; branch: string }
): Promise<void> {
    const secret = readIdentity(dir)
    if (!secret) throw new Error('writeIdentityMeta: no identity file to update')
    const publicKey = await publicKeyFromIdentity(secret)
    if (!publicKey) throw new Error('writeIdentityMeta: could not derive a public key')
    const header = [
        `# public key: ${publicKey}`,
        `# name: ${meta.name}`,
        `# branch: ${meta.branch}`,
    ]
    fs.writeFileSync(identityPath(dir), `${header.join('\n')}\n${secret}\n`, { mode: 0o600 })
}

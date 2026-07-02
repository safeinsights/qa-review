import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from '@/engine/settings'

export const KEYRING_FILE = 'keyring.json'
export const LOCK_FILE = 'keyring.lock'

export interface Member {
    name: string
    publicKey: string
    email: string
    addedDate: string
}

function keyringPath(dir: string): string {
    return path.join(dir, KEYRING_FILE)
}
function lockPath(dir: string): string {
    return path.join(dir, LOCK_FILE)
}

export function readKeyring(dir: string = configDir()): Member[] {
    const p = keyringPath(dir)
    if (!fs.existsSync(p)) return []
    const text = fs.readFileSync(p, 'utf8').trim()
    if (!text) return []
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) throw new Error(`${KEYRING_FILE} must contain a JSON array`)
    return parsed as Member[]
}

export function writeKeyring(dir: string = configDir(), members: Member[]): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(keyringPath(dir), `${JSON.stringify(members, null, 2)}\n`)
}

export function recipients(members: Member[]): string[] {
    return members.map(m => m.publicKey)
}

// Add a member, rejecting a duplicate name. Returns a new array (pure).
export function addMember(members: Member[], member: Member): Member[] {
    if (members.some(m => m.name === member.name)) {
        throw new Error(`"${member.name}" is already in the keyring (names must be unique)`)
    }
    return [...members, member]
}

// Stable fingerprint of a recipient set: sha256 of the sorted, newline-joined keys.
export function fingerprint(keys: string[]): string {
    const joined = [...keys].sort().join('\n')
    return createHash('sha256').update(joined).digest('hex')
}

export function readLock(dir: string = configDir()): string | null {
    const p = lockPath(dir)
    if (!fs.existsSync(p)) return null
    return fs.readFileSync(p, 'utf8').trim() || null
}

export function writeLock(dir: string = configDir(), fp: string): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(lockPath(dir), `${fp}\n`)
}

// True when the secrets are NOT known to be encrypted to the current keyring:
// the lock is missing or its fingerprint differs from the keyring's.
export function isInDrift(dir: string = configDir()): boolean {
    const members = readKeyring(dir)
    if (members.length === 0) return false // nothing to encrypt to; not "drift"
    return readLock(dir) !== fingerprint(recipients(members))
}

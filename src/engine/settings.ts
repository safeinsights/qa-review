import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Encrypter, Decrypter, armor } from 'age-encryption'
import { SHARED_ACCOUNTS, ENVIRONMENTS } from '../../config/environments'

// Flat var map the engine consumes (same shape `process.env` had). Keys are the
// committed var names declared in config/environments.ts (ADMIN_EMAIL,
// QA_BASE_URL, MFA_CODE, …); values are the resolved (decrypted) strings.
export type Vars = Record<string, string | undefined>

// --- Settings files (repo-root config/) ---
//
// Three tiers, lowest precedence first:
//   1. settings.json          — committed, plaintext (e.g. base URLs)
//   2. settings.secrets.json  — committed, values are armored age blobs (secrets)
//   3. settings.local.json    — gitignored, plaintext per-user overrides
// process.env wins over all three (so CI can override anything).

export const PROJECT_FILE = 'settings.json'
export const SECRETS_FILE = 'settings.secrets.json'
export const LOCAL_FILE = 'settings.local.json'

// Passphrase used to decrypt the committed secrets file. The GUI passes it to
// the spawned engine; standalone CLI reads it from the environment.
export const PASSPHRASE_VAR = 'AGE_PASSPHRASE'

// An armored age blob starts with this PEM header — used to tell an encrypted
// value apart from a plaintext one.
const AGE_ARMOR_HEADER = '-----BEGIN AGE ENCRYPTED FILE-----'

export function isEncryptedValue(value: string): boolean {
    return value.trimStart().startsWith(AGE_ARMOR_HEADER)
}

// The full set of secret var names (passwords + per-account MFA codes). Non-secret
// vars (emails, base URLs) may live in any tier in plaintext; secret vars must be
// encrypted when committed to the project tier. Derived from config/environments.ts
// so the list can't drift from the declared accounts.
export function secretVarNames(): string[] {
    return Object.values(SHARED_ACCOUNTS).flatMap((a) => [a.passwordVar, a.mfaVar])
}

export function isSecretVar(key: string): boolean {
    return secretVarNames().includes(key)
}

// Every var name the settings system knows about, in a stable display order:
// per-env base URLs, then each account's email + password + MFA code.
export function knownVarNames(): string[] {
    const baseUrls = ENVIRONMENTS.map((e) => e.baseUrlVar)
    const accounts = Object.values(SHARED_ACCOUNTS).flatMap((a) => [a.emailVar, a.passwordVar, a.mfaVar])
    return [...baseUrls, ...accounts]
}

// Resolve the repo-root config/ directory. Anchored to this module's location
// (src/engine/ -> ../../config), NOT process.cwd(), so it works when the GUI
// spawns the engine from an arbitrary working directory.
export function configDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return path.resolve(here, '../../config')
}

function readJsonFile(file: string): Record<string, string> {
    if (!fs.existsSync(file)) return {}
    const text = fs.readFileSync(file, 'utf8').trim()
    if (!text) return {}
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Settings file ${path.basename(file)} must contain a JSON object`)
    }
    // Coerce all values to strings; ignore non-string/non-number values.
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
        else if (typeof v === 'number') out[k] = String(v)
    }
    return out
}

// Decrypt a single armored age value with the scrypt passphrase.
export async function decryptValue(armored: string, passphrase: string): Promise<string> {
    const d = new Decrypter()
    d.addPassphrase(passphrase)
    const binary = armor.decode(armored)
    return d.decrypt(binary, 'text')
}

// Encrypt a single value to an armored age blob with the scrypt passphrase.
// Mirrors the Go encrypt path in the GUI so either side can produce/consume it.
export async function encryptValue(plain: string, passphrase: string): Promise<string> {
    const e = new Encrypter()
    e.setPassphrase(passphrase)
    const binary = await e.encrypt(plain)
    return armor.encode(binary)
}

export interface LoadOptions {
    // Override the config directory (tests). Defaults to configDir().
    dir?: string
    // Base environment to layer on top (defaults to process.env).
    env?: Vars
}

// Build the flat Vars map the engine consumes by merging the three settings
// tiers and the process environment, decrypting any committed secret values.
//
// Precedence (lowest -> highest): settings.json -> settings.secrets.json
// (decrypted) -> settings.local.json -> process.env.
export async function loadSettings(opts: LoadOptions = {}): Promise<Vars> {
    const dir = opts.dir ?? configDir()
    const env = opts.env ?? process.env
    const passphrase = env[PASSPHRASE_VAR]

    const project = readJsonFile(path.join(dir, PROJECT_FILE))
    const secrets = readJsonFile(path.join(dir, SECRETS_FILE))
    const local = readJsonFile(path.join(dir, LOCAL_FILE))

    // Decrypt the secrets tier. A plaintext value in this file is passed through
    // (e.g. a not-yet-encrypted draft); an armored value requires the passphrase.
    const decryptedSecrets: Record<string, string> = {}
    for (const [key, value] of Object.entries(secrets)) {
        if (!isEncryptedValue(value)) {
            decryptedSecrets[key] = value
            continue
        }
        if (!passphrase) {
            throw new Error(`Cannot decrypt ${key}: set ${PASSPHRASE_VAR} to unlock the shared secrets file`)
        }
        try {
            decryptedSecrets[key] = await decryptValue(value, passphrase)
        } catch (e) {
            throw new Error(`Cannot decrypt ${key}: wrong ${PASSPHRASE_VAR}? (${(e as Error).message})`)
        }
    }

    // Later spreads win. process.env last so a real env var overrides any file.
    const merged: Vars = { ...project, ...decryptedSecrets, ...local }
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined && v !== '') merged[k] = v
    }
    return merged
}

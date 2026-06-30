# Multi-User Secrets & Suite Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared age scrypt passphrase with per-user X25519 keys (a committed keyring), add self-service "request access" onboarding, rekey commands, and a startup git-sync that distributes suites + settings together.

**Architecture:** The private repo is the single source of truth, PR-gated. Each user holds a locally-generated age X25519 identity (gitignored); their public key lives in `config/keyring.json`. Each secret in `settings.secrets.json` is encrypted to all keyring recipients. `loadSettings()` decrypts with the local identity, or skips encrypted values when no identity is present (so CI runs keyless on env-var secrets). New CLI subcommands (`request-access`, `rekey`, `set-secret`, `sync`) implement onboarding/rekey/sync; the GUI shells out to them. A `config/keyring.lock` fingerprint drives a drift banner.

**Tech Stack:** TypeScript (engine, `age-encryption` npm), Go (Wails GUI, `filippo.io/age`), vitest, Playwright (unaffected), `gh` CLI + `git`.

---

## File Structure

**New files:**
- `config/keyring.json` — committed recipient list: `[{ name, publicKey, email, addedDate }]`.
- `config/keyring.lock` — committed fingerprint (sha256) of the recipient set the secrets were last encrypted to.
- `config/age-identity.txt` — gitignored local private key (created at runtime, not committed; a `.gitignore` entry is added, the file itself is not).
- `src/engine/keyring.ts` — read/write `keyring.json`, compute recipient fingerprint, read/write `keyring.lock`.
- `src/engine/identity.ts` — locate/read the local age identity file; derive its public key; generate a new identity.
- `src/cli/commands/request-access.ts` — generate identity, add to keyring, branch + PR via `gh`.
- `src/cli/commands/rekey.ts` — re-encrypt all secrets to the current keyring; update `keyring.lock`.
- `src/cli/commands/set-secret.ts` — encrypt one value to all recipients; write one key.
- `src/cli/commands/sync.ts` — fast-forward-only `git pull`; report drift.
- Test files mirror each module under `tests/engine/` and `tests/cli/`.

**Modified files:**
- `src/engine/settings.ts` — X25519 encrypt/decrypt with identities; remove passphrase path; skip-when-no-identity load behavior.
- `bin/otto.ts` — wire the four new subcommands.
- `gui/settings.go` — X25519 encrypt; remove `SetPassphrase`/passphrase; add `Sync()`.
- `gui/cmd/agecrypt/main.go` — X25519 mode for the interop test.
- `tests/engine/age-interop.test.ts` — X25519 round-trip coverage.
- `.gitignore` — add `config/age-identity.txt`.
- `CLAUDE.md` — rewrite the Settings/configuration section.

---

## Task 1: X25519 crypto primitives in settings.ts

Replace the passphrase-based `encryptValue`/`decryptValue` with X25519 identity/recipient versions. This is the foundation; everything else builds on it.

**Files:**
- Modify: `src/engine/settings.ts`
- Test: `tests/engine/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/engine/settings.test.ts`:

```typescript
import { generateIdentity, publicKeyFromIdentity, encryptToRecipients, decryptWithIdentity } from '@/engine/settings'

describe('X25519 crypto primitives', () => {
    it('round-trips a value encrypted to one recipient', async () => {
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        const armored = await encryptToRecipients('hello', [pub])
        expect(armored).toContain('-----BEGIN AGE ENCRYPTED FILE-----')
        expect(await decryptWithIdentity(armored, id)).toBe('hello')
    })

    it('round-trips when encrypted to multiple recipients', async () => {
        const a = await generateIdentity()
        const b = await generateIdentity()
        const armored = await encryptToRecipients('multi', [
            await publicKeyFromIdentity(a),
            await publicKeyFromIdentity(b),
        ])
        expect(await decryptWithIdentity(armored, a)).toBe('multi')
        expect(await decryptWithIdentity(armored, b)).toBe('multi')
    })

    it('a non-recipient identity cannot decrypt', async () => {
        const owner = await generateIdentity()
        const stranger = await generateIdentity()
        const armored = await encryptToRecipients('secret', [await publicKeyFromIdentity(owner)])
        await expect(decryptWithIdentity(armored, stranger)).rejects.toThrow()
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/engine/settings.test.ts`
Expected: FAIL — `generateIdentity is not a function` (not exported yet).

- [ ] **Step 3: Implement the X25519 primitives**

In `src/engine/settings.ts`, the `age-encryption` package exposes `generateIdentity` and `identityToRecipient` at the top level. Add these imports/exports. Replace the passphrase `encryptValue`/`decryptValue` block:

```typescript
import { Encrypter, Decrypter, armor, generateIdentity as ageGenerateIdentity, identityToRecipient } from 'age-encryption'

// Generate a new age X25519 identity (the secret key string, "AGE-SECRET-KEY-1…").
export async function generateIdentity(): Promise<string> {
    return ageGenerateIdentity()
}

// Derive the public recipient ("age1…") from an identity secret key.
export async function publicKeyFromIdentity(identity: string): Promise<string> {
    return identityToRecipient(identity)
}

// Encrypt a value to one or more X25519 recipients ("age1…"). Returns an armored blob.
export async function encryptToRecipients(plain: string, recipients: string[]): Promise<string> {
    if (recipients.length === 0) throw new Error('encryptToRecipients: no recipients (keyring is empty)')
    const e = new Encrypter()
    for (const r of recipients) e.addRecipient(r)
    const binary = await e.encrypt(plain)
    return armor.encode(binary)
}

// Decrypt an armored blob with an X25519 identity secret key.
export async function decryptWithIdentity(armored: string, identity: string): Promise<string> {
    const d = new Decrypter()
    d.addIdentity(identity)
    const binary = armor.decode(armored)
    return d.decrypt(binary, 'text')
}
```

Delete the old `decryptValue`, `encryptValue`, and `PASSPHRASE_VAR` export (the passphrase path is gone). Keep `isEncryptedValue`, `AGE_ARMOR_HEADER`, `readJsonFile`, the file-name constants, and the `secretVarNames`/`knownVarNames`/`configDir` helpers.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/engine/settings.test.ts`
Expected: PASS (the three new tests; any old passphrase tests in this file are removed in Step 5).

- [ ] **Step 5: Remove obsolete passphrase tests**

Delete any test in `tests/engine/settings.test.ts` that calls the removed `encryptValue`/`decryptValue` with a passphrase or references `PASSPHRASE_VAR`. Run `pnpm typecheck` — expect errors anywhere `PASSPHRASE_VAR`/`encryptValue`/`decryptValue` are still imported; those callers are fixed in later tasks (Task 3 for `loadSettings`). For now, only `tests/engine/settings.test.ts` should be clean.

- [ ] **Step 6: Commit**

```bash
git add src/engine/settings.ts tests/engine/settings.test.ts
git commit -m "feat(settings): X25519 encrypt/decrypt primitives, drop passphrase path"
```

---

## Task 2: Identity file module

Read/generate the local age identity at `config/age-identity.txt`.

**Files:**
- Create: `src/engine/identity.ts`
- Test: `tests/engine/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/identity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { identityPath, readIdentity, hasIdentity, createIdentity } from '@/engine/identity'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'))
}

describe('identity file', () => {
    it('reports no identity in an empty dir', () => {
        const dir = tmpDir()
        expect(hasIdentity(dir)).toBe(false)
        expect(readIdentity(dir)).toBeNull()
    })

    it('creates an identity file and reads it back', async () => {
        const dir = tmpDir()
        const { publicKey } = await createIdentity(dir)
        expect(publicKey).toMatch(/^age1/)
        expect(hasIdentity(dir)).toBe(true)
        const id = readIdentity(dir)
        expect(id).toMatch(/^AGE-SECRET-KEY-1/)
        // File path is config/age-identity.txt under the given dir.
        expect(fs.existsSync(identityPath(dir))).toBe(true)
    })

    it('does not overwrite an existing identity', async () => {
        const dir = tmpDir()
        const first = await createIdentity(dir)
        const second = await createIdentity(dir)
        expect(second.publicKey).toBe(first.publicKey)
        expect(second.created).toBe(false)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/engine/identity.test.ts`
Expected: FAIL — cannot resolve `@/engine/identity`.

- [ ] **Step 3: Implement the identity module**

Create `src/engine/identity.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/engine/identity.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/identity.ts tests/engine/identity.test.ts
git commit -m "feat(engine): local age identity file module"
```

---

## Task 3: Keyring module (read/write + fingerprint/lock)

Read/write `config/keyring.json`, compute the recipient fingerprint, and read/write `config/keyring.lock`.

**Files:**
- Create: `src/engine/keyring.ts`
- Test: `tests/engine/keyring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/keyring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    readKeyring, writeKeyring, recipients, addMember,
    fingerprint, readLock, writeLock, isInDrift,
} from '@/engine/keyring'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-'))
}

describe('keyring', () => {
    it('reads an empty keyring from a missing file', () => {
        expect(readKeyring(tmpDir())).toEqual([])
    })

    it('adds a member and lists recipients', () => {
        const dir = tmpDir()
        const next = addMember(readKeyring(dir), { name: 'Jane', publicKey: 'age1jane', email: 'jane@x.com', addedDate: '2026-06-30' })
        writeKeyring(dir, next)
        expect(recipients(readKeyring(dir))).toEqual(['age1jane'])
    })

    it('rejects a duplicate name', () => {
        const k = addMember([], { name: 'Jane', publicKey: 'age1a', email: 'a', addedDate: '2026-06-30' })
        expect(() => addMember(k, { name: 'Jane', publicKey: 'age1b', email: 'b', addedDate: '2026-06-30' })).toThrow(/already in the keyring/)
    })

    it('fingerprint is order-independent and changes with membership', () => {
        const f1 = fingerprint(['age1a', 'age1b'])
        const f2 = fingerprint(['age1b', 'age1a'])
        const f3 = fingerprint(['age1a'])
        expect(f1).toBe(f2)
        expect(f1).not.toBe(f3)
    })

    it('drift is true until the lock matches the keyring', () => {
        const dir = tmpDir()
        writeKeyring(dir, addMember([], { name: 'Jane', publicKey: 'age1a', email: 'a', addedDate: '2026-06-30' }))
        expect(isInDrift(dir)).toBe(true)
        writeLock(dir, fingerprint(recipients(readKeyring(dir))))
        expect(readLock(dir)).toBe(fingerprint(['age1a']))
        expect(isInDrift(dir)).toBe(false)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/engine/keyring.test.ts`
Expected: FAIL — cannot resolve `@/engine/keyring`.

- [ ] **Step 3: Implement the keyring module**

Create `src/engine/keyring.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
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
    fs.writeFileSync(keyringPath(dir), JSON.stringify(members, null, 2) + '\n')
}

export function recipients(members: Member[]): string[] {
    return members.map((m) => m.publicKey)
}

// Add a member, rejecting a duplicate name. Returns a new array (pure).
export function addMember(members: Member[], member: Member): Member[] {
    if (members.some((m) => m.name === member.name)) {
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
    fs.writeFileSync(lockPath(dir), fp + '\n')
}

// True when the secrets are NOT known to be encrypted to the current keyring:
// the lock is missing or its fingerprint differs from the keyring's.
export function isInDrift(dir: string = configDir()): boolean {
    const members = readKeyring(dir)
    if (members.length === 0) return false // nothing to encrypt to; not "drift"
    return readLock(dir) !== fingerprint(recipients(members))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/engine/keyring.test.ts`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/keyring.ts tests/engine/keyring.test.ts
git commit -m "feat(engine): keyring read/write + recipient fingerprint/lock"
```

---

## Task 4: loadSettings — decrypt with identity, skip when absent

Rewrite `loadSettings()` to use the local identity, and to skip encrypted values (not throw) when no identity exists, so CI runs keyless.

**Files:**
- Modify: `src/engine/settings.ts` (the `loadSettings` function + imports)
- Test: `tests/engine/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/engine/settings.test.ts`:

```typescript
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadSettings, encryptToRecipients, generateIdentity, publicKeyFromIdentity } from '@/engine/settings'

function settingsDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'))
}

describe('loadSettings with identities', () => {
    it('decrypts secrets with the identity file in the dir', async () => {
        const dir = settingsDir()
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        fs.writeFileSync(path.join(dir, 'age-identity.txt'), `${id}\n`)
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'),
            JSON.stringify({ ADMIN_PASSWORD: await encryptToRecipients('pw', [pub]) }))
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_PASSWORD).toBe('pw')
    })

    it('skips encrypted secrets (no throw) when no identity is present', async () => {
        const dir = settingsDir()
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'),
            JSON.stringify({ ADMIN_PASSWORD: await encryptToRecipients('pw', [pub]) }))
        // No identity file written. process.env override supplies the value instead.
        const vars = await loadSettings({ dir, env: { ADMIN_PASSWORD: 'from-env' } })
        expect(vars.ADMIN_PASSWORD).toBe('from-env')
    })

    it('passes plaintext secrets through unchanged', async () => {
        const dir = settingsDir()
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'), JSON.stringify({ ADMIN_EMAIL: 'a@x.com' }))
        const vars = await loadSettings({ dir, env: {} })
        expect(vars.ADMIN_EMAIL).toBe('a@x.com')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/engine/settings.test.ts`
Expected: FAIL — the second test currently throws `Cannot decrypt ADMIN_PASSWORD` instead of skipping.

- [ ] **Step 3: Rewrite loadSettings**

In `src/engine/settings.ts`, add an import for the identity reader and the new `LoadOptions` field, then replace the secrets-decryption block. Import at top:

```typescript
import { readIdentity } from '@/engine/identity'
```

Replace the `LoadOptions` interface and the secrets loop inside `loadSettings`:

```typescript
export interface LoadOptions {
    dir?: string
    env?: Vars
    // Override the identity secret key (tests / CI). Defaults to reading the
    // identity file under `dir`.
    identity?: string | null
}

export async function loadSettings(opts: LoadOptions = {}): Promise<Vars> {
    const dir = opts.dir ?? configDir()
    const env = opts.env ?? process.env
    const identity = opts.identity !== undefined ? opts.identity : readIdentity(dir)

    const project = readJsonFile(path.join(dir, PROJECT_FILE))
    const secrets = readJsonFile(path.join(dir, SECRETS_FILE))
    const local = readJsonFile(path.join(dir, LOCAL_FILE))

    // Decrypt the secrets tier. Plaintext values pass through. Encrypted values
    // need the local identity; with NO identity we SKIP them (leave unset) so CI
    // can run keyless on env-var secrets. A genuinely missing required secret is
    // caught later by env.ts read().
    const decryptedSecrets: Record<string, string> = {}
    for (const [key, value] of Object.entries(secrets)) {
        if (!isEncryptedValue(value)) {
            decryptedSecrets[key] = value
            continue
        }
        if (!identity) continue
        try {
            decryptedSecrets[key] = await decryptWithIdentity(value, identity)
        } catch (e) {
            throw new Error(`Cannot decrypt ${key}: your key may not be a recipient yet — ask a teammate to rekey (${(e as Error).message})`)
        }
    }

    const merged: Vars = { ...project, ...decryptedSecrets, ...local }
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined && v !== '') merged[k] = v
    }
    return merged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/engine/settings.test.ts`
Expected: PASS (all settings tests, including the three new ones).

- [ ] **Step 5: Verify the whole engine still typechecks**

Run: `pnpm typecheck`
Expected: No errors referencing `PASSPHRASE_VAR`, `encryptValue`, or `decryptValue` in `src/`. If the GUI-spawn code or any command still imports them, note it — those are addressed in Tasks 7 (Go) and the CLI tasks. Within `src/` there should be no remaining references.

- [ ] **Step 6: Commit**

```bash
git add src/engine/settings.ts tests/engine/settings.test.ts
git commit -m "feat(settings): decrypt with local identity, skip encrypted values when keyless"
```

---

## Task 5: `otto rekey` and `otto set-secret` commands

Re-encrypt all secrets to the current keyring (and update the lock); encrypt one edited value.

**Files:**
- Create: `src/cli/commands/rekey.ts`
- Create: `src/cli/commands/set-secret.ts`
- Modify: `bin/otto.ts`
- Test: `tests/cli/rekey.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/rekey.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { rekeyAll } from '@/cli/commands/rekey'
import { setSecret } from '@/cli/commands/set-secret'
import { generateIdentity, publicKeyFromIdentity, encryptToRecipients, decryptWithIdentity } from '@/engine/settings'
import { writeKeyring, addMember, readLock, fingerprint } from '@/engine/keyring'
import { createIdentity, readIdentity } from '@/engine/identity'

function dirWith(members: { name: string; publicKey: string }[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-'))
    let k: any[] = []
    for (const m of members) k = addMember(k, { ...m, email: 'x', addedDate: '2026-06-30' })
    writeKeyring(dir, k)
    return dir
}

describe('rekey', () => {
    it('re-encrypts a secret so a newly-added recipient can read it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-'))
        const alice = await createIdentity(dir) // alice's identity is the local one
        const aliceId = readIdentity(dir)!
        writeKeyring(dir, addMember([], { name: 'Alice', publicKey: alice.publicKey, email: 'a', addedDate: '2026-06-30' }))
        // Encrypt a secret to Alice only.
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'),
            JSON.stringify({ ADMIN_PASSWORD: await encryptToRecipients('pw', [alice.publicKey]) }))

        // Bob joins the keyring.
        const bobId = await generateIdentity()
        const bobPub = await publicKeyFromIdentity(bobId)
        const k = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        k.push({ name: 'Bob', publicKey: bobPub, email: 'b', addedDate: '2026-06-30' })
        fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify(k))

        await rekeyAll(dir, aliceId)

        const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'settings.secrets.json'), 'utf8'))
        expect(await decryptWithIdentity(secrets.ADMIN_PASSWORD, bobId)).toBe('pw')
        // Lock now matches the keyring.
        expect(readLock(dir)).toBe(fingerprint([alice.publicKey, bobPub]))
    })

    it('set-secret encrypts one value to all recipients and updates the lock', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setsec-'))
        const a = await generateIdentity(); const aPub = await publicKeyFromIdentity(a)
        writeKeyring(dir, addMember([], { name: 'A', publicKey: aPub, email: 'a', addedDate: '2026-06-30' }))
        await setSecret(dir, 'RESEARCHER_PASSWORD', 'hunter2')
        const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'settings.secrets.json'), 'utf8'))
        expect(await decryptWithIdentity(secrets.RESEARCHER_PASSWORD, a)).toBe('hunter2')
        expect(readLock(dir)).toBe(fingerprint([aPub]))
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/cli/rekey.test.ts`
Expected: FAIL — cannot resolve `@/cli/commands/rekey`.

- [ ] **Step 3: Implement rekey.ts**

Create `src/cli/commands/rekey.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir, SECRETS_FILE, isEncryptedValue, decryptWithIdentity, encryptToRecipients } from '@/engine/settings'
import { readIdentity } from '@/engine/identity'
import { readKeyring, recipients, fingerprint, writeLock } from '@/engine/keyring'

// Re-encrypt every secret in settings.secrets.json to the CURRENT keyring, then
// update keyring.lock. `identity` must be able to decrypt the existing secrets.
export async function rekeyAll(dir: string = configDir(), identity?: string): Promise<void> {
    const id = identity ?? readIdentity(dir)
    if (!id) throw new Error('rekey: no local identity — run `otto request-access` first')
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
```

- [ ] **Step 4: Implement set-secret.ts**

Create `src/cli/commands/set-secret.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir, SECRETS_FILE, encryptToRecipients } from '@/engine/settings'
import { readKeyring, recipients, fingerprint, writeLock } from '@/engine/keyring'

// Encrypt ONE plaintext value to all current recipients, writing just that key
// into settings.secrets.json. Updates the lock (the recipient set is unchanged,
// but writing it keeps the file authoritative).
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- tests/cli/rekey.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Wire the subcommands into bin/otto.ts**

In `bin/otto.ts`, add imports and cases:

```typescript
import { rekeyCommand } from '@/cli/commands/rekey'
import { setSecretCommand } from '@/cli/commands/set-secret'
```

Add to the `switch`:

```typescript
        case 'rekey':
            return rekeyCommand()
        case 'set-secret':
            return setSecretCommand(opts)
```

Update the `default` error string to list the new commands: `run | login | cleanup | codegen | list | migrate | request-access | rekey | set-secret | sync`.

- [ ] **Step 7: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS (the `request-access`/`sync` cases are added in Tasks 6 and 8; if you add the default-string mention now, that's fine — it's just a string).

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/rekey.ts src/cli/commands/set-secret.ts bin/otto.ts tests/cli/rekey.test.ts
git commit -m "feat(cli): rekey + set-secret commands"
```

---

## Task 6: `otto request-access` command

Generate the local identity, add the public key to the keyring, branch, and open a PR via `gh`. The git/`gh` side effects are injected so the core is unit-testable.

**Files:**
- Create: `src/cli/commands/request-access.ts`
- Modify: `bin/otto.ts`
- Test: `tests/cli/request-access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/request-access.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { requestAccess } from '@/cli/commands/request-access'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'reqaccess-'))
}

describe('request-access', () => {
    it('creates an identity and adds the member to the keyring', async () => {
        const dir = tmpDir()
        const calls: string[][] = []
        const result = await requestAccess({
            dir, name: 'Jane Smith', email: 'jane@x.com', date: '2026-06-30',
            git: async (args) => { calls.push(args); return '' },
        })
        const keyring = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        expect(keyring).toHaveLength(1)
        expect(keyring[0]).toMatchObject({ name: 'Jane Smith', email: 'jane@x.com', addedDate: '2026-06-30' })
        expect(keyring[0].publicKey).toMatch(/^age1/)
        expect(result.created).toBe(true)
        // It ran a branch + push (git injected).
        expect(calls.some((c) => c[0] === 'checkout')).toBe(true)
    })

    it('rejects a duplicate name', async () => {
        const dir = tmpDir()
        const git = async () => ''
        await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        await expect(requestAccess({ dir, name: 'Jane', email: 'b@x.com', date: '2026-06-30', git }))
            .rejects.toThrow(/already in the keyring/)
    })

    it('reuses an existing identity instead of generating a new one', async () => {
        const dir = tmpDir()
        const git = async () => ''
        const first = await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        // Wipe the keyring but keep the identity file, then re-request under a new name.
        fs.rmSync(path.join(dir, 'keyring.json'))
        const second = await requestAccess({ dir, name: 'Jane2', email: 'a@x.com', date: '2026-06-30', git })
        expect(second.publicKey).toBe(first.publicKey)
        expect(second.created).toBe(false)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/cli/request-access.test.ts`
Expected: FAIL — cannot resolve `@/cli/commands/request-access`.

- [ ] **Step 3: Implement request-access.ts**

Create `src/cli/commands/request-access.ts`:

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configDir } from '@/engine/settings'
import { createIdentity } from '@/engine/identity'
import { readKeyring, addMember, writeKeyring } from '@/engine/keyring'

const execFileAsync = promisify(execFile)

// A slug for the access branch name, e.g. "Jane Smith" -> "jane-smith".
function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// Injectable git runner so the core is unit-testable. Default shells out to git.
export type GitRunner = (args: string[]) => Promise<string>

const realGit: GitRunner = async (args) => (await execFileAsync('git', args, { cwd: process.cwd() })).stdout

export interface RequestAccessOptions {
    dir: string
    name: string
    email: string
    date: string
    git?: GitRunner
}

// Core: create-or-reuse identity, add to keyring, branch + commit + push the
// keyring change. Returns the public key and whether the identity was created.
export async function requestAccess(opts: RequestAccessOptions): Promise<{ publicKey: string; created: boolean; branch: string }> {
    const git = opts.git ?? realGit
    const { publicKey, created } = await createIdentity(opts.dir)

    const next = addMember(readKeyring(opts.dir), {
        name: opts.name, publicKey, email: opts.email, addedDate: opts.date,
    })
    writeKeyring(opts.dir, next)

    const branch = `access/${slug(opts.name)}`
    await git(['checkout', '-b', branch])
    await git(['add', 'config/keyring.json'])
    await git(['commit', '-m', `Add ${opts.name} to keyring`])
    await git(['push', '-u', 'origin', branch])
    return { publicKey, created, branch }
}

// CLI wrapper: resolves name/email/date, runs requestAccess, then opens a PR via
// `gh` (falling back to printed instructions if gh is unavailable).
export async function requestAccessCommand(opts: Record<string, string>): Promise<void> {
    const name = opts.name
    if (!name) throw new Error('request-access: --name "Your Name" is required')
    const email = opts.email ?? (await safeGitConfigEmail())
    const date = new Date().toISOString().slice(0, 10)
    const { branch, created } = await requestAccess({ dir: configDir(), name, email, date })
    console.log(`${created ? 'Generated a new identity. ' : 'Reused existing identity. '}Pushed ${branch}.`)

    try {
        await execFileAsync('gh', ['pr', 'create', '--fill', '--title', `Add ${name} to keyring`,
            '--body', 'Reviewer: run "Approve & rekey" (otto rekey on this branch) before merging.'])
        console.log('Opened a pull request. A teammate will approve + rekey, then merge.')
    } catch {
        console.log('Could not open a PR automatically (is `gh` installed and authed?).')
        console.log(`Open it manually: push branch "${branch}" and create a PR titled "Add ${name} to keyring".`)
    }
}

async function safeGitConfigEmail(): Promise<string> {
    try {
        return (await execFileAsync('git', ['config', 'user.email'])).stdout.trim()
    } catch {
        return ''
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/cli/request-access.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Wire into bin/otto.ts**

Add import and case:

```typescript
import { requestAccessCommand } from '@/cli/commands/request-access'
```
```typescript
        case 'request-access':
            return requestAccessCommand(opts)
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/request-access.ts bin/otto.ts tests/cli/request-access.test.ts
git commit -m "feat(cli): request-access — generate identity, add to keyring, open PR"
```

---

## Task 7: `otto sync` command

Fast-forward-only `git pull`; report whether it synced, was skipped (dirty/diverged), and whether secrets are now in keyring drift.

**Files:**
- Create: `src/cli/commands/sync.ts`
- Modify: `bin/otto.ts`
- Test: `tests/cli/sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/sync.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { syncRepo } from '@/cli/commands/sync'

// A fake git runner driven by a scripted map of "args.join(' ')" -> stdout, or a
// thrown error to simulate a non-clean / non-ff state.
function fakeGit(script: Record<string, string | Error>) {
    return async (args: string[]) => {
        const key = args.join(' ')
        const v = script[key]
        if (v instanceof Error) throw v
        if (v === undefined) return ''
        return v
    }
}

describe('sync', () => {
    it('reports synced on a clean fast-forward', async () => {
        const git = fakeGit({ 'status --porcelain': '', 'pull --ff-only': 'Updating abc..def\n' })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('synced')
    })

    it('skips when the working copy is dirty', async () => {
        const git = fakeGit({ 'status --porcelain': ' M src/foo.ts\n' })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('skipped-dirty')
    })

    it('skips when pull cannot fast-forward', async () => {
        const git = fakeGit({ 'status --porcelain': '', 'pull --ff-only': new Error('Not possible to fast-forward') })
        const r = await syncRepo('/repo', git)
        expect(r.status).toBe('skipped-diverged')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/cli/sync.test.ts`
Expected: FAIL — cannot resolve `@/cli/commands/sync`.

- [ ] **Step 3: Implement sync.ts**

Create `src/cli/commands/sync.ts`:

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configDir } from '@/engine/settings'
import { isInDrift } from '@/engine/keyring'
import type { GitRunner } from '@/cli/commands/request-access'

const execFileAsync = promisify(execFile)

export type SyncStatus = 'synced' | 'skipped-dirty' | 'skipped-diverged'
export interface SyncResult {
    status: SyncStatus
    drift: boolean
}

function gitIn(cwd: string): GitRunner {
    return async (args) => (await execFileAsync('git', args, { cwd })).stdout
}

// Fast-forward-only pull. Skips (never resets) when the working copy is dirty or
// the pull can't fast-forward. After a successful pull, reports keyring drift.
export async function syncRepo(repoDir: string, git: GitRunner): Promise<SyncResult> {
    const dirty = (await git(['status', '--porcelain'])).trim() !== ''
    if (dirty) return { status: 'skipped-dirty', drift: false }
    try {
        await git(['pull', '--ff-only'])
    } catch {
        return { status: 'skipped-diverged', drift: false }
    }
    return { status: 'synced', drift: isInDrift(configDir()) }
}

export async function syncCommand(): Promise<void> {
    const repoDir = process.cwd()
    const r = await syncRepo(repoDir, gitIn(repoDir))
    switch (r.status) {
        case 'synced':
            console.log('Synced (fast-forward).' + (r.drift ? ' Secrets are out of sync with the keyring — run `otto rekey`.' : ''))
            break
        case 'skipped-dirty':
            console.log('Skipped sync — you have local changes. Commit/stash them, or discard uncommitted edits and retry.')
            break
        case 'skipped-diverged':
            console.log('Skipped sync — your branch has diverged (unpushed commits). Push or open a PR, then retry.')
            break
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/cli/sync.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Wire into bin/otto.ts**

```typescript
import { syncCommand } from '@/cli/commands/sync'
```
```typescript
        case 'sync':
            return syncCommand()
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/sync.ts bin/otto.ts tests/cli/sync.test.ts
git commit -m "feat(cli): sync — fast-forward-only pull + drift report"
```

---

## Task 8: Go side — X25519 in settings.go + agecrypt + Sync()

Switch the GUI encryption to X25519, remove the passphrase machinery, add `Sync()`, and update the agecrypt helper so interop tests pass.

**Files:**
- Modify: `gui/settings.go`
- Modify: `gui/app.go` (remove `passphrase` field + its uses; add `Sync`)
- Modify: `gui/cmd/agecrypt/main.go`
- Test: `gui/settings_test.go` (Go), `tests/engine/age-interop.test.ts` (TS)

- [ ] **Step 1: Update agecrypt to X25519 (write the interop test first)**

Rewrite `tests/engine/age-interop.test.ts` so Go and TS cross X25519 instead of a passphrase. The helper now takes a recipient (encrypt) or an identity (decrypt) on argv:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encryptToRecipients, decryptWithIdentity, generateIdentity, publicKeyFromIdentity } from '@/engine/settings'

const here = path.dirname(fileURLToPath(import.meta.url))
const guiDir = path.resolve(here, '../../gui')

let bin: string
let goAvailable = true

beforeAll(() => {
    bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agecrypt-')), 'agecrypt')
    try {
        execFileSync('go', ['build', '-o', bin, './cmd/agecrypt'], { cwd: guiDir, stdio: 'pipe' })
    } catch {
        goAvailable = false
    }
}, 60_000)

describe('age X25519 cross-language interop', () => {
    it('TS decrypts a Go-encrypted value', async () => {
        if (!goAvailable) return
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        const armored = execFileSync(bin, ['encrypt', pub], { input: 'hello-from-go' }).toString()
        expect(await decryptWithIdentity(armored, id)).toBe('hello-from-go')
    })

    it('Go decrypts a TS-encrypted value', async () => {
        if (!goAvailable) return
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        const armored = await encryptToRecipients('hello-from-ts', [pub])
        const out = execFileSync(bin, ['decrypt', id], { input: armored }).toString()
        expect(out).toBe('hello-from-ts')
    })
})
```

- [ ] **Step 2: Run interop test to verify it fails**

Run: `pnpm test -- tests/engine/age-interop.test.ts`
Expected: FAIL — `agecrypt` still uses scrypt; `encrypt age1...` is treated as a passphrase and TS decrypt fails (or Go errors parsing the recipient).

- [ ] **Step 3: Rewrite agecrypt main.go for X25519**

Replace the body of `gui/cmd/agecrypt/main.go`'s `switch`:

```go
	switch mode {
	case "encrypt":
		// arg is an age1... recipient public key.
		r, err := age.ParseX25519Recipient(arg)
		if err != nil {
			fail(err)
		}
		buf := &bytes.Buffer{}
		aw := armor.NewWriter(buf)
		w, err := age.Encrypt(aw, r)
		if err != nil {
			fail(err)
		}
		if _, err := w.Write(in); err != nil {
			fail(err)
		}
		if err := w.Close(); err != nil {
			fail(err)
		}
		if err := aw.Close(); err != nil {
			fail(err)
		}
		os.Stdout.Write(buf.Bytes())
	case "decrypt":
		// arg is an AGE-SECRET-KEY-1... identity.
		id, err := age.ParseX25519Identity(arg)
		if err != nil {
			fail(err)
		}
		r, err := age.Decrypt(armor.NewReader(strings.NewReader(string(in))), id)
		if err != nil {
			fail(err)
		}
		if _, err := io.Copy(os.Stdout, r); err != nil {
			fail(err)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown mode %q\n", mode)
		os.Exit(2)
	}
```

Rename the `pass` variable to `arg` (it's a recipient or identity now), and update the usage string to `usage: agecrypt <encrypt|decrypt> <recipient-or-identity>`.

- [ ] **Step 4: Run interop test to verify it passes**

Run: `pnpm test -- tests/engine/age-interop.test.ts`
Expected: PASS (both directions), or both `return` early if Go isn't installed.

- [ ] **Step 5: Update settings.go — encrypt to recipients, drop passphrase**

In `gui/settings.go`:
- Replace `encryptString(plaintext, passphrase string)` with `encryptToRecipients(plaintext string, recipients []string)` using `age.ParseX25519Recipient` for each key and `age.Encrypt(aw, recipients...)`.
- Read the keyring (`config/keyring.json`) to get the recipients inside `WriteSetting` for a secret field, instead of using `a.passphrase`. Add a small `readKeyringRecipients(dir string) ([]string, error)` helper that unmarshals the array of `{publicKey}` and returns the keys.
- Remove the `a.passphrase == ""` guard; replace with "keyring is empty" guard.
- After writing a secret, update `config/keyring.lock` (sha256 of sorted recipients) so it stays consistent with the TS `set-secret`. Add a `writeLock` helper mirroring the TS fingerprint (sorted, newline-joined, sha256 hex).

```go
// encryptToRecipients encrypts to one or more age X25519 recipients (age1...).
func encryptToRecipients(plaintext string, recipientKeys []string) (string, error) {
	if len(recipientKeys) == 0 {
		return "", fmt.Errorf("keyring is empty — add a recipient before saving a secret")
	}
	recs := make([]age.Recipient, 0, len(recipientKeys))
	for _, k := range recipientKeys {
		r, err := age.ParseX25519Recipient(k)
		if err != nil {
			return "", err
		}
		recs = append(recs, r)
	}
	buf := &bytes.Buffer{}
	aw := armor.NewWriter(buf)
	w, err := age.Encrypt(aw, recs...)
	if err != nil {
		return "", err
	}
	if _, err := io.WriteString(w, plaintext); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	if err := aw.Close(); err != nil {
		return "", err
	}
	return buf.String(), nil
}
```

In `WriteSetting`, the `targetFile == secretsFile` branch becomes:

```go
	stored := value
	if targetFile == secretsFile {
		recipients, err := readKeyringRecipients(dir)
		if err != nil {
			return err
		}
		enc, err := encryptToRecipients(value, recipients)
		if err != nil {
			return err
		}
		stored = enc
	}
```

After the read-modify-write of the target file, if it was the secrets file, write the lock:

```go
	if targetFile == secretsFile {
		recipients, _ := readKeyringRecipients(dir)
		if err := writeLock(dir, recipients); err != nil {
			return err
		}
	}
```

Add the helpers (recipient reader + lock writer):

```go
func readKeyringRecipients(dir string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(dir, "keyring.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var members []struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(data, &members); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(members))
	for _, m := range members {
		keys = append(keys, m.PublicKey)
	}
	return keys, nil
}

func writeLock(dir string, recipients []string) error {
	sorted := append([]string(nil), recipients...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return os.WriteFile(filepath.Join(dir, "keyring.lock"), []byte(hex.EncodeToString(sum[:])+"\n"), 0o644)
}
```

Add imports: `"crypto/sha256"`, `"encoding/hex"`, `"sort"`. Remove `"filippo.io/age/armor"` only if no longer used (it is still used by `encryptToRecipients`), keep it.

- [ ] **Step 6: Remove the passphrase field and its uses in app.go**

In `gui/app.go`: delete the `passphrase string` field from `App`, delete the `SetPassphrase` method (it's in settings.go — delete it there), and remove the line in `RunProcess` that injects the passphrase into the child env (`AGE_PASSPHRASE=...`). The engine now reads the identity file directly, so no env injection is needed. In `ReadSettings`/`SettingsView`, replace `HasPassphrase: a.passphrase != ""` with `HasIdentity` computed from whether `config/age-identity.txt` exists (`a.HasIdentity(cwd)` or inline `os.Stat`).

- [ ] **Step 7: Add Sync() to app.go**

Add a `Sync(cwd string) (string, error)` method that runs `git status --porcelain` then `git pull --ff-only` in `resolveCwd(cwd)` via `exec.Command` with `withGuiPath()`, returning one of `"synced"`, `"skipped-dirty"`, `"skipped-diverged"` (mirror the TS `syncRepo` logic). The React UI calls this on startup.

```go
func (a *App) Sync(cwd string) (string, error) {
	dir := resolveCwd(cwd)
	status, err := a.git(dir, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(status) != "" {
		return "skipped-dirty", nil
	}
	if _, err := a.git(dir, "pull", "--ff-only"); err != nil {
		return "skipped-diverged", nil
	}
	return "synced", nil
}

func (a *App) git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = withGuiPath()
	out, err := cmd.CombinedOutput()
	return string(out), err
}
```

- [ ] **Step 8: Update Go tests**

In `gui/settings_test.go` (and `gui/app_test.go` if it references `passphrase`/`SetPassphrase`): replace passphrase-based encryption tests with a keyring round-trip — write a `config/keyring.json` with one generated recipient, call `WriteSetting` for a secret, assert the stored value is an armored blob and decrypts with the matching identity (`age.ParseX25519Identity`). Remove any `SetPassphrase`/`HasPassphrase` assertions; assert `HasIdentity` instead.

- [ ] **Step 9: Run Go tests + build**

Run: `cd gui && go test ./... && go build ./...`
Expected: PASS / clean build. (If the Go toolchain isn't available in this environment, note it and rely on the TS interop test; otherwise it must pass.)

- [ ] **Step 10: Commit**

```bash
git add gui/settings.go gui/app.go gui/cmd/agecrypt/main.go gui/settings_test.go gui/app_test.go tests/engine/age-interop.test.ts
git commit -m "feat(gui): X25519 keyring encryption, drop passphrase, add Sync()"
```

---

## Task 9: GUI React — request-access button, sync banner, drift/rekey banner

Wire the Go methods into the UI: a Request-access button when no identity, a sync-on-startup banner with "Reset to clean & sync", and a keyring-drift "Rekey" banner.

**Files:**
- Modify: `gui/frontend/src/components/SuitesTab.tsx` or the settings/header component (follow the existing component layout)
- Modify: `gui/frontend/src/lib/ipc.ts` (add typed wrappers for the new Go methods)
- Test: existing `tests/gui/*.test.ts` patterns; add a small UI/logic test if the component has testable logic extracted

- [ ] **Step 1: Add IPC wrappers**

In `gui/frontend/src/lib/ipc.ts`, add typed wrappers calling the generated Wails bindings for `Sync(cwd)`, `RequestAccess(name)` (a new Go method that shells to `otto request-access`), `Rekey()` (shells to `otto rekey`), and `ResetAndSync(cwd)` (runs `git restore .` then `Sync`). Follow the existing wrapper style in that file.

- [ ] **Step 2: Add the Go RequestAccess/Rekey/ResetAndSync methods**

In `gui/app.go`, add methods that shell out to the CLI (reusing `RunProcess`-style spawning or a synchronous `exec.Command` with `withGuiPath()`):
- `RequestAccess(cwd, name string) (string, error)` → `pnpm otto request-access --name <name>`
- `Rekey(cwd string) (string, error)` → `pnpm otto rekey`
- `ResetAndSync(cwd string) (string, error)` → `git restore .` then `a.Sync(cwd)` (discards only uncommitted tracked edits, preserves local commits).

Run `cd gui && go build ./...` to confirm and regenerate bindings (`wails dev`/`wails generate module`).

- [ ] **Step 3: Render the banners**

In the main app shell (where suites/settings render):
- If `HasIdentity` is false → show a prominent **"Request access"** button that prompts for a name and calls `RequestAccess`, then shows "PR opened — waiting for a teammate to approve & rekey".
- On mount, call `Sync(cwd)`. On `"skipped-dirty"`/`"skipped-diverged"` show a non-blocking banner with a **"Reset to clean & sync"** button (calls `ResetAndSync`, with a confirm dialog noting it discards uncommitted edits but keeps local commits).
- After a successful sync, if the keyring is in drift (expose a Go `IsInDrift(cwd) bool` that mirrors `src/engine/keyring.ts`, or read the result of a `otto`-side check), show a **"Secrets out of sync — Rekey"** banner. The button calls `Rekey` if the user can decrypt; otherwise shows "waiting for a teammate to rekey".

- [ ] **Step 4: Manual verification in the browser**

Follow CLAUDE.md "Running the GUI app in a browser": `cd gui && nohup wails dev > "$TMPDIR/wails-dev.log" 2>&1 &`, wait for `:34115`, open it, and verify: (a) with no `config/age-identity.txt`, the Request-access button shows; (b) the sync banner appears when the working copy is dirty. Screenshot each.

- [ ] **Step 5: Commit**

```bash
git add gui/frontend/src gui/app.go
git commit -m "feat(gui): request-access button, sync banner + reset, rekey/drift banner"
```

---

## Task 10: gitignore, full suite, and CLAUDE.md docs

Final wiring: ignore the identity file, run everything, and update the project docs.

**Files:**
- Modify: `.gitignore`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Gitignore the identity file**

Add to `.gitignore`:

```
config/age-identity.txt
```

- [ ] **Step 2: Run the full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: ALL PASS. Fix any remaining reference to the removed passphrase API (`PASSPHRASE_VAR`, `encryptValue`, `decryptValue`, `SetPassphrase`). If `cd gui && go test ./...` is runnable, it must also pass.

- [ ] **Step 3: Rewrite the CLAUDE.md Settings section**

In `CLAUDE.md`, replace the "Settings / configuration" and the relevant "Debugging" bullets to describe the new model:
- Secrets in `settings.secrets.json` are age-encrypted to the **keyring** (`config/keyring.json`), not a passphrase.
- Each user has a local identity at `config/age-identity.txt` (gitignored), created by **"Request access"** / `otto request-access`.
- Unlock is the identity file, not `AGE_PASSPHRASE`. Remove the `AGE_PASSPHRASE` decrypt-failure modes; add the new one: `Cannot decrypt <VAR>: your key may not be a recipient yet — ask a teammate to rekey`.
- **CI is keyless**: secrets come from env-var Actions secrets that override the file tiers.
- New commands: `otto request-access`, `otto rekey`, `otto set-secret`, `otto sync`.
- Startup `git pull --ff-only` distributes suites + keyring + secrets; "Reset to clean & sync" discards only uncommitted edits.
- Note revocation is manual: remove from keyring, `otto rekey`, and rotate the actual secret if sensitive.

- [ ] **Step 4: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "chore: gitignore identity, document multi-user keyring model"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** §1 crypto → Tasks 1, 8. §2 identity/keyless → Tasks 2, 4. §3 rekey/lock/drift → Tasks 3, 5, (banner) 9. §4 request-access → Task 6, (button) 9. §5 sync → Tasks 7, 8 (`Sync`), 9 (banner). Revocation doc → Task 10. No migration / no CI key — honored (no tasks add them).
- **Type consistency:** `encryptToRecipients(plain, recipients[])`, `decryptWithIdentity(armored, identity)`, `generateIdentity()`, `publicKeyFromIdentity(identity)` are used identically across Tasks 1, 4, 5, 6, 8. Keyring `Member` shape `{name, publicKey, email, addedDate}` is identical in TS (Task 3) and Go (`readKeyringRecipients`, Task 8). `fingerprint` = sha256(sorted, "\n"-joined) in both TS (Task 3) and Go (`writeLock`, Task 8) — must match exactly for drift detection to work cross-language.
- **`age-encryption` API check:** Tasks 1/8 assume `generateIdentity`, `identityToRecipient`, `Encrypter.addRecipient`, `Decrypter.addIdentity` exist in `age-encryption@0.3.0`. If a name differs, adjust at Task 1 (the foundation) and the rest follows.

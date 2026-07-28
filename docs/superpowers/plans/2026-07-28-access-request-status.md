# Access Request Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fire-once "Request access" action with a status display keyed on the local age public key, so a user can never be pushed into filing a duplicate keyring PR.

**Architecture:** The local age keypair (`config/age-identity.txt`, gitignored, never overwritten) becomes the durable record of a request — its comment header gains `# name:` and `# branch:` lines. A new engine subcommand `qar access-status --json` resolves one of seven states from that key plus the upstream keyring, the remote branch, and `gh pr list`. The Go GUI shells that subcommand and renders per-state UI instead of a name input. The three mutating operations (`addMember`, branch creation, `gh pr create`) become idempotent so a repeat is a no-op rather than an error.

**Tech Stack:** TypeScript (engine, run under tsx), vitest, Go (Wails GUI), React + Mantine (frontend), Biome (lint/format), `age-encryption` npm, `gh` CLI.

## Global Constraints

- Formatting and linting are enforced by **Biome**: 4-space indent, single quotes, no semicolons, 100-column. Never hand-format — run `pnpm lint:fix`. `pnpm lint` is the CI gate.
- Engine code under `src/` uses the `@/` alias. **Suites** (`src/suites/*.ts`) must use RELATIVE imports — no task here touches suites, so the alias is fine throughout.
- Comments explain "why", not "what". No trivial comments.
- Stop if `pnpm test`, `pnpm typecheck`, or `pnpm lint` fail — fix before proceeding.
- Never mock our own modules or the real data path. Tests assert on real outputs; external commands (`git`, `gh`) are injected as runner functions, not mocked via module interception.
- Existing identity files have NO `# name:` / `# branch:` lines. Every reader must tolerate their absence — this is the author's own machine and must not break.
- A GitHub/network failure must NEVER downgrade the reported state to `no-identity` when an identity exists. That downgrade is the bug this whole plan exists to prevent.

---

## File Structure

**Create:**
- `src/engine/access-request.ts` — identity metadata read/write (`# name:`, `# branch:`), slug derivation.
- `src/cli/commands/access-status.ts` — state resolution + the `access-status` subcommand.
- `src/cli/commands/open-access-pr.ts` — create-or-report the PR for an existing branch.
- `tests/engine/access-request.test.ts`
- `tests/cli/access-status.test.ts`
- `tests/cli/open-access-pr.test.ts`
- `gui/frontend/src/components/AccessRequestStatus.tsx` — the per-state UI.

**Modify:**
- `src/engine/identity.ts` — `createIdentity` writes the metadata header.
- `src/engine/keyring.ts:43-48` — `addMember` tolerates an identical re-add.
- `src/cli/commands/request-access.ts` — split into `requestAccess` + PR opening; reuse an existing branch.
- `bin/qar.ts:61-105` — dispatch `access-status` and `open-access-pr`.
- `src/cli/help.ts` — help entries for both new subcommands.
- `gui/app.go:1166-1212` — `KeyringAccess` gains the new fields; `CheckKeyringAccess` folds in the engine JSON; add `OpenAccessPr`.
- `gui/frontend/src/lib/ipc.ts` — `KeyringAccess` type + `openAccessPr` binding.
- `gui/frontend/src/components/KeyringAccessGate.tsx` — render `AccessRequestStatus`, drop the name input.
- `gui/frontend/src/components/RequestAccessButton.tsx` — collapse onto the same component.
- `tests/cli/request-access.test.ts` — update the duplicate-name expectation.
- `CLAUDE.md` — document the new subcommands and the states.

---

### Task 1: Identity metadata (`# name:` / `# branch:`)

**Files:**
- Create: `src/engine/access-request.ts`
- Create: `tests/engine/access-request.test.ts`
- Modify: `src/engine/identity.ts:33-46`

**Interfaces:**
- Consumes: `identityPath(dir)`, `readIdentity(dir)` from `@/engine/identity`; `publicKeyFromIdentity`, `generateIdentity` from `@/engine/settings`.
- Produces:
  - `slugForName(name: string): string`
  - `branchForName(name: string): string` — `access/<slug>`
  - `interface IdentityMeta { publicKey: string; name?: string; branch?: string }`
  - `readIdentityMeta(dir?: string): IdentityMeta | null` — null when no identity file
  - `writeIdentityMeta(dir: string, meta: { name: string; branch: string }): void` — rewrites the comment header, preserving the secret key line
  - `createIdentity(dir, meta?: { name: string; branch: string })` (modified signature, `meta` optional)

- [ ] **Step 1: Write the failing test**

Create `tests/engine/access-request.test.ts`:

```typescript
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    branchForName,
    readIdentityMeta,
    slugForName,
    writeIdentityMeta,
} from '@/engine/access-request'
import { createIdentity } from '@/engine/identity'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'access-meta-'))
}

describe('slugForName', () => {
    it('lowercases and hyphenates', () => {
        expect(slugForName('Greg Fitch')).toBe('greg-fitch')
        expect(branchForName('Greg Fitch')).toBe('access/greg-fitch')
    })

    it('strips punctuation and collapses separators', () => {
        expect(slugForName('Nathan Stitt (dev)')).toBe('nathan-stitt-dev')
    })
})

describe('identity metadata', () => {
    it('round-trips name and branch through the comment header', async () => {
        const dir = tmpDir()
        const { publicKey } = await createIdentity(dir, {
            name: 'Greg Fitch',
            branch: 'access/greg-fitch',
        })
        const meta = readIdentityMeta(dir)
        expect(meta).toMatchObject({
            publicKey,
            name: 'Greg Fitch',
            branch: 'access/greg-fitch',
        })
    })

    it('returns null when there is no identity file', () => {
        expect(readIdentityMeta(tmpDir())).toBeNull()
    })

    it('reads a legacy identity file that has no name/branch comments', async () => {
        const dir = tmpDir()
        const { publicKey } = await createIdentity(dir)
        const meta = readIdentityMeta(dir)
        expect(meta?.publicKey).toBe(publicKey)
        expect(meta?.name).toBeUndefined()
        expect(meta?.branch).toBeUndefined()
    })

    it('adds metadata to an existing identity without changing the secret key', async () => {
        const dir = tmpDir()
        await createIdentity(dir)
        const before = fs
            .readFileSync(path.join(dir, 'age-identity.txt'), 'utf8')
            .split('\n')
            .find(l => l.startsWith('AGE-SECRET-KEY-'))
        writeIdentityMeta(dir, { name: 'Ada Lovelace', branch: 'access/ada-lovelace' })
        const after = fs
            .readFileSync(path.join(dir, 'age-identity.txt'), 'utf8')
            .split('\n')
            .find(l => l.startsWith('AGE-SECRET-KEY-'))
        expect(after).toBe(before)
        expect(readIdentityMeta(dir)?.name).toBe('Ada Lovelace')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/engine/access-request.test.ts`
Expected: FAIL — cannot resolve `@/engine/access-request`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/access-request.ts`:

```typescript
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
export function writeIdentityMeta(
    dir: string,
    meta: { name: string; branch: string }
): void {
    const secret = readIdentity(dir)
    if (!secret) throw new Error('writeIdentityMeta: no identity file to update')
    void publicKeyFromIdentity
    const existing = readIdentityMeta(dir)
    const header = [
        `# public key: ${existing?.publicKey ?? ''}`,
        `# name: ${meta.name}`,
        `# branch: ${meta.branch}`,
    ]
    fs.writeFileSync(identityPath(dir), `${header.join('\n')}\n${secret}\n`, { mode: 0o600 })
}
```

Then modify `src/engine/identity.ts` — replace `createIdentity` (lines 33-46) with:

```typescript
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
```

Add to `src/engine/identity.ts`'s imports:

```typescript
import { writeIdentityMeta } from '@/engine/access-request'
```

Note: `writeIdentityMeta` reads the public key from the existing header, so the
`void publicKeyFromIdentity` line above is dead — delete that line and the
`publicKeyFromIdentity` import from `access-request.ts` before committing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/engine/access-request.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full check and commit**

```bash
pnpm test && pnpm typecheck && pnpm lint:fix
git add src/engine/access-request.ts src/engine/identity.ts tests/engine/access-request.test.ts
git commit -m "Store name and branch in the age identity header"
```

---

### Task 2: Idempotent `addMember`

**Files:**
- Modify: `src/engine/keyring.ts:42-48`
- Modify: `tests/cli/request-access.test.ts:37-44`
- Test: `tests/engine/keyring.test.ts` (create if absent)

**Interfaces:**
- Consumes: `Member` from `@/engine/keyring`.
- Produces: `addMember(members, member)` — unchanged signature, new semantics: an entry whose `name` AND `publicKey` both match is returned unchanged; a different `publicKey` under a taken `name` still throws.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/keyring.test.ts` (create the file with this content if it does not exist):

```typescript
import { describe, expect, it } from 'vitest'
import { addMember, type Member } from '@/engine/keyring'

const ada: Member = {
    name: 'Ada Lovelace',
    publicKey: 'age1ada',
    email: 'ada@x.com',
    addedDate: '2026-07-28',
}

describe('addMember', () => {
    it('adds a new member', () => {
        expect(addMember([], ada)).toHaveLength(1)
    })

    // Re-running request-access must not error: that error is what pushed users
    // into renaming themselves and filing a duplicate access PR.
    it('is a no-op when the same name and key are re-added', () => {
        const next = addMember([ada], { ...ada, addedDate: '2026-08-01' })
        expect(next).toEqual([ada])
    })

    it('still rejects a different key under a taken name', () => {
        expect(() => addMember([ada], { ...ada, publicKey: 'age1other' })).toThrow(
            /already in the keyring/
        )
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/engine/keyring.test.ts`
Expected: FAIL — "is a no-op when the same name and key are re-added" throws `already in the keyring`.

- [ ] **Step 3: Write the implementation**

Replace `addMember` in `src/engine/keyring.ts`:

```typescript
// Add a member. Re-adding the SAME name with the SAME key is a no-op (returns the
// list unchanged) so a repeated access request doesn't error — erroring here is
// what drove users to rename themselves and open a second PR. A different key
// under a taken name is still a genuine conflict.
export function addMember(members: Member[], member: Member): Member[] {
    const existing = members.find(m => m.name === member.name)
    if (existing) {
        if (existing.publicKey === member.publicKey) return members
        throw new Error(`"${member.name}" is already in the keyring (names must be unique)`)
    }
    return [...members, member]
}
```

- [ ] **Step 4: Update the stale expectation in the request-access test**

In `tests/cli/request-access.test.ts`, replace the `rejects a duplicate name` test (lines 37-44) with:

```typescript
    it('is idempotent for the same person', async () => {
        const dir = tmpDir()
        const git = async () => ''
        await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        await requestAccess({ dir, name: 'Jane', email: 'a@x.com', date: '2026-06-30', git })
        const keyring = JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8'))
        expect(keyring).toHaveLength(1)
    })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/keyring.test.ts tests/cli/request-access.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm test && pnpm typecheck && pnpm lint:fix
git add src/engine/keyring.ts tests/engine/keyring.test.ts tests/cli/request-access.test.ts
git commit -m "Make addMember idempotent for an identical re-add"
```

---

### Task 3: Split `requestAccess` and reuse an existing branch

**Files:**
- Modify: `src/cli/commands/request-access.ts` (whole file)
- Create: `src/cli/commands/open-access-pr.ts`
- Create: `tests/cli/open-access-pr.test.ts`

**Interfaces:**
- Consumes: `branchForName`, `readIdentityMeta` from `@/engine/access-request`; `createIdentity`; `addMember`, `readKeyring`, `writeKeyring`.
- Produces:
  - `type GitRunner = (args: string[]) => Promise<string>` (already exported; unchanged)
  - `type GhRunner = (args: string[]) => Promise<string>` — new, injectable `gh`
  - `requestAccess(opts: RequestAccessOptions): Promise<{ publicKey: string; created: boolean; branch: string }>` — unchanged signature; now reuses an existing branch and writes identity metadata
  - `openAccessPr(opts: { branch: string; name: string; gh?: GhRunner }): Promise<{ url: string; created: boolean }>` — `created: false` means a PR already existed
  - `openAccessPrCommand(opts: Record<string, string>): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/open-access-pr.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { openAccessPr } from '@/cli/commands/open-access-pr'

describe('openAccessPr', () => {
    it('creates a PR and returns its url', async () => {
        const calls: string[][] = []
        const result = await openAccessPr({
            branch: 'access/ada',
            name: 'Ada',
            gh: async args => {
                calls.push(args)
                return 'https://github.com/o/r/pull/42\n'
            },
        })
        expect(result).toEqual({ url: 'https://github.com/o/r/pull/42', created: true })
        expect(calls[0]).toContain('create')
    })

    // gh fails when a PR already exists. That is success, not failure — reporting it
    // as failure is what made users believe their request had not gone through.
    it('reports the existing PR when gh says one already exists', async () => {
        const result = await openAccessPr({
            branch: 'access/ada',
            name: 'Ada',
            gh: async args => {
                if (args.includes('create')) {
                    throw new Error('a pull request for branch "access/ada" already exists:#7')
                }
                return JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7' }])
            },
        })
        expect(result).toEqual({ url: 'https://github.com/o/r/pull/7', created: false })
    })

    it('propagates a genuine gh failure', async () => {
        await expect(
            openAccessPr({
                branch: 'access/ada',
                name: 'Ada',
                gh: async () => {
                    throw new Error('gh: not authenticated')
                },
            })
        ).rejects.toThrow(/not authenticated/)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/cli/open-access-pr.test.ts`
Expected: FAIL — cannot resolve `@/cli/commands/open-access-pr`.

- [ ] **Step 3: Write `open-access-pr.ts`**

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readIdentityMeta } from '@/engine/access-request'
import { repoDir } from '@/engine/paths'

const execFileAsync = promisify(execFile)

export type GhRunner = (args: string[]) => Promise<string>

const realGh: GhRunner = async args =>
    (await execFileAsync('gh', args, { cwd: repoDir() })).stdout

// Create the access PR, or report the one that already exists. `gh pr create`
// fails when a PR is already open for the branch; that is the SUCCESS path here —
// treating it as an error is what made a pending request look like a failed one.
export async function openAccessPr(opts: {
    branch: string
    name: string
    gh?: GhRunner
}): Promise<{ url: string; created: boolean }> {
    const gh = opts.gh ?? realGh
    try {
        const out = await gh([
            'pr',
            'create',
            '--base',
            'main',
            '--head',
            opts.branch,
            '--title',
            `Add ${opts.name} to keyring`,
            '--body',
            'Reviewer: run "Approve & rekey" (qar rekey on this branch) before merging.',
        ])
        return { url: out.trim(), created: true }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (!/already exists/i.test(message)) throw e
        const listed = await gh([
            'pr',
            'list',
            '--head',
            opts.branch,
            '--state',
            'open',
            '--json',
            'number,url',
        ])
        const prs = JSON.parse(listed || '[]') as Array<{ number: number; url: string }>
        if (prs.length === 0) throw e
        return { url: prs[0].url, created: false }
    }
}

export async function openAccessPrCommand(_opts: Record<string, string>): Promise<void> {
    const meta = readIdentityMeta()
    if (!meta?.branch) {
        throw new Error('open-access-pr: no access request found — run "qar request-access" first')
    }
    const { url, created } = await openAccessPr({
        branch: meta.branch,
        name: meta.name ?? meta.branch.replace(/^access\//, ''),
    })
    console.log(created ? `Opened ${url}` : `A pull request is already open: ${url}`)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/cli/open-access-pr.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewrite `requestAccess` to reuse the branch and record metadata**

Replace the body of `requestAccess` in `src/cli/commands/request-access.ts`:

```typescript
export interface RequestAccessOptions {
    dir: string
    name: string
    email: string
    date: string
    git?: GitRunner
}

// Create-or-reuse the identity, add it to the keyring, and push the access branch.
// Every step is idempotent: re-running for the same person reuses the same key, the
// same keyring entry, and the same branch rather than producing a second request.
export async function requestAccess(
    opts: RequestAccessOptions
): Promise<{ publicKey: string; created: boolean; branch: string }> {
    const git = opts.git ?? realGit
    const branch = branchForName(opts.name)
    const { publicKey, created } = await createIdentity(opts.dir, { name: opts.name, branch })

    const next = addMember(readKeyring(opts.dir), {
        name: opts.name,
        publicKey,
        email: opts.email,
        addedDate: opts.date,
    })
    writeKeyring(opts.dir, next)

    // Reuse the branch if it exists — `checkout -b` fails on a second run, which is
    // half of what forced users to rename themselves to get a fresh slug.
    try {
        await git(['rev-parse', '--verify', branch])
        await git(['checkout', branch])
    } catch {
        await git(['checkout', '-b', branch])
    }
    await git(['add', 'config/keyring.json'])
    // Nothing to commit on a re-run (the entry is already there); that is fine.
    try {
        await git(['commit', '-m', `Add ${opts.name} to keyring`])
    } catch {
        // no-op: the keyring entry was already committed on a previous attempt
    }
    await git(['push', '-u', 'origin', branch])
    // Return to the user's prior branch so a later `qar sync` doesn't get stuck
    // on the (diverged) access branch. Best-effort.
    try {
        await git(['checkout', '-'])
    } catch {
        // stay on the access branch; the PR is already pushed
    }
    return { publicKey, created, branch }
}
```

Replace `slug()` usage: delete the local `slug` function (lines 10-16) and import
`branchForName` instead:

```typescript
import { branchForName } from '@/engine/access-request'
```

Then replace the `gh pr create` block in `requestAccessCommand` with a call to the
new helper:

```typescript
export async function requestAccessCommand(opts: Record<string, string>): Promise<void> {
    const name = opts.name ?? (await safeGitConfigName())
    if (!name) {
        throw new Error('request-access: --name "Your Name" is required (git user.name is unset)')
    }
    const email = opts.email ?? (await safeGitConfigEmail())
    const date = new Date().toISOString().slice(0, 10)
    const { branch, created } = await requestAccess({ dir: configDir(), name, email, date })
    console.log(
        `${created ? 'Generated a new identity. ' : 'Reused existing identity. '}Pushed ${branch}.`
    )

    try {
        const { url, created: prCreated } = await openAccessPr({ branch, name })
        console.log(
            prCreated
                ? `Opened ${url} — a teammate will approve + rekey, then merge.`
                : `A pull request is already open: ${url}`
        )
    } catch (e) {
        const detail =
            e instanceof Error ? (e as { stderr?: string }).stderr || e.message : String(e)
        console.log(`Could not open a PR automatically:\n${detail.trim()}`)
        console.log(`Retry with: qar open-access-pr`)
    }
}

async function safeGitConfigName(): Promise<string> {
    try {
        return (await execFileAsync('git', ['config', 'user.name'])).stdout.trim()
    } catch {
        return ''
    }
}
```

Add the import: `import { openAccessPr } from '@/cli/commands/open-access-pr'`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/cli/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm test && pnpm typecheck && pnpm lint:fix
git add src/cli/commands/request-access.ts src/cli/commands/open-access-pr.ts tests/cli/
git commit -m "Split PR opening from the access request and make both idempotent"
```

---

### Task 4: `qar access-status --json`

**Files:**
- Create: `src/cli/commands/access-status.ts`
- Create: `tests/cli/access-status.test.ts`

**Interfaces:**
- Consumes: `readIdentityMeta`, `branchForName` from `@/engine/access-request`; `readKeyring` from `@/engine/keyring`; `readIdentity`, `SECRETS_FILE`, `isEncryptedValue`, `decryptWithIdentity` from `@/engine/settings`; `GitRunner` / `GhRunner` types.
- Produces:
  - `type AccessState = 'no-identity' | 'no-branch' | 'branch-no-pr' | 'pr-open' | 'pr-closed' | 'merged-awaiting-rekey' | 'ready'`
  - `interface AccessStatus { state: AccessState; publicKey: string; name: string; branch: string; pr: { number: number; state: string; url: string } | null; githubReachable: boolean; note: string }`
  - `resolveAccessStatus(opts: { dir: string; git: GitRunner; gh: GhRunner; identityName?: string }): Promise<AccessStatus>`
  - `accessStatusCommand(opts: Record<string, string>): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/access-status.test.ts`:

```typescript
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAccessStatus } from '@/cli/commands/access-status'
import { createIdentity } from '@/engine/identity'
import { readIdentityMeta } from '@/engine/access-request'
import { writeKeyring } from '@/engine/keyring'

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'access-status-'))
}

const noGit = async () => ''
const noGh = async () => '[]'

async function seedIdentity(dir: string) {
    await createIdentity(dir, { name: 'Ada Lovelace', branch: 'access/ada-lovelace' })
    return readIdentityMeta(dir)!.publicKey
}

describe('resolveAccessStatus', () => {
    it('reports no-identity when there is no key', async () => {
        const status = await resolveAccessStatus({ dir: tmpDir(), git: noGit, gh: noGh })
        expect(status.state).toBe('no-identity')
    })

    it('reports no-branch when the branch is not on the remote', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({ dir, git: async () => '', gh: noGh })
        expect(status.state).toBe('no-branch')
        expect(status.branch).toBe('access/ada-lovelace')
    })

    it('reports branch-no-pr when the branch exists but gh finds no PR', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: noGh,
        })
        expect(status.state).toBe('branch-no-pr')
    })

    it('reports pr-open with the PR details', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: async () =>
                JSON.stringify([{ number: 21, state: 'OPEN', url: 'https://x/pull/21' }]),
        })
        expect(status.state).toBe('pr-open')
        expect(status.pr).toMatchObject({ number: 21, url: 'https://x/pull/21' })
    })

    it('reports pr-closed for a PR closed without merging', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: async () =>
                JSON.stringify([{ number: 21, state: 'CLOSED', url: 'https://x/pull/21' }]),
        })
        expect(status.state).toBe('pr-closed')
    })

    it('reports merged-awaiting-rekey when the key is in the keyring but secrets do not decrypt', async () => {
        const dir = tmpDir()
        const publicKey = await seedIdentity(dir)
        writeKeyring(dir, [
            { name: 'Ada Lovelace', publicKey, email: 'a@x.com', addedDate: '2026-07-28' },
        ])
        // An armored blob encrypted to somebody else's key.
        fs.writeFileSync(
            path.join(dir, 'settings.secrets.json'),
            JSON.stringify({
                QA_PASSWORD:
                    '-----BEGIN AGE ENCRYPTED FILE-----\nnot-decryptable\n-----END AGE ENCRYPTED FILE-----',
            })
        )
        const status = await resolveAccessStatus({ dir, git: noGit, gh: noGh })
        expect(status.state).toBe('merged-awaiting-rekey')
    })

    it('reports ready when the key is in the keyring and every secret decrypts', async () => {
        const dir = tmpDir()
        const publicKey = await seedIdentity(dir)
        writeKeyring(dir, [
            { name: 'Ada Lovelace', publicKey, email: 'a@x.com', addedDate: '2026-07-28' },
        ])
        fs.writeFileSync(path.join(dir, 'settings.secrets.json'), JSON.stringify({}))
        const status = await resolveAccessStatus({ dir, git: noGit, gh: noGh })
        expect(status.state).toBe('ready')
    })

    // The whole point of the feature: an unreachable GitHub must never look like
    // "you never requested access", which is what restarts the duplicate-PR loop.
    it('degrades to a local state when gh fails, never to no-identity', async () => {
        const dir = tmpDir()
        await seedIdentity(dir)
        const status = await resolveAccessStatus({
            dir,
            git: async () => 'abc123\trefs/heads/access/ada-lovelace',
            gh: async () => {
                throw new Error('gh: not authenticated')
            },
        })
        expect(status.state).not.toBe('no-identity')
        expect(status.githubReachable).toBe(false)
        expect(status.note).toMatch(/GitHub/i)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/cli/access-status.test.ts`
Expected: FAIL — cannot resolve `@/cli/commands/access-status`.

- [ ] **Step 3: Write the implementation**

Create `src/cli/commands/access-status.ts`:

```typescript
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { branchForName, readIdentityMeta } from '@/engine/access-request'
import { readIdentity } from '@/engine/identity'
import { readKeyring } from '@/engine/keyring'
import { repoDir } from '@/engine/paths'
import {
    configDir,
    decryptWithIdentity,
    isEncryptedValue,
    SECRETS_FILE,
} from '@/engine/settings'

const execFileAsync = promisify(execFile)

export type Runner = (args: string[]) => Promise<string>

const realGit: Runner = async args =>
    (await execFileAsync('git', args, { cwd: repoDir() })).stdout
const realGh: Runner = async args =>
    (await execFileAsync('gh', args, { cwd: repoDir() })).stdout

export type AccessState =
    | 'no-identity'
    | 'no-branch'
    | 'branch-no-pr'
    | 'pr-open'
    | 'pr-closed'
    | 'merged-awaiting-rekey'
    | 'ready'

export interface AccessStatus {
    state: AccessState
    publicKey: string
    name: string
    branch: string
    pr: { number: number; state: string; url: string } | null
    githubReachable: boolean
    note: string
}

// True only when EVERY encrypted secret decrypts — matching loadSettings(), which
// throws on the first one it can't. A single undecryptable secret still fails a run,
// so "one worked" would be a false green.
async function allSecretsDecrypt(
    dir: string,
    identity: string
): Promise<{ canDecrypt: boolean; checkable: boolean }> {
    const p = path.join(dir, SECRETS_FILE)
    if (!fs.existsSync(p)) return { canDecrypt: false, checkable: false }
    const secrets = JSON.parse(fs.readFileSync(p, 'utf8') || '{}') as Record<string, string>
    let tried = false
    for (const value of Object.values(secrets)) {
        if (!isEncryptedValue(value)) continue
        tried = true
        try {
            await decryptWithIdentity(value, identity)
        } catch {
            return { canDecrypt: false, checkable: true }
        }
    }
    return { canDecrypt: tried, checkable: tried }
}

// Resolve the request state from the local key outward: keyring membership, then the
// remote branch, then the PR. GitHub failures degrade to the best LOCAL answer and
// set githubReachable=false — they must never report "no request".
export async function resolveAccessStatus(opts: {
    dir: string
    git: Runner
    gh: Runner
    identityName?: string
}): Promise<AccessStatus> {
    const meta = readIdentityMeta(opts.dir)
    const base: AccessStatus = {
        state: 'no-identity',
        publicKey: '',
        name: '',
        branch: '',
        pr: null,
        githubReachable: true,
        note: '',
    }
    if (!meta) return base

    const name = meta.name ?? opts.identityName ?? ''
    const branch = meta.branch ?? (name ? branchForName(name) : '')
    const status: AccessStatus = { ...base, publicKey: meta.publicKey, name, branch }

    const identity = readIdentity(opts.dir)
    const inKeyring = readKeyring(opts.dir).some(m => m.publicKey === meta.publicKey)
    if (inKeyring && identity) {
        const { canDecrypt, checkable } = await allSecretsDecrypt(opts.dir, identity)
        if (canDecrypt || !checkable) return { ...status, state: 'ready' }
        return { ...status, state: 'merged-awaiting-rekey' }
    }

    if (!branch) return { ...status, state: 'no-branch' }

    let remoteHasBranch = false
    try {
        remoteHasBranch = (await opts.git(['ls-remote', '--heads', 'origin', branch])).trim() !== ''
    } catch {
        return {
            ...status,
            state: 'no-branch',
            githubReachable: false,
            note: "Couldn't reach GitHub to check your request — showing local state only.",
        }
    }
    if (!remoteHasBranch) return { ...status, state: 'no-branch' }

    try {
        const listed = await opts.gh([
            'pr',
            'list',
            '--head',
            branch,
            '--state',
            'all',
            '--json',
            'number,state,url',
        ])
        const prs = JSON.parse(listed || '[]') as Array<{
            number: number
            state: string
            url: string
        }>
        if (prs.length === 0) return { ...status, state: 'branch-no-pr' }
        const pr = prs[0]
        const state: AccessState = pr.state === 'OPEN' ? 'pr-open' : 'pr-closed'
        return { ...status, state, pr }
    } catch {
        return {
            ...status,
            state: 'branch-no-pr',
            githubReachable: false,
            note: "Couldn't reach GitHub to check your pull request — showing local state only.",
        }
    }
}

export async function accessStatusCommand(_opts: Record<string, string>): Promise<void> {
    const status = await resolveAccessStatus({
        dir: configDir(),
        git: realGit,
        gh: realGh,
    })
    console.log(JSON.stringify(status))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/cli/access-status.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
pnpm test && pnpm typecheck && pnpm lint:fix
git add src/cli/commands/access-status.ts tests/cli/access-status.test.ts
git commit -m "Add access-status: resolve the request state from the local key"
```

---

### Task 5: Wire both subcommands into the CLI

**Files:**
- Modify: `bin/qar.ts:61-105`
- Modify: `src/cli/help.ts:38-42`

**Interfaces:**
- Consumes: `accessStatusCommand`, `openAccessPrCommand`.
- Produces: `qar access-status [--json]` and `qar open-access-pr` on the CLI.

- [ ] **Step 1: Add the dispatch cases**

In `bin/qar.ts`, add the imports:

```typescript
import { accessStatusCommand } from '@/cli/commands/access-status'
import { openAccessPrCommand } from '@/cli/commands/open-access-pr'
```

and the cases, immediately after `case 'request-access':`:

```typescript
        case 'access-status':
            return accessStatusCommand(opts)
        case 'open-access-pr':
            return openAccessPrCommand(opts)
```

- [ ] **Step 2: Add the help entries**

In `src/cli/help.ts`, after the `request-access` entry:

```typescript
    {
        name: 'access-status',
        usage: 'qar access-status [--json]',
        summary: 'Report the state of your keyring access request.',
        details:
            'States: no-identity, no-branch, branch-no-pr, pr-open, pr-closed, merged-awaiting-rekey, ready.',
    },
    {
        name: 'open-access-pr',
        usage: 'qar open-access-pr',
        summary: 'Open (or report) the pull request for an already-pushed access branch.',
    },
```

- [ ] **Step 3: Verify both commands resolve**

Run: `pnpm qar access-status`
Expected: a single line of JSON. On the author's machine (identity present, key in
keyring, secrets decrypt) that is `{"state":"ready",...}`.

Run: `pnpm qar --help`
Expected: both new commands appear in the list.

- [ ] **Step 4: Commit**

```bash
pnpm test && pnpm typecheck && pnpm lint:fix
git add bin/qar.ts src/cli/help.ts
git commit -m "Wire access-status and open-access-pr into the CLI"
```

---

### Task 6: Go — fold the engine status into `CheckKeyringAccess`

**Files:**
- Modify: `gui/app.go:1166-1212`
- Test: `gui/app_test.go` (create if absent)

**Interfaces:**
- Consumes: `engineCmd(args ...string) *exec.Cmd` (existing, `gui/paths.go`).
- Produces:
  - `KeyringAccess` gains `State string`, `Branch string`, `PrNumber int`, `PrURL string`, `GithubReachable bool` (JSON tags `state`, `branch`, `prNumber`, `prURL`, `githubReachable`).
  - `func (a *App) OpenAccessPr(cwd string) (string, error)`
  - `func parseAccessStatus(raw []byte) (engineAccessStatus, error)`

- [ ] **Step 1: Write the failing test**

Create `gui/app_test.go` (or append if it exists):

```go
package main

import "testing"

func TestParseAccessStatus(t *testing.T) {
	raw := []byte(`{"state":"pr-open","branch":"access/ada","publicKey":"age1x","name":"Ada","pr":{"number":21,"state":"OPEN","url":"https://x/pull/21"},"githubReachable":true,"note":""}`)
	got, err := parseAccessStatus(raw)
	if err != nil {
		t.Fatalf("parseAccessStatus: %v", err)
	}
	if got.State != "pr-open" || got.Branch != "access/ada" {
		t.Fatalf("unexpected status: %+v", got)
	}
	if got.PR == nil || got.PR.Number != 21 {
		t.Fatalf("expected PR 21, got %+v", got.PR)
	}
}

func TestParseAccessStatusRejectsGarbage(t *testing.T) {
	if _, err := parseAccessStatus([]byte("not json")); err == nil {
		t.Fatal("expected an error for malformed engine output")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gui && go test ./...`
Expected: FAIL — `undefined: parseAccessStatus`.

- [ ] **Step 3: Write the implementation**

In `gui/app.go`, replace the `KeyringAccess` struct and add the helpers:

```go
// KeyringAccess is the encryption-access state shown by the first-launch gate:
// whether the local identity exists, whether it can decrypt, and — from the engine's
// access-status — where the access request itself stands.
type KeyringAccess struct {
	HasIdentity     bool   `json:"hasIdentity"`     // config/age-identity.txt exists
	IsRecipient     bool   `json:"isRecipient"`     // its public key decrypts the committed secrets
	Note            string `json:"note"`            // non-fatal pull note (offline / skipped), if any
	State           string `json:"state"`           // engine access-status state, "" if unavailable
	Branch          string `json:"branch"`          // the access branch for this key
	PrNumber        int    `json:"prNumber"`        // 0 when there is no PR
	PrURL           string `json:"prURL"`           // "" when there is no PR
	GithubReachable bool   `json:"githubReachable"` // false when gh/network failed
}

type engineAccessPR struct {
	Number int    `json:"number"`
	State  string `json:"state"`
	URL    string `json:"url"`
}

type engineAccessStatus struct {
	State           string          `json:"state"`
	Branch          string          `json:"branch"`
	Name            string          `json:"name"`
	PublicKey       string          `json:"publicKey"`
	PR              *engineAccessPR `json:"pr"`
	GithubReachable bool            `json:"githubReachable"`
	Note            string          `json:"note"`
}

func parseAccessStatus(raw []byte) (engineAccessStatus, error) {
	var s engineAccessStatus
	if err := json.Unmarshal(bytes.TrimSpace(raw), &s); err != nil {
		return engineAccessStatus{}, err
	}
	return s, nil
}

// accessStatus shells the engine's access-status. A failure is NON-FATAL: the gate
// still renders from the local decrypt check, with a note. Never let this turn an
// existing request into "no request".
func (a *App) accessStatus() (engineAccessStatus, string) {
	out, err := engineCmd("access-status").Output()
	if err != nil {
		return engineAccessStatus{}, "Couldn't check your access request status."
	}
	status, perr := parseAccessStatus(out)
	if perr != nil {
		return engineAccessStatus{}, "Couldn't read the access request status."
	}
	return status, status.Note
}
```

Add `"bytes"` and `"encoding/json"` to the imports if not already present.

Then extend `CheckKeyringAccess` — after computing `canDecrypt`, before the return:

```go
	status, statusNote := a.accessStatus()
	if statusNote != "" {
		if note == "" {
			note = statusNote
		} else {
			note = note + " " + statusNote
		}
	}
	access := KeyringAccess{
		HasIdentity:     has,
		IsRecipient:     canDecrypt,
		Note:            note,
		State:           status.State,
		Branch:          status.Branch,
		GithubReachable: status.GithubReachable,
	}
	if status.PR != nil {
		access.PrNumber = status.PR.Number
		access.PrURL = status.PR.URL
	}
	return access, nil
```

(Delete the previous `return KeyringAccess{...}, nil` line it replaces.)

Add `OpenAccessPr` next to `RequestAccess`:

```go
// OpenAccessPr runs the engine's open-access-pr for an already-pushed access branch
// — the retry path for a request whose push succeeded but whose PR creation didn't.
func (a *App) OpenAccessPr(cwd string) (string, error) {
	out, err := engineCmd("open-access-pr").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("open-access-pr failed: %s\n%s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd gui && go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd gui && go test ./... && cd ..
git add gui/app.go gui/app_test.go
git commit -m "Surface the engine access-status through CheckKeyringAccess"
```

---

### Task 7: Frontend — the status component

**Files:**
- Create: `gui/frontend/src/components/AccessRequestStatus.tsx`
- Modify: `gui/frontend/src/lib/ipc.ts:38-42`
- Modify: `gui/frontend/src/components/KeyringAccessGate.tsx`
- Modify: `gui/frontend/src/components/RequestAccessButton.tsx`

**Interfaces:**
- Consumes: `KeyringAccess` (now with `state`, `branch`, `prNumber`, `prURL`, `githubReachable`), `requestAccess(name)`, new `openAccessPr()`.
- Produces: `<AccessRequestStatus access={...} checking={...} onRetry={...} />`.

- [ ] **Step 1: Extend the ipc types and add the binding**

In `gui/frontend/src/lib/ipc.ts`, replace the `KeyringAccess` interface:

```typescript
export type AccessState =
    | 'no-identity'
    | 'no-branch'
    | 'branch-no-pr'
    | 'pr-open'
    | 'pr-closed'
    | 'merged-awaiting-rekey'
    | 'ready'

export interface KeyringAccess {
    hasIdentity: boolean
    isRecipient: boolean
    note: string
    state: AccessState | ''
    branch: string
    prNumber: number
    prURL: string
    githubReachable: boolean
}
```

Add the binding next to the existing `requestAccess` export (match the file's
existing call style — `window.go.main.App.<Method>`):

```typescript
export async function openAccessPr(): Promise<string> {
    return window.go.main.App.OpenAccessPr('')
}
```

- [ ] **Step 2: Write the status component**

Create `gui/frontend/src/components/AccessRequestStatus.tsx`:

```typescript
import { Alert, Anchor, Button, Group, Loader, Text, TextInput } from '@mantine/core'
import { useState } from 'react'
import { type KeyringAccess, openAccessPr, requestAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// What each state means and what the single primary button does about it. Keeping
// this as data (not branches in JSX) keeps the component readable as the state list
// grows.
const COPY: Record<string, { message: string; action: string }> = {
    'no-identity': {
        message: 'Request access to decrypt the shared account passwords and MFA codes.',
        action: 'Request access',
    },
    'no-branch': {
        message: 'Your key exists but the request was never submitted.',
        action: 'Submit request',
    },
    'branch-no-pr': {
        message: 'Your branch was pushed but no pull request was opened.',
        action: 'Open pull request',
    },
    'pr-open': {
        message: 'Your access request is open and waiting for a reviewer.',
        action: 'Check again',
    },
    'pr-closed': {
        message: 'Your access request was closed without being merged.',
        action: 'Re-open request',
    },
    'merged-awaiting-rekey': {
        message:
            'Your request was merged. A reviewer still needs to run "qar rekey" before the secrets are encrypted to your key.',
        action: 'Check again',
    },
}

function useAccessAction(state: string, onRetry: () => void) {
    // branch-no-pr is the only state whose action is PR creation; no-identity and
    // no-branch submit the request; everything else just re-checks.
    return useAsyncAction(async (name: string) => {
        if (state === 'branch-no-pr') return openAccessPr()
        if (state === 'no-identity' || state === 'no-branch' || state === 'pr-closed') {
            const out = await requestAccess(name)
            onRetry()
            return out
        }
        onRetry()
        return ''
    })
}

export function AccessRequestStatus({
    access,
    checking,
    onRetry,
}: {
    access: KeyringAccess | null
    checking: boolean
    onRetry: () => void
}) {
    const state = access?.state || 'no-identity'
    const copy = COPY[state] ?? COPY['no-identity']
    const action = useAccessAction(state, onRetry)
    // Only asked for when git has no user.name — the engine derives it otherwise.
    const [name, setName] = useState('')
    const needsName = state === 'no-identity' && !access?.branch

    return (
        <div>
            <Text size="sm" mb={10}>
                {copy.message}
            </Text>

            {access?.prURL ? (
                <Text size="sm" mb={10}>
                    <Anchor href={access.prURL} target="_blank">
                        Pull request #{access.prNumber}
                    </Anchor>
                </Text>
            ) : null}

            {access && !access.githubReachable ? (
                <Alert color="yellow" mb={10}>
                    Couldn’t reach GitHub — showing the last state we could confirm locally.
                </Alert>
            ) : null}

            <Group align="flex-end">
                {needsName ? (
                    <TextInput
                        label="Your name"
                        description="Only needed because git user.name isn’t set"
                        placeholder="Ada Lovelace"
                        value={name}
                        onChange={e => setName(e.currentTarget.value)}
                        style={{ flex: 1 }}
                    />
                ) : null}
                <Button
                    onClick={() => void action.run(name.trim())}
                    loading={action.busy || checking}
                    color="teal"
                >
                    {copy.action}
                </Button>
                {checking ? <Loader size="xs" /> : null}
            </Group>

            {action.error ? (
                <Alert color="red" mt="sm">
                    {action.error}
                </Alert>
            ) : null}
            {access?.note ? (
                <Text size="xs" mt={8} className="mono st-dim">
                    {access.note}
                </Text>
            ) : null}
        </div>
    )
}
```

- [ ] **Step 3: Render it from the gate**

In `gui/frontend/src/components/KeyringAccessGate.tsx`, replace the whole
`RequestAccessGateModal` function with a modal that delegates to the new component,
and delete the now-unused `TextInput` / `requestAccess` imports:

```typescript
function RequestAccessGateModal({
    access,
    checking,
    checkError,
    onRetry,
}: {
    access: KeyringAccess | null
    checking: boolean
    checkError: string | null
    onRetry: () => void
}) {
    return (
        <Modal
            opened
            onClose={() => {}}
            withCloseButton={false}
            closeOnClickOutside={false}
            closeOnEscape={false}
            title="Encryption access required"
            centered
            size="lg"
        >
            <AccessRequestStatus access={access} checking={checking} onRetry={onRetry} />
            {checkError ? (
                <Text size="xs" c="red" mt={10}>
                    {checkError}
                </Text>
            ) : null}
        </Modal>
    )
}
```

- [ ] **Step 4: Collapse the Settings button onto the same component**

Replace the body of `gui/frontend/src/components/RequestAccessButton.tsx`:

```typescript
import { useEffect } from 'react'
import { checkKeyringAccess, type KeyringAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'
import { AccessRequestStatus } from './AccessRequestStatus'

// The Settings-tab surface for the same access state the first-launch gate shows.
export function RequestAccessButton() {
    const { run, busy, result } = useAsyncAction<[], KeyringAccess>(() => checkKeyringAccess())

    useEffect(() => {
        void run()
    }, [run])

    return <AccessRequestStatus access={result} checking={busy} onRetry={() => void run()} />
}
```

- [ ] **Step 5: Typecheck the frontend and build**

Run: `cd gui/frontend && pnpm exec tsc --noEmit`
Expected: no errors.

Run: `cd gui && go build ./...`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
pnpm lint:fix
git add gui/frontend/src/components/AccessRequestStatus.tsx gui/frontend/src/components/KeyringAccessGate.tsx gui/frontend/src/components/RequestAccessButton.tsx gui/frontend/src/lib/ipc.ts
git commit -m "Render access request state instead of a name input"
```

---

### Task 8: Manual verification in the running GUI

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Confirm the CLI reports `ready` on this machine**

Run: `pnpm qar access-status`
Expected: `{"state":"ready",...}` — the author's key is in the keyring and the
secrets decrypt. Anything else means an earlier task regressed the decrypt path.

- [ ] **Step 2: Confirm a fresh-user state renders**

Temporarily point the engine at a scratch config dir so no identity is found:

```bash
AGE_IDENTITY_FILE=/private/tmp/claude-501/-Users-nas-code-si-qa-review/scratch-identity.txt pnpm qar access-status
```

Expected: `{"state":"no-identity",...}`. Do NOT move or delete the real
`config/age-identity.txt` — it is not recoverable.

- [ ] **Step 3: Start the GUI and check the Settings tab**

```bash
cd gui && nohup wails dev > "$TMPDIR/wails-dev.log" 2>&1 &
```

Poll `$TMPDIR/wails-dev.log` for `Using DevServer URL: http://localhost:34115`,
then open `http://localhost:34115/` and go to Settings. Expected: the access
section shows a state message (not a bare name input), and since this machine is
`ready`, the first-launch gate does not appear.

- [ ] **Step 4: Commit the documentation update**

Add to `CLAUDE.md`, in the "Multi-user encryption (keyring)" operations list:

```markdown
- `pnpm qar access-status` — report where your access request stands, as JSON.
  States: `no-identity`, `no-branch`, `branch-no-pr`, `pr-open`, `pr-closed`,
  `merged-awaiting-rekey`, `ready`. Keyed on the local age PUBLIC KEY (stored with
  `# name:`/`# branch:` in `config/age-identity.txt`), not on a typed-in name — so a
  repeat request can never open a second PR. A GitHub failure degrades to the local
  state and never reports "no request".
- `pnpm qar open-access-pr` — open (or report) the PR for an already-pushed access
  branch. This is the retry path when the branch push succeeded but PR creation
  didn't.
```

```bash
git add CLAUDE.md
git commit -m "Document access-status and open-access-pr"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 Identity file as request record | Task 1 |
| §2 Name derived from git config | Task 3 (`safeGitConfigName`), Task 7 (prompt only when unset) |
| §3 `qar access-status --json`, seven states | Task 4, wired in Task 5 |
| §3 One-directional degradation | Task 4 (test: "degrades to a local state… never to no-identity") |
| §4 Idempotent `addMember` | Task 2 |
| §4 Branch reuse | Task 3 |
| §4 `gh pr create` "already exists" is success | Task 3 (`openAccessPr`) |
| §4 `requestAccess` / `openAccessPr` split, `qar open-access-pr` | Task 3, Task 5 |
| §5 Per-state UI, explicit PR button | Task 7 |
| §6 Go wiring, non-fatal note | Task 6 |
| §Testing, vitest cases | Tasks 1–4 |
| §Testing, Go cases | Task 6 |

**Known gap accepted from the spec:** `gh pr list --head <branch>` won't find a PR
opened manually from a differently-named branch; that state shows `branch-no-pr`,
and the "Open pull request" button then reports the real PR via the "already
exists" path. Not designed around — it requires a human to have bypassed the
tooling.

**Type consistency:** `AccessState`'s seven members are identical in
`src/cli/commands/access-status.ts` (Task 4), `gui/frontend/src/lib/ipc.ts` (Task 7),
and the `COPY` map keys (Task 7). `Runner` is the single injected-command type in
Task 4; Task 3 uses `GitRunner` (pre-existing, unchanged) and `GhRunner`. Go's
`engineAccessStatus` JSON tags match the engine's `AccessStatus` field names
exactly (`state`, `branch`, `name`, `publicKey`, `pr`, `githubReachable`, `note`).

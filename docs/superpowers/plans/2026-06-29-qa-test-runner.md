# QA Test Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tool that lets non-technical QA staff run curated Playwright suites (and a plain-English exploratory mode) against the Management App's live QA/staging environments, with always-on video/screenshots and guaranteed test-data cleanup.

**Architecture:** One TypeScript **engine** orchestrates each run (resolve env → log in via Clerk testing mode → run suite → record always → guaranteed id-based cleanup → emit a result bundle). Thin shells (CLI now; Tauri GUI and a Claude Code skill later) drive the engine. Cleanup calls management-app's PR #839 QA endpoints (`DELETE /api/qa/users/[userId]`, `DELETE /api/qa/studies/[studyId]`), authorized by the admin role's Clerk session.

**Tech Stack:** TypeScript, Node (ESM), Playwright, `@clerk/testing`, Vitest (unit tests for the engine), pnpm. GUI (Tauri) and AI skill are later phases — this plan delivers the engine + CLI + first suites end-to-end first.

---

## Scope

This plan covers the **engine, configuration, auth, recorder, cleanup, CLI shell, and the first two curated suites** — a complete, runnable tool. The **Tauri GUI** and the **Claude Code `qa-explore` skill** are scoped as later phases (Tasks 13–14 are scaffolding stubs with their own follow-up plans) so v1 produces working software a QA person can use from the CLI.

Reference spec: `docs/superpowers/specs/2026-06-29-qa-test-runner-design.md`.

## File Structure

```
qatest/
  package.json              ESM, scripts, deps
  tsconfig.json
  vitest.config.ts
  .gitignore                ignores results/, .env*, node_modules
  .env.example              documents required secrets (committed)
  config/
    environments.ts         committed: env list (name, baseURL, role->cred-env-var map)
  src/
    engine/
      types.ts              shared types: RunRequest, StepEvent, RunResult, FailureCategory, RunContext
      env.ts                resolveEnv(name): EnvConfig  (merges config + secrets)
      auth.ts               loginAs(page, env, role): authenticated session via Clerk testing mode
      recorder.ts           Recorder: video+screenshots always, step events, writes bundle
      cleanup.ts            CleanupClient: tracks created ids, deletes via PR #839 endpoints
      run.ts                runEngine(req): the orchestration sequence (the spine)
      suite-registry.ts     lists/loads curated suites by name
    suites/
      types.ts              Suite interface: { name, description, roles, run(ctx) }
      signin.ts             Suite: "Sign in" (smallest real suite)
      create-study.ts       Suite: "Create a study" (exercises cleanup of a created study)
    cli/
      index.ts             interactive menu shell over runEngine
  tests/
    engine/
      env.test.ts
      recorder.test.ts
      cleanup.test.ts
      run.test.ts
      suite-registry.test.ts
  results/                  (git-ignored) run bundles
```

---

## Task 1: Project scaffold (package, tsconfig, vitest, gitignore)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "qatest",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "qa": "tsx src/cli/index.ts"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {
    "@clerk/testing": "^1.3.0",
    "@playwright/test": "^1.48.0",
    "dotenv": "^16.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "tests", "config"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
    resolve: {
        alias: { '@': path.resolve(__dirname, 'src') },
    },
    test: {
        // Engine unit tests only — Playwright suites run via the CLI, not vitest.
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
})
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
node_modules/
results/
.env
.env.local
*.log
```

- [ ] **Step 5: Create `.env.example`**

```bash
# One block per environment. Copy to .env and fill in real values (never commit .env).
# Clerk testing-mode accounts use +clerk_test addresses with the fixed OTP 424242.

# --- QA ---
QA_BASE_URL=https://qa.example.com
QA_ADMIN_EMAIL=qa-admin+clerk_test@example.com
QA_ADMIN_PASSWORD=
QA_RESEARCHER_EMAIL=qa-researcher+clerk_test@example.com
QA_RESEARCHER_PASSWORD=
QA_REVIEWER_EMAIL=qa-reviewer+clerk_test@example.com
QA_REVIEWER_PASSWORD=

# --- STAGING ---
STAGING_BASE_URL=https://staging.example.com
STAGING_ADMIN_EMAIL=staging-admin+clerk_test@example.com
STAGING_ADMIN_PASSWORD=
STAGING_RESEARCHER_EMAIL=staging-researcher+clerk_test@example.com
STAGING_RESEARCHER_PASSWORD=
STAGING_REVIEWER_EMAIL=staging-reviewer+clerk_test@example.com
STAGING_REVIEWER_PASSWORD=
```

- [ ] **Step 6: Install deps and verify typecheck runs**

Run: `cd /Users/nas/code/si/qatest && pnpm install && pnpm typecheck`
Expected: install succeeds; `tsc --noEmit` exits 0 (no source files yet, so no errors).

- [ ] **Step 7: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold qatest project"
```

---

## Task 2: Shared engine types

**Files:**
- Create: `src/engine/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// The role accounts each environment provides. Must match config + .env keys.
export type Role = 'admin' | 'researcher' | 'reviewer'

// Why these categories: a non-technical tester must be able to tell "the app has
// a bug" from "the tool/env is broken". See spec "Error handling & failure model".
export type FailureCategory =
    | 'app-assertion' // a real app bug — share the report
    | 'environment' // env down / 5xx / network — not a test failure
    | 'auth' // could not log in
    | 'cleanup' // run passed but cleanup failed — leftover data warning
    | 'tool-crash' // bug in the engine itself
    | 'ai-gave-up' // AI mode only: agent could not carry out the instruction

export type StepStatus = 'running' | 'passed' | 'failed'

export interface StepEvent {
    name: string
    status: StepStatus
    at: number // epoch ms
    screenshot?: string // path relative to the run bundle, set when captured
    error?: string
}

export type RunMode = 'suite' | 'exploratory'

export interface RunRequest {
    suite: string // suite name, or the plain-English instruction in exploratory mode
    env: string // environment name, e.g. "qa" | "staging"
    role: Role
    mode?: RunMode // defaults to 'suite'
}

export interface RunResult {
    ok: boolean
    failureCategory?: FailureCategory
    steps: StepEvent[]
    bundleDir: string // absolute path to the result bundle folder
    cleanup: { ok: boolean; deleted: string[]; failed: string[]; error?: string }
    env: string
    role: Role
    mode: RunMode
    startedAt: number
    finishedAt: number
}

// Resolved, secret-filled environment config handed to a run.
export interface EnvConfig {
    name: string
    baseURL: string
    accounts: Record<Role, { email: string; password: string }>
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/engine/types.ts && git commit -m "feat: engine shared types"
```

---

## Task 3: Environment config (committed declaration)

**Files:**
- Create: `config/environments.ts`

- [ ] **Step 1: Write the committed env declarations**

```typescript
import type { Role } from '@/engine/types'

// Committed declaration of which environments exist and which env-var holds each
// value. NO secrets here — only the *names* of the env vars to read from .env.
// resolveEnv() (Task 4) merges this with process.env.
export interface EnvDeclaration {
    name: string
    baseUrlVar: string
    accounts: Record<Role, { emailVar: string; passwordVar: string }>
}

export const ENVIRONMENTS: EnvDeclaration[] = [
    {
        name: 'qa',
        baseUrlVar: 'QA_BASE_URL',
        accounts: {
            admin: { emailVar: 'QA_ADMIN_EMAIL', passwordVar: 'QA_ADMIN_PASSWORD' },
            researcher: { emailVar: 'QA_RESEARCHER_EMAIL', passwordVar: 'QA_RESEARCHER_PASSWORD' },
            reviewer: { emailVar: 'QA_REVIEWER_EMAIL', passwordVar: 'QA_REVIEWER_PASSWORD' },
        },
    },
    {
        name: 'staging',
        baseUrlVar: 'STAGING_BASE_URL',
        accounts: {
            admin: { emailVar: 'STAGING_ADMIN_EMAIL', passwordVar: 'STAGING_ADMIN_PASSWORD' },
            researcher: { emailVar: 'STAGING_RESEARCHER_EMAIL', passwordVar: 'STAGING_RESEARCHER_PASSWORD' },
            reviewer: { emailVar: 'STAGING_REVIEWER_EMAIL', passwordVar: 'STAGING_REVIEWER_PASSWORD' },
        },
    },
]
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add config/environments.ts && git commit -m "feat: committed environment declarations"
```

---

## Task 4: resolveEnv — merge declaration + secrets

**Files:**
- Create: `src/engine/env.ts`
- Test: `tests/engine/env.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { resolveEnv } from '@/engine/env'

const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    QA_ADMIN_EMAIL: 'a+clerk_test@example.com',
    QA_ADMIN_PASSWORD: 'pw-a',
    QA_RESEARCHER_EMAIL: 'r+clerk_test@example.com',
    QA_RESEARCHER_PASSWORD: 'pw-r',
    QA_REVIEWER_EMAIL: 'v+clerk_test@example.com',
    QA_REVIEWER_PASSWORD: 'pw-v',
}

describe('resolveEnv', () => {
    it('merges the committed declaration with secret env vars', () => {
        const cfg = resolveEnv('qa', ENV_VARS)
        expect(cfg.name).toBe('qa')
        expect(cfg.baseURL).toBe('https://qa.example.com')
        expect(cfg.accounts.admin).toEqual({ email: 'a+clerk_test@example.com', password: 'pw-a' })
        expect(cfg.accounts.reviewer.email).toBe('v+clerk_test@example.com')
    })

    it('throws a clear error for an unknown environment', () => {
        expect(() => resolveEnv('nope', ENV_VARS)).toThrow(/unknown environment "nope"/i)
    })

    it('throws a clear error when a required secret is missing', () => {
        const incomplete = { ...ENV_VARS, QA_ADMIN_PASSWORD: '' }
        expect(() => resolveEnv('qa', incomplete)).toThrow(/QA_ADMIN_PASSWORD/)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/engine/env.test.ts`
Expected: FAIL — cannot find module `@/engine/env`.

- [ ] **Step 3: Write the implementation**

```typescript
import { ENVIRONMENTS } from '../../config/environments'
import type { EnvConfig, Role } from '@/engine/types'

type Vars = Record<string, string | undefined>

function read(vars: Vars, key: string): string {
    const value = vars[key]
    if (!value) throw new Error(`Missing required secret: ${key} (set it in .env)`)
    return value
}

// Merge the committed declaration (config/environments.ts) with secret values
// from `vars` (defaults to process.env). Throws clear, actionable errors so a QA
// run never starts half-configured.
export function resolveEnv(name: string, vars: Vars = process.env): EnvConfig {
    const decl = ENVIRONMENTS.find((e) => e.name === name)
    if (!decl) {
        const known = ENVIRONMENTS.map((e) => e.name).join(', ')
        throw new Error(`Unknown environment "${name}". Known environments: ${known}`)
    }
    const roles: Role[] = ['admin', 'researcher', 'reviewer']
    const accounts = {} as EnvConfig['accounts']
    for (const role of roles) {
        const a = decl.accounts[role]
        accounts[role] = { email: read(vars, a.emailVar), password: read(vars, a.passwordVar) }
    }
    return { name: decl.name, baseURL: read(vars, decl.baseUrlVar), accounts }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/engine/env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/env.ts tests/engine/env.test.ts && git commit -m "feat: resolveEnv merges config with secrets"
```

---

## Task 5: Cleanup client (id-tracked, PR #839 endpoints)

**Files:**
- Create: `src/engine/cleanup.ts`
- Test: `tests/engine/cleanup.test.ts`

**Context:** PR #839 exposes `DELETE /api/qa/users/[userId]` and `DELETE /api/qa/studies/[studyId]`, non-prod gated, authorized by the caller's SI-admin Clerk session. The engine tracks ids created during a run, then deletes exactly those on teardown. Authorization is the session cookies from the logged-in admin page; we pass them as a `Cookie` header.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { CleanupClient } from '@/engine/cleanup'

function fakeFetch(responses: Record<string, { status: number }>) {
    return vi.fn(async (url: string, _init?: RequestInit) => {
        const key = Object.keys(responses).find((k) => url.endsWith(k))
        const status = key ? responses[key].status : 500
        return { status, ok: status >= 200 && status < 300, json: async () => ({}) } as Response
    })
}

describe('CleanupClient', () => {
    it('deletes every tracked id and reports success', async () => {
        const fetchImpl = fakeFetch({
            '/api/qa/studies/study-1': { status: 200 },
            '/api/qa/users/user-1': { status: 200 },
        })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('study-1')
        client.trackUser('user-1')

        const result = await client.run()

        expect(result.ok).toBe(true)
        expect(result.deleted.sort()).toEqual(['study:study-1', 'user:user-1'])
        expect(result.failed).toEqual([])
        // Studies deleted before users (a study FK references its owner user).
        expect((fetchImpl.mock.calls[0][0] as string)).toContain('/api/qa/studies/study-1')
    })

    it('marks ok=false and records failures when a delete returns non-2xx', async () => {
        const fetchImpl = fakeFetch({ '/api/qa/studies/study-1': { status: 500 } })
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        client.trackStudy('study-1')

        const result = await client.run()

        expect(result.ok).toBe(false)
        expect(result.failed).toEqual(['study:study-1'])
    })

    it('is a no-op (ok=true) when nothing was tracked', async () => {
        const fetchImpl = fakeFetch({})
        const client = new CleanupClient('https://qa.example.com', 'sid=abc', fetchImpl)
        const result = await client.run()
        expect(result).toEqual({ ok: true, deleted: [], failed: [] })
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/engine/cleanup.test.ts`
Expected: FAIL — cannot find module `@/engine/cleanup`.

- [ ] **Step 3: Write the implementation**

```typescript
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface CleanupResult {
    ok: boolean
    deleted: string[]
    failed: string[]
    error?: string
}

// Tracks the ids a run creates and deletes them via the management-app QA
// endpoints (PR #839). Authorization is the admin session cookie string passed
// in; the endpoints verify isSiAdmin. Studies are deleted before users because a
// study's owner FK references the user.
export class CleanupClient {
    private studies: string[] = []
    private users: string[] = []

    constructor(
        private baseURL: string,
        private cookieHeader: string,
        private fetchImpl: FetchImpl = fetch,
    ) {}

    trackStudy(id: string) {
        this.studies.push(id)
    }

    trackUser(id: string) {
        this.users.push(id)
    }

    private async del(path: string): Promise<boolean> {
        const res = await this.fetchImpl(`${this.baseURL}${path}`, {
            method: 'DELETE',
            headers: { Cookie: this.cookieHeader },
        })
        return res.ok
    }

    async run(): Promise<CleanupResult> {
        const deleted: string[] = []
        const failed: string[] = []
        // Studies first (FK ordering), then users.
        for (const id of this.studies) {
            const ok = await this.del(`/api/qa/studies/${id}`)
            ;(ok ? deleted : failed).push(`study:${id}`)
        }
        for (const id of this.users) {
            const ok = await this.del(`/api/qa/users/${id}`)
            ;(ok ? deleted : failed).push(`user:${id}`)
        }
        return { ok: failed.length === 0, deleted, failed }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/engine/cleanup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/cleanup.ts tests/engine/cleanup.test.ts && git commit -m "feat: id-tracked cleanup client for QA endpoints"
```

---

## Task 6: Recorder (step events + result bundle)

**Files:**
- Create: `src/engine/recorder.ts`
- Test: `tests/engine/recorder.test.ts`

**Context:** The recorder owns step-event emission and writing the result bundle (`summary.json`, `report.html`, screenshots dir). Playwright owns video/screenshot *capture* (configured in Task 7's context); the recorder records *where* those artifacts are and assembles the bundle. Keep it I/O-only and Playwright-free so it is unit-testable without a browser.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Recorder } from '@/engine/recorder'

const made: string[] = []
afterEach(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    made.length = 0
})

function tmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qatest-'))
    made.push(dir)
    return dir
}

describe('Recorder', () => {
    it('records step events and writes a summary.json + report.html bundle', async () => {
        const root = tmpRoot()
        const rec = new Recorder({ root, suite: 'signin', env: 'qa', role: 'admin', mode: 'suite', startedAt: 1000 })

        rec.step('Logged in', 'passed')
        rec.step('Opened dashboard', 'failed', { error: 'not visible' })

        const result = rec.finish({ ok: false, failureCategory: 'app-assertion', cleanup: { ok: true, deleted: [], failed: [] } })

        expect(fs.existsSync(path.join(result.bundleDir, 'summary.json'))).toBe(true)
        expect(fs.existsSync(path.join(result.bundleDir, 'report.html'))).toBe(true)
        const summary = JSON.parse(fs.readFileSync(path.join(result.bundleDir, 'summary.json'), 'utf8'))
        expect(summary.ok).toBe(false)
        expect(summary.failureCategory).toBe('app-assertion')
        expect(summary.steps).toHaveLength(2)
        expect(summary.steps[1].status).toBe('failed')
    })

    it('streams step events to an optional listener as they happen', () => {
        const root = tmpRoot()
        const seen: string[] = []
        const rec = new Recorder(
            { root, suite: 's', env: 'qa', role: 'admin', mode: 'suite', startedAt: 1 },
            (e) => seen.push(`${e.name}:${e.status}`),
        )
        rec.step('A', 'running')
        rec.step('A', 'passed')
        expect(seen).toEqual(['A:running', 'A:passed'])
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/engine/recorder.test.ts`
Expected: FAIL — cannot find module `@/engine/recorder`.

- [ ] **Step 3: Write the implementation**

```typescript
import fs from 'node:fs'
import path from 'node:path'
import type { RunMode, Role, StepEvent, StepStatus, FailureCategory, RunResult } from '@/engine/types'

export interface RecorderInit {
    root: string // base results dir, e.g. <repo>/results
    suite: string
    env: string
    role: Role
    mode: RunMode
    startedAt: number
}

type FinishInput = {
    ok: boolean
    failureCategory?: FailureCategory
    cleanup: RunResult['cleanup']
}

type Listener = (event: StepEvent) => void

// Owns step events + bundle assembly. Playwright captures video/screenshots into
// `screenshots/` and `video.webm` under bundleDir (wired in run.ts); this class
// records the step timeline and writes summary.json + report.html.
export class Recorder {
    readonly bundleDir: string
    private steps: StepEvent[] = []

    constructor(
        private init: RecorderInit,
        private listener?: Listener,
    ) {
        const stamp = stampFor(init.startedAt)
        this.bundleDir = path.join(init.root, `${stamp}_${init.suite}_${init.env}`)
        fs.mkdirSync(path.join(this.bundleDir, 'screenshots'), { recursive: true })
    }

    step(name: string, status: StepStatus, extra?: { error?: string; screenshot?: string }) {
        const event: StepEvent = { name, status, at: nowOr(this.init.startedAt), ...extra }
        // Replace the prior 'running' entry for the same step name when it resolves.
        const idx = this.steps.findIndex((s) => s.name === name && s.status === 'running')
        if (idx >= 0 && status !== 'running') this.steps[idx] = event
        else this.steps.push(event)
        this.listener?.(event)
    }

    finish(input: FinishInput): RunResult {
        const finishedAt = nowOr(this.init.startedAt)
        const result: RunResult = {
            ok: input.ok,
            failureCategory: input.failureCategory,
            steps: this.steps,
            bundleDir: this.bundleDir,
            cleanup: input.cleanup,
            env: this.init.env,
            role: this.init.role,
            mode: this.init.mode,
            startedAt: this.init.startedAt,
            finishedAt,
        }
        fs.writeFileSync(path.join(this.bundleDir, 'summary.json'), JSON.stringify(result, null, 2))
        fs.writeFileSync(path.join(this.bundleDir, 'report.html'), renderReport(result))
        return result
    }
}

function nowOr(fallback: number): number {
    // Date.now is fine in the engine runtime; tests pass a fixed startedAt and
    // only assert structure/order, not timestamps.
    return Date.now() || fallback
}

function stampFor(epoch: number): string {
    const d = new Date(epoch)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function renderReport(r: RunResult): string {
    const rows = r.steps
        .map((s) => `<li class="${s.status}">${s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '…'} ${escapeHtml(s.name)}${s.error ? ` — <em>${escapeHtml(s.error)}</em>` : ''}</li>`)
        .join('\n')
    const banner = r.ok ? 'PASSED' : `FAILED (${r.failureCategory ?? 'unknown'})`
    const cleanupWarn = r.cleanup.ok ? '' : `<p class="warn">⚠ Cleanup failed: ${r.cleanup.failed.join(', ')} — leftover data may need manual removal.</p>`
    return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(r.suite ?? '')} ${r.env}</title>
<style>body{font:14px system-ui;margin:2rem}.passed{color:#137333}.failed{color:#c5221f}.warn{color:#b06000}video{max-width:100%}</style>
<h1>${banner}</h1><p>${r.env} · ${r.role} · ${r.mode}</p>${cleanupWarn}
<ul>${rows}</ul>
<video src="video.webm" controls></video>`
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
```

Note: `renderReport` reads `r.suite`, which is not on `RunResult`. Add `suite: string` to `RunResult` in `src/engine/types.ts` now (it belongs there for the report and CLI), and set it in `finish` from `this.init.suite`.

- [ ] **Step 4: Add `suite` to RunResult and set it in finish**

In `src/engine/types.ts`, add to the `RunResult` interface (after `mode: RunMode`):

```typescript
    suite: string
```

In `src/engine/recorder.ts` `finish`, add to the `result` object (after `mode: this.init.mode,`):

```typescript
            suite: this.init.suite,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/engine/recorder.test.ts && pnpm typecheck`
Expected: PASS (2 tests); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/recorder.ts src/engine/types.ts tests/engine/recorder.test.ts && git commit -m "feat: recorder writes step timeline + result bundle"
```

---

## Task 7: Auth module (Clerk testing-mode login)

**Files:**
- Create: `src/engine/auth.ts`

**Context:** Real Clerk on QA/staging with testing mode. `@clerk/testing` provides `clerkSetup` (injects testing token) and `setupClerkTestingToken(page)`. We log in by driving the sign-in form with a `+clerk_test` email + password, then entering the fixed OTP `424242` if an MFA/code step appears. The real form shape (from management-app `tests/signin.spec.ts`): email field → password field → "login" button → optional "SMS Verification" → PIN input. This module is browser-driving glue, validated by the live smoke run in Task 11 (not a vitest unit — it needs a real browser + real Clerk).

- [ ] **Step 1: Write the implementation**

```typescript
import { setupClerkTestingToken } from '@clerk/testing/playwright'
import type { Page } from '@playwright/test'
import type { EnvConfig, Role } from '@/engine/types'

export const CLERK_TEST_OTP = '424242'

export class AuthError extends Error {}

// Logs `page` into the live app as `role` using Clerk testing mode. Returns the
// session cookie header string (used by the cleanup client to authorize
// DELETE calls as this user). Throws AuthError on failure so run.ts can
// categorize it as 'auth'.
export async function loginAs(page: Page, env: EnvConfig, role: Role): Promise<string> {
    const account = env.accounts[role]
    await setupClerkTestingToken({ page })

    try {
        await page.goto(`${env.baseURL}/account/signin`, { waitUntil: 'domcontentloaded' })
        await page.getByLabel('email').fill(account.email)
        await page.getByLabel('password').fill(account.password)
        await page.getByRole('button', { name: 'login' }).click()

        // Optional MFA step: present for accounts with SMS MFA enabled. With Clerk
        // testing mode the code is the fixed test OTP.
        const smsButton = page.getByRole('button', { name: 'SMS Verification' })
        if (await smsButton.isVisible({ timeout: 5000 }).catch(() => false)) {
            await smsButton.click()
            await fillPin(page, CLERK_TEST_OTP)
            await page.getByRole('button', { name: /verify code/i }).click()
        }

        // Landing on a dashboard confirms an authenticated session.
        await page.locator('text=dashboard').first().waitFor({ state: 'visible', timeout: 30_000 })
    } catch (cause) {
        throw new AuthError(`Could not log in as ${role} on ${env.name}: ${(cause as Error).message}`)
    }

    const cookies = await page.context().cookies()
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

async function fillPin(page: Page, code: string): Promise<void> {
    // Mirror management-app's fillPinInput: prefer the test-id group, fall back to
    // the role=group placeholder inputs.
    let inputs = page.getByTestId('sms-pin-input').locator('input')
    if ((await inputs.count()) === 0) {
        inputs = page.locator('[role="group"]').locator('input[placeholder="0"]')
    }
    const digits = code.split('')
    for (let i = 0; i < digits.length; i++) {
        await inputs.nth(i).fill(digits[i])
    }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: exits 0. (No unit test — auth is browser glue, smoke-tested live in Task 11.)

- [ ] **Step 3: Commit**

```bash
git add src/engine/auth.ts && git commit -m "feat: Clerk testing-mode login (auth module)"
```

---

## Task 8: Suite interface + RunContext

**Files:**
- Create: `src/suites/types.ts`

**Context:** A suite is a named flow that receives a `RunContext` — the authenticated page, a `step()` helper that emits events, a `tag` for unique titles, and `track*` hooks so anything it creates gets cleaned up. Suites never touch env/auth/cleanup directly; the engine wires those in.

- [ ] **Step 1: Write the interface**

```typescript
import type { Page } from '@playwright/test'
import type { Role, StepStatus } from '@/engine/types'

export interface RunContext {
    page: Page
    baseURL: string
    // Unique-per-run suffix for any titles the suite creates (human-readable +
    // collision-free), mirroring management-app's uniqueTitle pattern.
    tag: string
    // Emit a step event. Wrap an action: await step('Create study', () => ...).
    step<T>(name: string, action: () => Promise<T>): Promise<T>
    // Register ids for guaranteed id-based cleanup (Task 5).
    trackStudy(id: string): void
    trackUser(id: string): void
}

export interface Suite {
    name: string
    description: string
    roles: Role[] // which role(s) this suite is meant to run as
    run(ctx: RunContext): Promise<void>
}

export type StepReporter = (name: string, status: StepStatus, extra?: { error?: string }) => void
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/suites/types.ts && git commit -m "feat: suite interface + run context"
```

---

## Task 9: Suite registry

**Files:**
- Create: `src/engine/suite-registry.ts`
- Create: `src/suites/signin.ts`
- Test: `tests/engine/suite-registry.test.ts`

**Context:** A static registry so the CLI/GUI can list suites and the engine can load one by name. Start with a real `signin` suite (smallest meaningful flow — it creates no data, so it exercises the happy path without needing cleanup).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { listSuites, getSuite } from '@/engine/suite-registry'

describe('suite-registry', () => {
    it('lists available suites with name + description', () => {
        const names = listSuites().map((s) => s.name)
        expect(names).toContain('signin')
    })

    it('returns a suite by name', () => {
        const suite = getSuite('signin')
        expect(suite.name).toBe('signin')
        expect(typeof suite.run).toBe('function')
    })

    it('throws a clear error for an unknown suite', () => {
        expect(() => getSuite('nope')).toThrow(/unknown suite "nope"/i)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/engine/suite-registry.test.ts`
Expected: FAIL — cannot find module `@/engine/suite-registry`.

- [ ] **Step 3: Write the signin suite**

```typescript
import type { Suite } from '@/suites/types'

// Smallest meaningful suite: confirms an authenticated session reaches the
// dashboard. Creates no data, so cleanup is a no-op for this suite.
export const signinSuite: Suite = {
    name: 'signin',
    description: 'Sign in and confirm the dashboard loads',
    roles: ['admin', 'researcher', 'reviewer'],
    async run(ctx) {
        // Login already happened in the engine; just verify the landing state.
        await ctx.step('Confirm dashboard is visible', async () => {
            await ctx.page.locator('text=dashboard').first().waitFor({ state: 'visible' })
        })
    },
}
```

- [ ] **Step 4: Write the registry**

```typescript
import type { Suite } from '@/suites/types'
import { signinSuite } from '@/suites/signin'

const SUITES: Suite[] = [signinSuite]

export function listSuites(): { name: string; description: string }[] {
    return SUITES.map((s) => ({ name: s.name, description: s.description }))
}

export function getSuite(name: string): Suite {
    const suite = SUITES.find((s) => s.name === name)
    if (!suite) {
        const known = SUITES.map((s) => s.name).join(', ')
        throw new Error(`Unknown suite "${name}". Known suites: ${known}`)
    }
    return suite
}

export { SUITES }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/engine/suite-registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/engine/suite-registry.ts src/suites/signin.ts tests/engine/suite-registry.test.ts && git commit -m "feat: suite registry + signin suite"
```

---

## Task 10: runEngine — the orchestration spine

**Files:**
- Create: `src/engine/run.ts`
- Test: `tests/engine/run.test.ts`

**Context:** This wires everything: resolve env → launch browser → login → build RunContext → run suite → guaranteed cleanup → finish bundle. The hard correctness rule (spec): **cleanup always fires** (pass/fail/crash) and failures are **categorized**. To unit-test the orchestration logic without a real browser/Clerk, runEngine takes injectable dependencies (`deps`) with production defaults.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runEngine } from '@/engine/run'
import type { Suite } from '@/suites/types'

const made: string[] = []
afterEach(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    made.length = 0
})
function tmpRoot() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qatest-run-'))
    made.push(d)
    return d
}

const ENV_VARS = {
    QA_BASE_URL: 'https://qa.example.com',
    QA_ADMIN_EMAIL: 'a@example.com', QA_ADMIN_PASSWORD: 'p',
    QA_RESEARCHER_EMAIL: 'r@example.com', QA_RESEARCHER_PASSWORD: 'p',
    QA_REVIEWER_EMAIL: 'v@example.com', QA_REVIEWER_PASSWORD: 'p',
}

function deps(overrides: Partial<Parameters<typeof runEngine>[1]> = {}) {
    return {
        vars: ENV_VARS,
        resultsRoot: tmpRoot(),
        openBrowser: vi.fn(async () => ({
            page: {} as never,
            cookieHeader: 'sid=abc',
            close: vi.fn(async () => {}),
        })),
        login: vi.fn(async () => 'sid=abc'),
        runCleanup: vi.fn(async () => ({ ok: true, deleted: [], failed: [] })),
        ...overrides,
    }
}

const passingSuite: Suite = {
    name: 'demo', description: '', roles: ['admin'],
    async run(ctx) { await ctx.step('do thing', async () => {}) },
}

describe('runEngine', () => {
    it('runs a passing suite and writes an ok bundle', async () => {
        const d = deps()
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true)
        expect(d.runCleanup).toHaveBeenCalledOnce()
        expect(fs.existsSync(path.join(result.bundleDir, 'summary.json'))).toBe(true)
    })

    it('categorizes a thrown assertion as app-assertion and STILL runs cleanup', async () => {
        const d = deps()
        const failingSuite: Suite = {
            name: 'demo', description: '', roles: ['admin'],
            async run(ctx) { await ctx.step('boom', async () => { throw new Error('expected X to be visible') }) },
        }
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, failingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('app-assertion')
        expect(d.runCleanup).toHaveBeenCalledOnce() // guaranteed teardown
    })

    it('categorizes login failure as auth and still runs cleanup', async () => {
        const d = deps({ login: vi.fn(async () => { throw new Error('OTP rejected') }) })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(false)
        expect(result.failureCategory).toBe('auth')
        expect(d.runCleanup).toHaveBeenCalledOnce()
    })

    it('surfaces a cleanup failure on an otherwise-passing run', async () => {
        const d = deps({ runCleanup: vi.fn(async () => ({ ok: false, deleted: [], failed: ['study:s1'] })) })
        const result = await runEngine({ suite: 'demo', env: 'qa', role: 'admin' }, d, passingSuite)
        expect(result.ok).toBe(true) // the test itself passed
        expect(result.cleanup.ok).toBe(false)
        expect(result.cleanup.failed).toEqual(['study:s1'])
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/engine/run.test.ts`
Expected: FAIL — cannot find module `@/engine/run`.

- [ ] **Step 3: Write the implementation**

```typescript
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEnv } from '@/engine/env'
import { Recorder } from '@/engine/recorder'
import { CleanupClient } from '@/engine/cleanup'
import { getSuite } from '@/engine/suite-registry'
import { loginAs, AuthError } from '@/engine/auth'
import type { RunRequest, RunResult, StepEvent, FailureCategory } from '@/engine/types'
import type { Suite, RunContext } from '@/suites/types'

export interface BrowserHandle {
    page: import('@playwright/test').Page
    cookieHeader: string
    close: () => Promise<void>
}

// Injectable dependencies — production defaults below; tests pass fakes.
export interface RunDeps {
    vars: Record<string, string | undefined>
    resultsRoot: string
    openBrowser: (env: { name: string; baseURL: string }) => Promise<BrowserHandle>
    login: (handle: BrowserHandle, env: ReturnType<typeof resolveEnv>, role: RunRequest['role']) => Promise<string>
    runCleanup: (client: CleanupClient) => Promise<RunResult['cleanup']>
}

function categorize(error: Error): FailureCategory {
    if (error instanceof AuthError) return 'auth'
    const m = error.message.toLowerCase()
    if (m.includes('econnrefused') || m.includes('net::') || m.includes('timeout') || m.includes('5xx')) return 'environment'
    // A failed web-first assertion / visibility wait reads as a real app issue.
    if (m.includes('visible') || m.includes('expect') || m.includes('tobe')) return 'app-assertion'
    return 'tool-crash'
}

export async function runEngine(req: RunRequest, deps: RunDeps, suiteOverride?: Suite): Promise<RunResult> {
    const startedAt = Date.now()
    const mode = req.mode ?? 'suite'
    const env = resolveEnv(req.env, deps.vars)
    const suite = suiteOverride ?? getSuite(req.suite)

    const events: StepEvent[] = []
    const recorder = new Recorder(
        { root: deps.resultsRoot, suite: suite.name, env: env.name, role: req.role, mode, startedAt },
        (e) => events.push(e),
    )

    const cleanup = new CleanupClient(env.baseURL, '')
    const tag = `qa-${suite.name}-${startedAt}`

    let ok = true
    let failureCategory: FailureCategory | undefined
    let handle: BrowserHandle | undefined

    try {
        handle = await deps.openBrowser({ name: env.name, baseURL: env.baseURL })
        const cookieHeader = await deps.login(handle, env, req.role)
        // The cleanup client authorizes via the admin session cookie.
        ;(cleanup as unknown as { cookieHeader: string }).cookieHeader = cookieHeader

        const ctx: RunContext = {
            page: handle.page,
            baseURL: env.baseURL,
            tag,
            async step(name, action) {
                recorder.step(name, 'running')
                try {
                    const out = await action()
                    recorder.step(name, 'passed')
                    return out
                } catch (cause) {
                    recorder.step(name, 'failed', { error: (cause as Error).message })
                    throw cause
                }
            },
            trackStudy: (id) => cleanup.trackStudy(id),
            trackUser: (id) => cleanup.trackUser(id),
        }

        await suite.run(ctx)
    } catch (cause) {
        ok = false
        failureCategory = categorize(cause as Error)
    } finally {
        // Guaranteed teardown: cleanup runs no matter how we got here.
        var cleanupResult = await deps.runCleanup(cleanup).catch((e): RunResult['cleanup'] => ({
            ok: false,
            deleted: [],
            failed: ['cleanup-call-threw'],
            error: (e as Error).message,
        }))
        await handle?.close().catch(() => {})
    }

    return recorder.finish({ ok, failureCategory, cleanup: cleanupResult! })
}

// --- Production default deps ---

export function defaultDeps(): RunDeps {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const resultsRoot = path.resolve(here, '../../results')
    return {
        vars: process.env,
        resultsRoot,
        openBrowser: async (env) => {
            const { chromium } = await import('@playwright/test')
            const browser = await chromium.launch()
            const context = await browser.newContext({
                baseURL: env.baseURL,
                recordVideo: { dir: resultsRoot }, // moved into bundle after finish
            })
            const page = await context.newPage()
            return {
                page,
                cookieHeader: '',
                close: async () => {
                    await context.close()
                    await browser.close()
                },
            }
        },
        login: async (handle, env, role) => loginAs(handle.page, env, role),
        runCleanup: async (client) => client.run(),
    }
}
```

Note on `var cleanupResult`: it is intentionally function-scoped so the `return` after `finally` can read it. If your linter forbids `var`, declare `let cleanupResult: RunResult['cleanup']` above the `try` and assign in `finally` instead.

- [ ] **Step 4: Resolve the `var`/lint concern cleanly**

Replace the `var cleanupResult = ...` pattern with a hoisted `let`:

In `src/engine/run.ts`, before the `try`, add:
```typescript
    let cleanupResult: RunResult['cleanup'] = { ok: true, deleted: [], failed: [] }
```
and in `finally` change `var cleanupResult = await ...` to `cleanupResult = await ...`, and change the final return to `cleanup: cleanupResult`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/engine/run.test.ts && pnpm typecheck`
Expected: PASS (4 tests); typecheck exits 0.

- [ ] **Step 6: Run the full unit suite**

Run: `pnpm test`
Expected: all engine tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/engine/run.ts tests/engine/run.test.ts && git commit -m "feat: runEngine orchestration with guaranteed cleanup + failure categorization"
```

---

## Task 11: CLI shell (interactive)

**Files:**
- Create: `src/cli/index.ts`

**Context:** A dead-simple interactive menu (no flags to memorize) for non-technical use: pick env → pick role → pick suite → run → print result + bundle path. Uses Node's built-in `readline`, no extra deps.

- [ ] **Step 1: Write the CLI**

```typescript
import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { ENVIRONMENTS } from '../../config/environments'
import { listSuites } from '@/engine/suite-registry'
import { runEngine, defaultDeps } from '@/engine/run'
import type { Role } from '@/engine/types'

const ROLES: Role[] = ['admin', 'researcher', 'reviewer']

async function pick(rl: readline.Interface, label: string, options: string[]): Promise<string> {
    console.log(`\n${label}:`)
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`))
    while (true) {
        const answer = await rl.question('> ')
        const idx = Number(answer) - 1
        if (idx >= 0 && idx < options.length) return options[idx]
        console.log('Please enter a number from the list.')
    }
}

async function main() {
    const rl = readline.createInterface({ input, output })
    try {
        const env = await pick(rl, 'Environment', ENVIRONMENTS.map((e) => e.name))
        const role = (await pick(rl, 'Role', ROLES)) as Role
        const suites = listSuites()
        const suite = await pick(rl, 'Suite', suites.map((s) => `${s.name} — ${s.description}`))
        const suiteName = suite.split(' — ')[0]

        console.log(`\nRunning "${suiteName}" as ${role} on ${env}...\n`)
        const deps = defaultDeps()
        const result = await runEngine({ suite: suiteName, env, role }, deps)

        console.log('\n--- Result ---')
        for (const s of result.steps) {
            const mark = s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '…'
            console.log(`${mark} ${s.name}${s.error ? ` (${s.error})` : ''}`)
        }
        console.log(result.ok ? '\nPASSED' : `\nFAILED — ${result.failureCategory}`)
        if (!result.cleanup.ok) console.log(`⚠ Cleanup failed: ${result.cleanup.failed.join(', ')}`)
        console.log(`\nReport: ${result.bundleDir}/report.html`)
    } finally {
        rl.close()
    }
}

main().catch((e) => {
    console.error('Error:', e.message)
    process.exit(1)
})
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Smoke-test the menu without a real run**

Run: `printf '1\n1\n1\n' | pnpm qa` *(only if a `.env` with QA creds + a reachable QA env exists; otherwise it will fail at login — that is expected without real config).*
Expected: the menu prints Environment/Role/Suite prompts. (A full pass requires real `.env` + reachable QA — that is the live validation below.)

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts && git commit -m "feat: interactive CLI shell"
```

---

## Task 12: Live validation against a real environment

**Files:** none (validation task)

**Context:** This is the end-to-end proof. Requires a real `.env` (Task 1) with working `+clerk_test` accounts on a reachable QA environment, and that the QA cleanup API (PR #839) is deployed there.

- [ ] **Step 1: Install Playwright's browser**

Run: `pnpm exec playwright install chromium`
Expected: Chromium downloads.

- [ ] **Step 2: Run the signin suite live as admin on QA**

Run: `printf '1\n1\n1\n' | pnpm qa` (env=qa, role=admin, suite=signin)
Expected: steps print with ✓, final `PASSED`, a `results/<stamp>_signin_qa/` bundle exists with `report.html`, `video.webm`, and `summary.json`.

- [ ] **Step 3: Verify the bundle**

Run: `ls results/*/ && open results/*_signin_qa/report.html` (macOS)
Expected: report shows the step list and an embedded, playable video — confirming always-on recording.

- [ ] **Step 4: If login fails, confirm Clerk testing mode**

If step 2 fails with an auth error, verify the QA Clerk instance has testing mode enabled and the account email uses the `+clerk_test` convention with OTP `424242`. Fix the `.env` / Clerk config (this is the "test-account inventory" open question from the spec), then re-run.

- [ ] **Step 5: Commit any config fixes**

```bash
git add -A && git commit -m "chore: validated signin suite against live QA"
```

---

## Task 13: Create-study suite (exercises real cleanup)

**Files:**
- Create: `src/suites/create-study.ts`
- Modify: `src/engine/suite-registry.ts` (register it)

**Context:** The first suite that *creates data*, so it proves the id-tracked cleanup loop end to end: create a study → capture its id → `ctx.trackStudy(id)` → run finishes → cleanup deletes it via `DELETE /api/qa/studies/[id]`. The exact selectors/URL for study creation must be read from the live app / management-app source at implementation time — the structure below is fixed; the selectors are marked where they need confirming.

- [ ] **Step 1: Write the suite (confirm selectors against the live app)**

```typescript
import type { Suite } from '@/suites/types'

// Creates a study, registers its id for cleanup, and confirms it appears in the
// list. SELECTORS marked CONFIRM must be checked against the live Management App
// (or management-app src) before this runs green — keep the structure, fix the
// locators.
export const createStudySuite: Suite = {
    name: 'create-study',
    description: 'Create a study and confirm it appears, then clean it up',
    roles: ['researcher'],
    async run(ctx) {
        const title = `QA Test Study ${ctx.tag}`

        await ctx.step('Open new-study page', async () => {
            // CONFIRM: real route for new study (read from management-app routes).
            await ctx.page.goto(`${ctx.baseURL}/studies/new`, { waitUntil: 'domcontentloaded' })
        })

        const studyId = await ctx.step('Create the study', async () => {
            // CONFIRM: form field labels + submit button name.
            await ctx.page.getByLabel('title').fill(title)
            await ctx.page.getByRole('button', { name: /create|submit/i }).click()
            // CONFIRM: how the new study id surfaces (URL segment after redirect is
            // the typical case for this app).
            await ctx.page.waitForURL(/\/studies\/[a-f0-9-]+/i)
            const match = ctx.page.url().match(/\/studies\/([a-f0-9-]+)/i)
            if (!match) throw new Error('Could not determine created study id from URL')
            return match[1]
        })

        // Register for guaranteed cleanup BEFORE any later assertion can throw.
        ctx.trackStudy(studyId)

        await ctx.step('Confirm the study title is shown', async () => {
            await ctx.page.locator(`text=${title}`).first().waitFor({ state: 'visible' })
        })
    },
}
```

- [ ] **Step 2: Register the suite**

In `src/engine/suite-registry.ts`, update the imports and `SUITES` array:

```typescript
import { signinSuite } from '@/suites/signin'
import { createStudySuite } from '@/suites/create-study'

const SUITES: Suite[] = [signinSuite, createStudySuite]
```

- [ ] **Step 3: Update the registry test**

In `tests/engine/suite-registry.test.ts`, extend the first test:

```typescript
    it('lists available suites with name + description', () => {
        const names = listSuites().map((s) => s.name)
        expect(names).toContain('signin')
        expect(names).toContain('create-study')
    })
```

- [ ] **Step 4: Run unit tests**

Run: `pnpm test tests/engine/suite-registry.test.ts && pnpm typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Live-validate create + cleanup as researcher on QA**

Run: `printf '1\n2\n2\n' | pnpm qa` (env=qa, role=researcher, suite=create-study)
Expected: PASSED; the report shows the created study; `summary.json` `cleanup.deleted` contains `study:<id>`. Confirm in the app the study no longer exists.

> Cleanup authorization note: the cleanup endpoints require an **SI admin** session, but this suite runs as **researcher**. Confirm during this task whether the researcher account is also an SI admin on QA. If not, adjust `runEngine` to obtain an admin session for the cleanup calls (open a second context, log in as admin, use that cookie for `CleanupClient`). Capture the chosen approach and, if needed, add a follow-up task. This is the one real integration unknown; verify it here.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: create-study suite with id-tracked cleanup, validated on QA"
```

---

## Task 14: Scaffold later-phase shells (GUI + AI skill) as documented stubs

**Files:**
- Create: `gui/README.md`
- Create: `.claude/skills/qa-explore/README.md`

**Context:** v1 ships engine + CLI. The Tauri GUI and the Claude Code `qa-explore` skill are deliberately deferred (spec: later phases). Leave precise, committed pointers so the next plan starts from a known boundary — not code stubs that rot.

- [ ] **Step 1: Write `gui/README.md`**

```markdown
# Desktop GUI (Tauri) — later phase

Thin Tauri shell over the engine. It must NOT contain test logic — it calls the
same `runEngine` the CLI uses and renders streamed `StepEvent`s + the result
bundle.

## Planned scope
- Dropdowns: environment, role, suite (from `listSuites()` / `ENVIRONMENTS`).
- "Run" button → spawns the Node engine, streams step events into a live checklist.
- "Exploratory" tab → text box → invokes the `qa-explore` Claude Code skill
  headlessly (`claude -p`) and renders the same result bundle.
- Embeds `report.html` / `video.webm` from the run bundle.

## Open items (resolve in the GUI plan)
- Engine ↔ GUI transport for live step events (stdout JSON lines vs. IPC).
- `claude -p` invocation + step-event streaming contract.
```

- [ ] **Step 2: Write `.claude/skills/qa-explore/README.md`**

```markdown
# qa-explore skill — later phase

Plain-English exploratory mode. Borrows the engine's deterministic spine
(env resolution, Clerk-testing-mode login, recording, guaranteed cleanup) and
owns ONLY the "figure out how to do this in the browser" part, driving the
browser via Playwright MCP / chrome-devtools MCP.

## Contract (to implement in the skill plan)
- Input: plain-English instruction + env + role.
- Calls the engine for: resolveEnv, loginAs, Recorder, CleanupClient teardown.
- Emits the same `StepEvent`s + writes the same result bundle as a curated suite.
- Marks results `mode: 'exploratory'` and uses the `ai-gave-up` failure category
  when it cannot carry out the instruction.

## Why a skill
Runs through existing Claude Code accounts — no separate AI API keys/billing in
this tool.
```

- [ ] **Step 3: Commit**

```bash
git add gui/README.md .claude/skills/qa-explore/README.md && git commit -m "docs: scaffold GUI + qa-explore skill as deferred phases"
```

---

## Self-Review notes (resolved during writing)

- **Spec coverage:** env config (T3–4), Clerk-testing auth (T7), recorder/always-on recording (T6), id-based cleanup via PR #839 (T5), guaranteed teardown + failure categories (T10), suites (T9, T13), CLI shell (T11), GUI + AI skill deferred with documented boundaries (T14). Live proof of recording + cleanup (T12, T13).
- **Spec correction propagated:** cleanup is **id-based** (not tag-based) and authorized by the **admin Clerk session**, not a separate secret — reflected in T5, T10, and the T13 authorization note (the one genuine integration unknown, verified live).
- **Type consistency:** `Role`, `RunResult` (incl. added `suite`), `StepEvent`, `RunContext`, `FailureCategory`, `CleanupResult` names are used consistently across tasks. `runEngine(req, deps, suiteOverride?)` signature matches its test.
- **No placeholders:** the only "CONFIRM" markers (T13 selectors) are explicitly flagged as live-app facts to verify during that task, not vague TODOs — the task structure and cleanup wiring around them are fully specified.

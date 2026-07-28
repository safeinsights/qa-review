# Signup Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `signup` QA suite that, as admin, invites two new users (researcher + reviewer), catches each invite email via the free mail.tm API, completes each signup, verifies the role-appropriate dashboard, and deletes both users via the QA cleanup API — after first fixing a latent `loginAs` account-switch bug the suite depends on.

**Architecture:** Two phases. **Phase 0** fixes `src/engine/auth.ts` so `loginAs` (a) forces a real logout past Clerk's "already signed in" interstitial and (b) asserts the signed-in account matches the requested role (fail loudly otherwise) — the current code can silently stay on the previous account, which is why `study-happy-path` cleanup never actually deletes. **Phase 1** adds `src/engine/mailtm.ts` (a typed mail.tm client) and `src/suites/signup.ts` (the suite), reusing the existing `CleanupClient` + `ctx.trackUser` + the Clerk session token the engine already captures.

**Tech Stack:** TypeScript, Playwright (via `RunContext`), vitest (engine unit tests only; suites run via the CLI), mail.tm REST API, Biome (4-space, single quotes, no semicolons, 100-col).

**Spec:** `docs/superpowers/specs/2026-07-24-signup-suite-design.md`

---

## Reference: verified mail.tm API shapes (2026-07-24, live)

- `GET https://api.mail.tm/domains` → `{ "hydra:member": [{ "domain": "web-library.net", "isActive": true }] }`
- `POST /accounts` body `{address, password}` → `201` `{ "id": "...", "address": "..." }`
- `POST /token` body `{address, password}` → `200` `{ "token": "<jwt>", "id": "..." }`
- `GET /messages` (header `Authorization: Bearer <token>`) → `{ "hydra:member": [{ "id": "...", "subject": "...", "from": {"address": "..."}, "intro": "..." }] }`
- `GET /messages/{id}` (bearer) → full message incl. `text: string` and `html: string[]`
- `DELETE /accounts/{id}` (bearer) → `204`
- **`+` is rejected in addresses** (`422`) — so each invited user gets its own freshly-created account. Rate limit 8 QPS/IP.

---

## File Structure

- **Modify** `src/engine/auth.ts` — Phase 0: interstitial handling + identity assertion in `loginAs`.
- **Create** `src/engine/mailtm.ts` — Phase 1: mail.tm client (`activeDomain`, `createInbox`, `waitForMessage`, `extractSignupUrl`, `deleteInbox`).
- **Create** `tests/engine/mailtm.test.ts` — live round-trip unit test for the client + a pure-function test for `extractSignupUrl`.
- **Create** `src/suites/signup.ts` — the suite (auto-discovered by the registry; no registration edit needed).

---

## PHASE 0 — Fix `loginAs` account switching

### Task 0.1: Make login handle the "already signed in" interstitial

**Files:**
- Modify: `src/engine/auth.ts:19-28` (the top of the `loginAs` try block, right after `page.goto(.../account/signin)`)

- [ ] **Step 1: Read the current top of `loginAs`**

Confirm the code after `await page.goto(`${env.baseURL}/account/signin`, ...)` waits for the Email field. You will insert interstitial handling BEFORE that wait.

- [ ] **Step 2: Insert interstitial handling**

In `src/engine/auth.ts`, immediately after the `page.goto(... /account/signin ...)` line and before `const emailField = page.getByLabel('Email')`, insert:

```typescript
        // Clerk may show a "You're already signed in as <x>" interstitial instead
        // of the login form when a prior session survived the cookie/storage clear
        // (its state is not only in the app's cookies). Clicking "Sign in with a
        // different account" drops that session and shows the real form. Best-effort:
        // only fires when the button is actually present.
        const differentAccount = page.getByRole('button', {
            name: /sign in with a different account/i,
        })
        if (await differentAccount.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await differentAccount.click().catch(() => {})
        }
```

- [ ] **Step 3: Verify typecheck + lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/engine/auth.ts
git commit -m "Handle Clerk 'already signed in' interstitial in loginAs"
```

### Task 0.2: Assert the signed-in account matches the requested role

**Files:**
- Modify: `src/engine/auth.ts` — the success block (`auth.ts:57-72`) and add a helper.
- Modify: `src/engine/auth.ts` — reuse the existing `getClerkToken` pattern for reading `window.Clerk`.

- [ ] **Step 1: Add an identity-assertion helper**

In `src/engine/auth.ts`, add this helper next to `getClerkToken` (near line 94). It reads the signed-in user's primary email from the Clerk client already present on the page (we already read `window.Clerk` for the token), retrying while Clerk hydrates:

```typescript
// Read the signed-in user's primary email from the Clerk client on the page.
// Returns '' if Clerk/user isn't ready after a short poll. Used to assert we are
// authenticated AS the account we intended — a stale session from a prior role
// would otherwise satisfy the generic "greeting is visible" success check.
async function getClerkEmail(page: Page): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const email = await page
            .evaluate(() => {
                const clerk = (
                    window as unknown as {
                        Clerk?: { user?: { primaryEmailAddress?: { emailAddress?: string } } }
                    }
                ).Clerk
                return clerk?.user?.primaryEmailAddress?.emailAddress ?? null
            })
            .catch(() => null)
        if (email) return email
        await page.waitForTimeout(500)
    }
    return ''
}
```

- [ ] **Step 2: Assert identity after the success wait**

In `loginAs`, after the existing success block that waits for the URL to leave `/signin` and the `Hi,`/dashboard marker (ends at `auth.ts:72`, before the `} catch`), append:

```typescript
        // Assert we are signed in AS the intended account. loginAs() is used to
        // SWITCH accounts (e.g. researcher -> admin for cleanup authority); a stale
        // session that never actually switched would pass the generic markers above
        // but is the wrong user. Compare Clerk's reported email to the account we
        // drove. Fail loudly so a wrong-account state never silently proceeds (and
        // e.g. runs cleanup with a non-admin token that 401s).
        const signedInEmail = await getClerkEmail(page)
        if (signedInEmail && signedInEmail.toLowerCase() !== account.email.toLowerCase()) {
            throw new Error(
                `Logged in as ${signedInEmail} but expected ${account.email} (role ${role}) — ` +
                    `loginAs did not switch accounts`,
            )
        }
```

- [ ] **Step 3: Verify typecheck + lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Run the existing engine tests (loginAs is exercised in run.test.ts)**

Run: `pnpm test -- run.test.ts`
Expected: PASS. The fake page in `tests/engine/run.test.ts` stubs `evaluate` to return `undefined`, so `getClerkEmail` returns `''` and the assertion is skipped (only enforced when Clerk actually reports an email live). If any run.test.ts fake page lacks `waitForTimeout`, add `waitForTimeout: vi.fn(async () => {})` to the fake `page` object in `deps()` (around `tests/engine/run.test.ts:41-47`) so the new helper's poll loop is callable.

- [ ] **Step 5: Commit**

```bash
git add src/engine/auth.ts tests/engine/run.test.ts
git commit -m "Assert loginAs lands on the intended account"
```

### Task 0.3: Verify Phase 0 fixes cleanup end-to-end (manual, live)

**Files:** none (verification only).

- [ ] **Step 1: Run study-happy-path live and confirm real cleanup**

Run: `pnpm qar run --suite study-happy-path --role researcher --env qa`
Expected: the run completes; the final "Switch to the admin account for cleanup authority" step lands on the **admin** dashboard (not the "already signed in" interstitial), and the run's cleanup result is `ok` (no `cleanup` failure category). If the suite creates a study, confirm the study id no longer resolves afterward (open `/<org>/study/<id>/view` → 404/not found), proving the DELETE was authorized. Only proceed to Phase 1 once this passes.

---

## PHASE 1 — The signup suite

### Task 1.1: mail.tm client — types + `activeDomain` (failing test first)

**Files:**
- Create: `src/engine/mailtm.ts`
- Create: `tests/engine/mailtm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/mailtm.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { activeDomain } from '@/engine/mailtm'

describe('mail.tm client (live)', () => {
    it('returns an active domain', async () => {
        const domain = await activeDomain()
        expect(domain).toMatch(/\./) // a real hostname
    }, 20_000)
})
```

(Later tasks widen this import to `createInbox`, `deleteInbox`, `waitForMessage`,
`extractSignupUrl` as they add each export.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- mailtm.test.ts`
Expected: FAIL — `@/engine/mailtm` cannot be resolved (module/exports missing).

- [ ] **Step 3: Create the module with types + `activeDomain`**

Create `src/engine/mailtm.ts`:

```typescript
// A tiny client for the free mail.tm disposable-email API, used by the signup
// suite to catch invite emails and read the signup URL. No API key, no config:
// each invited user gets its own freshly-created account (mail.tm rejects '+' so
// plus-addressing on one inbox is impossible). See the signup suite design doc.
const API = 'https://api.mail.tm'

export interface Inbox {
    id: string
    address: string
    token: string
}

export interface Message {
    id: string
    subject: string
    from: string
    text: string
    html: string
}

async function api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API}${path}`, init)
}

// The first active public domain (currently "web-library.net"). Not hardcoded so
// the suite keeps working if mail.tm rotates its domain.
export async function activeDomain(): Promise<string> {
    const res = await api('/domains')
    if (!res.ok) throw new Error(`mail.tm GET /domains failed: ${res.status}`)
    const body = (await res.json()) as { 'hydra:member': { domain: string; isActive: boolean }[] }
    const active = body['hydra:member'].find(d => d.isActive) ?? body['hydra:member'][0]
    if (!active) throw new Error('mail.tm returned no domains')
    return active.domain
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- mailtm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/mailtm.ts tests/engine/mailtm.test.ts
git commit -m "Add mail.tm client: activeDomain"
```

### Task 1.2: mail.tm client — `createInbox` + `deleteInbox`

**Files:**
- Modify: `src/engine/mailtm.ts`
- Modify: `tests/engine/mailtm.test.ts`

- [ ] **Step 1: Write the failing test**

Widen the import at the top of `tests/engine/mailtm.test.ts` to:

```typescript
import { activeDomain, createInbox, deleteInbox } from '@/engine/mailtm'
```

Then append to the `describe('mail.tm client (live)')` block:

```typescript
    it('creates a usable inbox and deletes it', async () => {
        const domain = await activeDomain()
        const inbox = await createInbox(domain)
        expect(inbox.address).toContain(`@${domain}`)
        expect(inbox.token.length).toBeGreaterThan(10)
        expect(inbox.id).toBeTruthy()
        await deleteInbox(inbox) // must not throw
    }, 30_000)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- mailtm.test.ts`
Expected: FAIL — `createInbox`/`deleteInbox` are not exported.

- [ ] **Step 3: Implement `createInbox` + `deleteInbox`**

Add to `src/engine/mailtm.ts`. Note: no `Math.random`/`Date.now` restriction here (this is engine runtime, not a workflow script), but keep the local-part unique per call:

```typescript
let seq = 0

// A collision-free-enough local part: a per-process counter + a random suffix.
// (Engine runtime code — Math.random is fine here, unlike workflow scripts.)
function uniqueLocalPart(): string {
    seq += 1
    const rand = Math.random().toString(36).slice(2, 10)
    return `qar-signup-${seq}-${rand}`
}

// Create a fresh mail.tm account and return an authenticated Inbox.
export async function createInbox(domain: string): Promise<Inbox> {
    const address = `${uniqueLocalPart()}@${domain}`
    const password = `Qar-${Math.random().toString(36).slice(2)}-9!`
    const created = await api('/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
    })
    if (!created.ok) throw new Error(`mail.tm POST /accounts failed: ${created.status}`)
    const account = (await created.json()) as { id: string; address: string }

    const tokenRes = await api('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
    })
    if (!tokenRes.ok) throw new Error(`mail.tm POST /token failed: ${tokenRes.status}`)
    const { token } = (await tokenRes.json()) as { token: string }

    return { id: account.id, address: account.address, token }
}

// Best-effort delete of a mail.tm account (they also expire on their own).
export async function deleteInbox(inbox: Inbox): Promise<void> {
    await api(`/accounts/${inbox.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${inbox.token}` },
    }).catch(() => {})
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- mailtm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/mailtm.ts tests/engine/mailtm.test.ts
git commit -m "Add mail.tm client: createInbox + deleteInbox"
```

### Task 1.3: mail.tm client — `extractSignupUrl` (pure function, unit-testable)

**Files:**
- Modify: `src/engine/mailtm.ts`
- Modify: `tests/engine/mailtm.test.ts`

- [ ] **Step 1: Write the failing test**

Add `extractSignupUrl` to the import at the top of `tests/engine/mailtm.test.ts`:

```typescript
import { activeDomain, createInbox, deleteInbox, extractSignupUrl } from '@/engine/mailtm'
```

Then append (outside the live `describe`, as a pure unit test):

```typescript
describe('extractSignupUrl', () => {
    it('pulls the invite/accept URL from message text', () => {
        const msg = {
            id: 'x',
            subject: 'You have been invited',
            from: 'noreply@safeinsights.org',
            text: 'Welcome! Click https://pr123.qa.safeinsights.org/account/signup?invite=abc123 to join. Unsubscribe: https://example.com/unsub',
            html: '',
        }
        expect(extractSignupUrl(msg)).toBe(
            'https://pr123.qa.safeinsights.org/account/signup?invite=abc123',
        )
    })

    it('throws when no signup URL is present', () => {
        const msg = { id: 'x', subject: '', from: '', text: 'no links here', html: '' }
        expect(() => extractSignupUrl(msg)).toThrow(/no signup url/i)
    })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- mailtm.test.ts`
Expected: FAIL — `extractSignupUrl` not exported.

- [ ] **Step 3: Implement `extractSignupUrl`**

Add to `src/engine/mailtm.ts`. The exact signup path is confirmed live in Task 1.6 by reading a real invite; the regex here targets a signup/accept/invite path and ignores unrelated links (e.g. unsubscribe):

```typescript
// Pull the SafeInsights signup URL out of an invite email. Prefers a URL whose
// path looks like the invite/signup flow so an unrelated footer link (e.g.
// unsubscribe) is never chosen. The exact path is verified against a real invite
// during implementation (Task 1.6) — widen this pattern there if needed.
export function extractSignupUrl(message: Message): string {
    const haystack = `${message.text}\n${message.html}`
    const urls = haystack.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
    const signup = urls.find(u => /(sign[-_]?up|accept|invit|activate)/i.test(u))
    if (!signup) {
        throw new Error(`no signup url found in message ${message.id}`)
    }
    return signup
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- mailtm.test.ts`
Expected: PASS (all live + pure tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/mailtm.ts tests/engine/mailtm.test.ts
git commit -m "Add mail.tm client: extractSignupUrl"
```

### Task 1.4: mail.tm client — `waitForMessage` (poll with deadline)

**Files:**
- Modify: `src/engine/mailtm.ts`

- [ ] **Step 1: Implement `waitForMessage`**

Add to `src/engine/mailtm.ts`. No inline Playwright timeout and no `waitForTimeout` — this is a plain async poll with a caller-supplied deadline:

```typescript
async function listMessages(token: string): Promise<{ id: string }[]> {
    const res = await api('/messages', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`mail.tm GET /messages failed: ${res.status}`)
    const body = (await res.json()) as { 'hydra:member': { id: string }[] }
    return body['hydra:member']
}

async function getMessage(token: string, id: string): Promise<Message> {
    const res = await api(`/messages/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`mail.tm GET /messages/${id} failed: ${res.status}`)
    const m = (await res.json()) as {
        id: string
        subject: string
        from: { address: string }
        text?: string
        html?: string[]
    }
    return {
        id: m.id,
        subject: m.subject,
        from: m.from.address,
        text: m.text ?? '',
        html: (m.html ?? []).join('\n'),
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Poll the inbox until a message matching `predicate` arrives, then return its
// full body. Bounded by `timeoutMs` (default 60s) — throws if nothing matches in
// time. Poll interval respects mail.tm's 8 QPS limit.
export async function waitForMessage(
    inbox: Inbox,
    predicate: (m: Message) => boolean,
    timeoutMs = 60_000,
): Promise<Message> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const summaries = await listMessages(inbox.token)
        for (const summary of summaries) {
            const full = await getMessage(inbox.token, summary.id)
            if (predicate(full)) return full
        }
        await sleep(2_000)
    }
    throw new Error(`mail.tm: no matching message for ${inbox.address} within ${timeoutMs}ms`)
}
```

- [ ] **Step 2: Verify typecheck + lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/engine/mailtm.ts
git commit -m "Add mail.tm client: waitForMessage"
```

### Task 1.5: The `signup` suite skeleton (setup + invites)

**Files:**
- Create: `src/suites/signup.ts`

- [ ] **Step 1: Create the suite with setup + invite steps**

Create `src/suites/signup.ts`. **Relative imports only** (the `@/` alias is not resolved at suite-load time). The invite selectors are placeholders confirmed live in Task 1.6 — the structure and state threading are fixed here:

```typescript
import { activeDomain, createInbox, extractSignupUrl, waitForMessage } from '../engine/mailtm'
import type { Inbox } from '../engine/mailtm'
import type { RunContext, Suite } from './types'

interface SignupInbox {
    role: 'researcher' | 'reviewer'
    inbox: Inbox
}

function inboxes(ctx: RunContext): SignupInbox[] {
    return ctx.state.signupInboxes as SignupInbox[]
}

// Invites two new users as admin, catches each invite email via mail.tm,
// completes each signup, verifies the role dashboard, and deletes both users via
// the QA cleanup API. Runs as admin (admin sends invites AND holds cleanup
// authority). See docs/superpowers/specs/2026-07-24-signup-suite-design.md.
export const signupSuite: Suite = {
    name: 'signup',
    description: 'Admin invites two users, each completes signup from the emailed link',
    roles: ['admin'],
    steps: [
        {
            name: 'Create two mail.tm inboxes for the invited users',
            run: async ctx => {
                await ctx.step('Create two mail.tm inboxes for the invited users', async () => {
                    const domain = await activeDomain()
                    const researcher = await createInbox(domain)
                    const reviewer = await createInbox(domain)
                    ctx.state.signupInboxes = [
                        { role: 'researcher', inbox: researcher },
                        { role: 'reviewer', inbox: reviewer },
                    ] satisfies SignupInbox[]
                })
            },
        },
        {
            name: 'Invite both users as admin',
            run: async ctx => {
                await ctx.step('Invite both users as admin', async () => {
                    for (const { role, inbox } of inboxes(ctx)) {
                        await inviteUser(ctx, inbox.address, role)
                    }
                })
            },
        },
    ],
}

// --- helpers (invite UI selectors verified live in Task 1.6) ---

async function inviteUser(
    ctx: RunContext,
    email: string,
    role: 'researcher' | 'reviewer',
): Promise<void> {
    // PLACEHOLDER driven live in Task 1.6: navigate to the admin invite UI, enter
    // the email, choose the role, and submit. Assert a success confirmation shows.
    await ctx.page.goto(`${ctx.baseURL}/admin/members`, { waitUntil: 'domcontentloaded' })
    await ctx.page.getByRole('button', { name: /invite/i }).first().click()
    await ctx.page.getByLabel(/email/i).fill(email)
    // role selection + submit filled in during Task 1.6
    void role
}
```

- [ ] **Step 2: Verify the suite is discovered**

Run: `pnpm qar list`
Expected: `signup` appears in the list with role `admin` and its two step names.

- [ ] **Step 3: Verify typecheck + lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/suites/signup.ts
git commit -m "Add signup suite skeleton: inboxes + invite steps"
```

### Task 1.6: Drive the invite + signup UI live, then wire real selectors

**Files:**
- Modify: `src/suites/signup.ts`

- [ ] **Step 1: Discover the real invite UI and invite one user live**

Run a live session and observe the actual admin invite flow. Easiest is the CLI against qa:

Run: `pnpm qar run --suite signup --role admin --env qa`
When it fails on a placeholder selector, use the failure screenshot in the result bundle (and, if needed, the run-companion / a manual browser) to read the real invite UI: where "invite user" lives, the email field, the role/org selector, and the submit button. Record the exact `getByRole`/`getByLabel`/`getByTestId` selectors.

- [ ] **Step 2: Read a real invite email to confirm the signup URL format**

After a successful invite, inspect the mail.tm inbox (the suite logs the address; or add a temporary `console.log(await waitForMessage(...))`). Confirm the signup URL path so `extractSignupUrl`'s regex matches it. If the path is not covered by `/(sign[-_]?up|accept|invit|activate)/i`, widen the regex in `src/engine/mailtm.ts` and update the Task 1.3 test to match.

- [ ] **Step 3: Replace the placeholder `inviteUser` with the real selectors**

Update `inviteUser` in `src/suites/signup.ts` with the verified selectors, ending with a web-first assertion that the invite succeeded (e.g. a toast or the invitee appearing in a pending-members list). Example shape (fill with real selectors from Step 1):

```typescript
async function inviteUser(
    ctx: RunContext,
    email: string,
    role: 'researcher' | 'reviewer',
): Promise<void> {
    await ctx.page.goto(`${ctx.baseURL}/<real-invite-path>`, { waitUntil: 'domcontentloaded' })
    await ctx.page.getByRole('button', { name: /<real invite button>/i }).click()
    await ctx.page.getByLabel(/<real email label>/i).fill(email)
    await ctx.page.getByTestId('<real role select>').click()
    await ctx.page.getByRole('option', { name: new RegExp(role, 'i') }).click()
    await ctx.page.getByRole('button', { name: /<real submit>/i }).click()
    await ctx.page.getByText(/<real success signal>/i).waitFor({ state: 'visible' })
}
```

- [ ] **Step 4: Verify typecheck + lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/suites/signup.ts src/engine/mailtm.ts tests/engine/mailtm.test.ts
git commit -m "Wire real invite selectors + confirmed signup URL format"
```

### Task 1.7: Catch each invite, complete signup, verify dashboard, track for cleanup

**Files:**
- Modify: `src/suites/signup.ts`

- [ ] **Step 1: Add the catch-and-signup step**

Add a new step to the `steps` array (after "Invite both users as admin"). It clears the browser to an unauthenticated state, navigates to the invite URL, completes signup, verifies the role dashboard, and captures the new user id via `ctx.trackUser`. The signup form selectors and the user-id source are confirmed live (Step 2 below); the structure is fixed here:

```typescript
        {
            name: 'Each invited user completes signup and sees their dashboard',
            run: async ctx => {
                for (const { role, inbox } of inboxes(ctx)) {
                    await ctx.step(`Sign up the invited ${role}`, async () => {
                        const message = await waitForMessage(inbox, m =>
                            /invit|welcome|safeinsights/i.test(`${m.subject} ${m.from}`),
                        )
                        const url = extractSignupUrl(message)

                        // Unauthenticated slate for the NEW user. Clearing cookies +
                        // storage alone can leave Clerk's admin session live (same
                        // issue Phase 0 fixes for loginAs), so also navigate to the
                        // invite URL and, if the "already signed in" interstitial
                        // shows, take the sign-out path before signing up.
                        await ctx.page.context().clearCookies()
                        await ctx.page
                            .evaluate(() => {
                                localStorage.clear()
                                sessionStorage.clear()
                            })
                            .catch(() => {})
                        await ctx.page.goto(url, { waitUntil: 'domcontentloaded' })
                        const differentAccount = ctx.page.getByRole('button', {
                            name: /sign in with a different account/i,
                        })
                        if (
                            await differentAccount
                                .isVisible({ timeout: 5_000 })
                                .catch(() => false)
                        ) {
                            await differentAccount.click().catch(() => {})
                            await ctx.page.goto(url, { waitUntil: 'domcontentloaded' })
                        }

                        await completeSignup(ctx)
                        const userId = await verifyDashboardAndCaptureUserId(ctx, role)
                        ctx.trackUser(userId)
                    })
                }
            },
        },
```

- [ ] **Step 2: Drive the signup form live and wire `completeSignup` + `verifyDashboardAndCaptureUserId`**

Run: `pnpm qar run --suite signup --role admin --env qa`
Read the real signup form (password field(s), any name/terms fields, submit) and the post-signup landing. Determine where the new user's id is exposed (the account menu, a `window.Clerk.user.id`, or the URL). Then add the helpers to `src/suites/signup.ts`:

```typescript
async function completeSignup(ctx: RunContext): Promise<void> {
    // Fill with real selectors from the live signup form. Use a fixed strong
    // password (the account is deleted at cleanup, so it need not be secret).
    const password = 'Qar-Signup-Test-9!'
    await ctx.page.getByLabel(/^password/i).fill(password)
    await ctx.page.getByLabel(/confirm/i).fill(password).catch(() => {})
    await ctx.page.getByRole('button', { name: /(sign up|create account|continue)/i }).click()
}

// Verify the new user reached the dashboard appropriate to `role`, and return
// their user id (for cleanup). Reads the id from Clerk on the authenticated page.
async function verifyDashboardAndCaptureUserId(
    ctx: RunContext,
    role: 'researcher' | 'reviewer',
): Promise<string> {
    // Role-appropriate landing signal — replace with the real per-role marker from
    // the live app (e.g. a researcher sees "Propose New Study").
    const marker = role === 'researcher' ? /propose new study/i : /review|dashboard/i
    await ctx.page.getByText(marker).first().waitFor({ state: 'visible' })

    const userId = await ctx.page.evaluate(() => {
        const clerk = (window as unknown as { Clerk?: { user?: { id?: string } } }).Clerk
        return clerk?.user?.id ?? ''
    })
    if (!userId) throw new Error(`Could not read the new ${role}'s user id after signup`)
    return userId
}
```

Adjust the markers/selectors to what the live app actually shows.

- [ ] **Step 3: Verify typecheck + lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/suites/signup.ts
git commit -m "Complete signup per role, verify dashboard, track user for cleanup"
```

### Task 1.8: End as admin so cleanup is authorized

**Files:**
- Modify: `src/suites/signup.ts`

- [ ] **Step 1: Add the final "switch to admin" step**

The signups above left the browser as the last-created user. The engine's cleanup uses the CURRENT session's token, and `DELETE /api/qa/users/{id}` requires `isSiAdmin`, so end as admin. Add as the LAST step in the `steps` array:

```typescript
        {
            name: 'Switch to the admin account for cleanup authority',
            run: async ctx => {
                await ctx.step('Switch to the admin account for cleanup authority', async () => {
                    await ctx.loginAs('admin')
                })
            },
        },
```

- [ ] **Step 2: Verify typecheck + lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/suites/signup.ts
git commit -m "End signup suite as admin for cleanup authority"
```

### Task 1.9: Full live run + cleanup verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite live end-to-end**

Run: `pnpm qar run --suite signup --role admin --env qa`
Expected: all steps pass; both invited users complete signup and see their role dashboard; the run's cleanup result is `ok`.

- [ ] **Step 2: Confirm both users were actually deleted**

Verify neither invited user still exists (attempt to sign in as one, or re-invite the same address succeeds without a "already exists" error, or check via the admin members list). This proves `DELETE /api/qa/users/{id}` ran with admin authority — the exact failure mode Phase 0 fixed.

- [ ] **Step 3: Run the full check gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 4: Final commit (if any cleanup/tweaks were needed)**

```bash
git add -A
git commit -m "Finalize signup suite after live verification"
```

---

## Notes for the implementer

- **Disposable-domain risk (highest):** if the app rejects `web-library.net` invite addresses (a disposable-domain blocklist), Task 1.6 Step 1 fails at the invite. If so, STOP and surface it — the fallback is a paid/keyed provider (MailSlurp/Mailinator), a spec-level change, not a code tweak.
- **Do not** add inline Playwright timeouts or `waitForTimeout` in the suite; use web-first `waitFor`/`expect`. The mail.tm poll in `waitForMessage` is plain async (not Playwright) and is bounded by its own deadline.
- **Suites use relative imports** (`../engine/mailtm`), never `@/`. The mail.tm test uses `@/engine/mailtm` because tests run under vitest with the alias.
- The mail.tm live tests hit the real network; they mirror the `age-interop.test.ts` precedent of testing the real data path.

# `signup` suite — design

## Overview

A new QA suite (`src/suites/signup.ts`) that exercises the admin-driven user
invite flow end-to-end: an admin invites two new users (one **researcher**, one
**reviewer/member**), each invite email is caught via the free
[mail.tm](https://docs.mail.tm/) API, the signup URL is extracted from the email
and followed to completion (new user sets a password), each new user is verified
to land on the role-appropriate dashboard, and finally **both created users are
hard-deleted** via the QA cleanup API added in
[management-app#839](https://github.com/safeinsights/management-app/pull/839).

The suite runs **as `admin`** (admin is who sends invites). A PR run is identical
to a QA run except for the base URL — no PR-only gating.

## Why mail.tm

The invite flow emails a signup URL to the invited address, so the suite must
read that email programmatically. Provider decision:

- **Mailinator** (the domain the *existing* shared accounts use) gates its
  inbox-read API behind a paid Team plan (~$79–159/mo) — the free tier is
  web-UI-only. Not usable for automated reading.
- **mail.tm** — fully free REST API, no signup for API keys, no secrets to
  store. Chosen.
- MailSlurp — free tier but requires an account + stored API key. Rejected to
  avoid adding a secret.

**Verified live during design (2026-07-24):**

- `GET https://api.mail.tm/domains` → one active domain, `web-library.net`.
- `POST /accounts` with `{address, password}` → `201`; `POST /token` → `200`
  with a bearer JWT; `GET /messages` (bearer) → hydra collection; `DELETE
  /accounts/{id}` → `204`.
- **mail.tm REJECTS `+` in an address** (`422`, "username not valid"). Therefore
  **plus-addressing / a single shared inbox is impossible on mail.tm.** The suite
  uses **two fresh per-run accounts** (one per invited role) with distinct random
  local-parts instead. This also means addresses are unique per run, so there is
  no reused-address / re-invite-collision problem, and no inbox credentials in
  config.
- Rate limit: 8 QPS per IP (far above this suite's needs).

## Flow

The suite starts as `admin` (the engine logs in the declared role before the
first step) and must **end as admin** so guaranteed cleanup runs with SI-admin
delete authority — the same pattern `study-happy-path` uses. Because
`ctx.loginAs()` clears the Playwright context (cookies + web storage) and
re-drives Clerk, each new-user signup and each return-to-admin is a `loginAs`-like
context switch. To avoid logging the admin in and out around every invite, the
flow **batches**: do BOTH admin invites first (admin session intact), then do the
two signups, then finish as admin for cleanup.

```
setup (step 1):
  - GET /domains once → pick the active domain
  - create 2 fresh mail.tm accounts (researcher inbox, reviewer inbox)
  - store the two { role, address, token, id } inboxes in ctx.state.inboxes

invite (step 2, as admin — session already active):
  for each inbox: invite <inbox.address> as <inbox.role>   (admin invite UI)

catch + sign up (step 3, per role):
  1. poll mail.tm GET /messages for that inbox until the invite arrives
     (web-first poll bounded by the engine's global timeout)
  2. GET /messages/{id} → read body/html → extract the signup URL
  3. clear the browser context, navigate to the URL, complete signup
     (set password / any required fields)
  4. assert the new user reaches the <role> dashboard
  5. capture the new user's id and call ctx.trackUser(id) for cleanup

finish as admin (final step):
  - ctx.loginAs('admin')   → re-points cleanup auth to the SI-admin token

cleanup (engine-driven, always runs even on mid-run failure):
  - the existing CleanupClient DELETEs /api/qa/users/{id} for each tracked user
    using the admin's Clerk session token (captured at login)
  - mail.tm inboxes are disposable and expire on their own; deleting them is an
    optional best-effort nicety, not required
```

## Components

### `src/suites/signup.ts` — the suite

- Plain `Suite` object, `name: 'signup'`, `roles: ['admin']`, ordered
  `steps: Step[]`, **relative imports only** (`./types`, `../engine/...`).
- Shared state threads through `ctx.state`:
  - `ctx.state.inboxes` — the two mail.tm inboxes `{ role, address, token, id }`,
    created in step 1 and read by later steps.
- Created-user ids are registered with **`ctx.trackUser(id)`** the moment each
  signup completes, so the engine's cleanup deletes them even if a later step
  fails (mirrors how `create-study`/`study-happy-path` track ids early for
  guaranteed cleanup). No separate `createdUserIds` bag is needed —
  `trackUser` is the interface.
- Both invites happen while the admin session is active (step 2), *then* the
  signups run (step 3), avoiding a log-out/log-in cycle around each invite. The
  final step returns to admin via `ctx.loginAs('admin')` so cleanup has delete
  authority.
- **Signing up as an unauthenticated new user**: `ctx.loginAs(role)` only
  switches between the *shared* accounts (admin/researcher/reviewer) — it cannot
  represent a brand-new invited user. So for the signup itself the suite must get
  a clean, unauthenticated browser state and navigate to the invite URL directly.
  Open question for the plan: do this by clearing the existing context
  (`ctx.page.context().clearCookies()` + clear storage, then `page.goto(url)`) or
  by opening a second browser context. Clearing the shared context is simpler and
  the final `ctx.loginAs('admin')` re-establishes the admin session afterward for
  cleanup; the plan picks one and states why.
- No complex logic in step bodies beyond driving the UI; extraction/polling live
  in the mail.tm helper.

### `src/engine/mailtm.ts` — mail.tm client (infra, not a suite)

Typed helper module. Functions:

- `activeDomain(): Promise<string>` — `GET /domains`, return the first active
  domain (don't hardcode `web-library.net`).
- `createInbox(domain): Promise<Inbox>` — random local-part + random password,
  `POST /accounts`, `POST /token`; returns `{ address, token, id }`.
- `waitForMessage(token, predicate, opts): Promise<Message>` — poll `GET
  /messages`, fetch full bodies via `GET /messages/{id}`, resolve the first
  message matching `predicate` (e.g. subject/from contains the invite marker).
  Bounded by the **engine's global timeout** — no inline Playwright timeout, no
  bare `waitForTimeout`; poll on an interval with a deadline.
- `extractSignupUrl(message): string` — pull the signup URL from the message
  html/text (regex against the known signup path).
- `deleteInbox(id, token): Promise<void>` — `DELETE /accounts/{id}`,
  best-effort.

Randomness: the engine forbids `Math.random()`/`Date.now()` inside *workflow
scripts*, but this is ordinary engine runtime code (not a workflow script), so
standard randomness is fine; still, prefer a per-run unique local-part so
concurrent runs never collide.

### Cleanup via management-app#839 — reuses existing engine machinery

The cleanup path already exists in the engine and was built for exactly this;
the suite adds **no new cleanup code and no new secret**.

- Endpoint: `DELETE /api/qa/users/{userId}` — hard-deletes the user (DB + Clerk),
  hard-gated to non-prod (`PROD_ENV === false`), requires a valid **SI-admin
  Clerk session token** in the `Authorization: Bearer` header (a cookie does NOT
  work — `requireQaAdmin` only reads the Bearer header). Returns `200` on
  success, `404` if the id is missing.
- **Auth token**: `src/engine/auth.ts` `getClerkToken(page)` already extracts a
  fresh Clerk **session JWT** from the authenticated admin page
  (`window.Clerk.session.getToken()`) at login, and the comment there says it is
  returned "for the QA cleanup client". `verifyToken()` on the server accepts
  exactly this token. **We do NOT mint a token via the Clerk Backend API** and do
  NOT add `CLERK_SECRET_KEY` / the admin user_id to config — that would be a
  redundant second auth path.
- **Delete client**: `src/engine/cleanup.ts` `CleanupClient` already implements
  `trackUser(id)` / `trackStudy(id)` and DELETEs each via `/api/qa/*` with the
  Bearer token, tolerating failures. The suite just calls `ctx.trackUser(id)`.
- **Authority**: the endpoint requires `isSiAdmin`; a researcher/reviewer session
  would 401. The suite therefore ends as admin (`ctx.loginAs('admin')`) so the
  cleanup token is the admin's — the established `study-happy-path` pattern.
- mail.tm inbox deletion is optional best-effort (accounts expire on their own).

## Testing

- **`tests/engine/mailtm.test.ts`** (vitest) — live round-trip against the real
  mail.tm API: `activeDomain()` returns a non-empty domain; `createInbox()`
  returns a usable token; a freshly created inbox lists zero messages;
  `deleteInbox()` returns cleanly. Follows the repo rule "don't mock the real
  data path" and the existing live-test precedent (`age-interop.test.ts`).
  mail.tm cannot send outbound mail, so `waitForMessage` against a *real* invite
  is exercised only by running the suite live (not in unit tests).
- No unit tests for the suite's UI steps — they are E2E, verified by running the
  suite.

## Runtime assumptions to verify first when building

Ordered by risk. Each is checked live against a real environment before the
suite is considered done.

1. **The app accepts `web-library.net` (a disposable domain) as an invite
   address** — no disposable-domain blocklist on the invite/signup path. Highest
   risk; a repo search for "disposable"/"blocklist" in management-app found
   nothing, but that is not proof. Verify by attempting one real invite.
2. **The `admin` account is an SI admin**, so `DELETE /api/qa/users/{userId}`
   authorizes (else cleanup 403s). (The same account is used for the invites, so
   the invite step failing would surface this first.)
3. **The exact admin invite UI** (where "invite user + choose role/org" lives)
   and the **signup form fields** the invited user must complete — discovered by
   driving the live UI during implementation.
4. **The invite email's signup URL format** (path/query) — so `extractSignupUrl`
   matches the right link and not, say, an unsubscribe footer link. Confirmed by
   reading one real invite email during implementation.

## Non-goals / YAGNI

- No plus-addressing or shared-inbox logic (mail.tm can't do it).
- No stored inbox credentials in `config/` (accounts are created per run).
- **No Clerk Backend API token minting and no `CLERK_SECRET_KEY` in config** —
  cleanup reuses the browser session token the engine already captures.
- No new cleanup code — reuses `CleanupClient` + `ctx.trackUser`.
- No fallback email provider.
- No verification of email *content* beyond finding a well-formed signup URL.

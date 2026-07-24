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

```
setup:
  - GET /domains once → pick the active domain
  - create 2 fresh mail.tm accounts (researcher inbox, reviewer inbox)
  - store { address, token, id } for each in ctx.state.inboxes

per role in [researcher, reviewer]:
  1. as admin, invite <inbox.address> as <role>            (admin invite UI)
  2. poll mail.tm GET /messages for that inbox until the invite arrives
     (web-first poll bounded by the engine's global timeout)
  3. GET /messages/{id} → read body/html → extract the signup URL
  4. in a FRESH browser context, navigate to the URL and complete signup
     (set password / any required fields)
  5. assert the new user reaches the <role> dashboard
  6. capture the new user's id for cleanup (from URL or page)

cleanup (always runs, even on mid-run failure):
  - for each created user id: DELETE /api/qa/users/{userId}
    using the admin's SI-admin Clerk session token
  - delete the 2 mail.tm accounts (best-effort)
```

## Components

### `src/suites/signup.ts` — the suite

- Plain `Suite` object, `name: 'signup'`, `roles: ['admin']`, ordered
  `steps: Step[]`, **relative imports only** (`./types`, `../engine/...`).
- Shared state threads through `ctx.state`:
  - `ctx.state.inboxes` — the two mail.tm inboxes `{ role, address, token, id }`.
  - `ctx.state.createdUserIds` — ids captured as each signup completes, so
    cleanup can target them even if a later step fails (mirrors how
    `create-study` captures the study id as early as possible for guaranteed
    cleanup).
- New users sign up in a **separate Playwright browser context** (fresh cookies)
  so the admin's authenticated session survives across both invites and into
  cleanup.
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

### Cleanup via management-app#839

- Endpoint: `DELETE /api/qa/users/{userId}` — hard-deletes the user (DB + Clerk),
  hard-gated to non-prod (`PROD_ENV === false`), requires a valid **SI-admin
  Clerk session token**. Returns `200` on success, `404` if the id is missing.
- The suite obtains the admin's Clerk session token from the authenticated
  browser context (the admin login already happened in the engine) and issues the
  DELETE for each created user id.
- Runs in the suite's **cleanup phase** so it fires on mid-run failure too.
- mail.tm inbox deletion is best-effort (accounts are disposable and expire on
  their own).

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
   authorizes (else cleanup 403s).
3. **The exact admin invite UI** (where "invite user + choose role/org" lives)
   and the **signup form fields** the invited user must complete — discovered by
   driving the live UI during implementation.

## Non-goals / YAGNI

- No plus-addressing or shared-inbox logic (mail.tm can't do it).
- No stored inbox credentials in `config/` (accounts are created per run).
- No fallback email provider.
- No verification of email *content* beyond finding a well-formed signup URL.

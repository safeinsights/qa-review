import { expect, type Page } from '@playwright/test'
import { loginAs } from '../auth'
import type { Message } from '../mailtm'
import { randomToken } from '../mailtm'
import { QaApiClient } from '../qa-api'
import { totp } from '../totp'
import type { EnvConfig } from '../types'
import { checkUntilEnabled, clickUntil } from './interactions'

// Shared signup-flow helpers, extracted from src/suites/signup.ts so BOTH the
// signup suite AND ad-hoc validation suites drive the SAME flow. These take a
// Playwright `page` (+ `baseURL`) rather than a RunContext, so any Page-holding
// caller can use them; suite-level concerns (ctx.step/state/track/loginAs) stay in
// the suite.

// researcher is invited into the research-lab org, reviewer into the data-partner
// org — the invited role is implied by the org, not chosen in the invite dialog
// (which only offers Contributor vs Administrator; we always pick Contributor).
export const ORG_FOR_ROLE = {
    researcher: 'openstax-lab',
    reviewer: 'openstax',
} as const

export type InvitedRole = keyof typeof ORG_FOR_ROLE

// Default password for signup test accounts.
export const SIGNUP_PASSWORD = 'Qar-Signup-Test-9a!'

// Where a security key is generated, and where a keyless account is held. Signup
// navigates here itself rather than waiting to be redirected — see completeSignup.
const ACCOUNT_KEYS_PATH = '/account/keys'
// Renders the "Existing security key" view for an account that holds one, and
// redirects to ACCOUNT_KEYS_PATH for one that doesn't — the cheap key-presence check.
const USER_KEY_PATH = '/user-key'

// The invite email can take a while to be delivered; give it a realistic budget
// rather than the mail.tm 60s default.
export const INVITE_EMAIL_TIMEOUT_MS = 120_000

// Predicate matching the "get started with SafeInsights" invite email.
export const isInviteEmail = (m: Message): boolean =>
    /get started with safeinsights/i.test(m.subject) || /safeinsights/i.test(m.from)

// Invite one user into the org that implies their role. The invite dialog offers
// only Contributor vs Administrator; we pick Contributor (the role is the org).
export async function inviteUser(
    page: Page,
    baseURL: string,
    email: string,
    role: InvitedRole
): Promise<void> {
    const org = ORG_FOR_ROLE[role]
    await page.goto(`${baseURL}/${org}/admin/team`, { waitUntil: 'domcontentloaded' })
    // "Invite People" is server-rendered, so it is present and clickable BEFORE React
    // wires its onClick, and a one-shot click at domcontentloaded lands on a dead
    // button: it takes focus, no dialog opens, and we then wait out the full timeout on
    // an email field that was never going to appear. clickUntil re-clicks until the
    // dialog renders, under the shared (and bounded) ready policy.
    const emailField = page.getByRole('textbox', { name: /invite by email/i })
    await clickUntil(page.getByRole('button', { name: /invite people/i }), emailField)
    await emailField.fill(email)
    await page
        .getByRole('radio', { name: /contributor/i })
        .check()
        .catch(async () => {
            // some Mantine radios expose as clickable label rather than checkable
            await page
                .getByText(/contributor/i)
                .first()
                .click()
        })
    await page.getByRole('button', { name: /send invitation/i }).click()
    // On success the dialog swaps to a confirmation screen ("Invitation sent
    // successfully!") — the invited address does NOT appear in the main members
    // table (it's only pending), so assert on that confirmation instead.
    await page.getByText(/invitation sent successfully/i).waitFor({ state: 'visible' })
}

// Complete the full new-user signup from the emailed invitation URL and return the
// new user's SafeInsights DB id plus the TOTP secret its MFA was enrolled with.
// Handles: invitation landing -> create account form -> mandatory authenticator-app
// MFA (TOTP) -> recovery codes -> security key -> dashboard. The new user must be
// UNAUTHENTICATED, so clear any existing session.
// `baseURL` is the APP origin, threaded in the way every other flow helper takes it
// rather than read back off `page.url()`. The invitation URL is scraped from an
// email, so the origin the browser happens to be sitting on is not guaranteed to be
// ours — a Clerk-hosted landing would turn these navigations into confusing 404s
// instead of key errors.
export async function completeSignup(
    page: Page,
    invitationUrl: string,
    baseURL: string
): Promise<{ userId: string; mfaSecret: string }> {
    const password = SIGNUP_PASSWORD
    const origin = new URL(baseURL).origin

    // Fresh, unauthenticated slate (the admin session must not carry over).
    await page.context().clearCookies()
    await page
        .evaluate(() => {
            localStorage.clear()
            sessionStorage.clear()
        })
        .catch(() => {})

    // 1. Invitation landing -> Create New Account
    await page.goto(invitationUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('link', { name: /create new account/i }).click()

    // 2. Signup form (email is pre-filled + disabled)
    await page.getByLabel('First name').fill('Qar')
    await page.getByLabel('Last name').fill('Tester')
    await page.getByLabel('Enter password').fill(password)
    await page.getByLabel('Confirm password').fill(password)
    // Tick EVERY agreement the org requires, not just the terms box: a research-lab
    // invite also renders a "Research Organization Participation Agreement" box, and
    // Create Account stays disabled until all of them are ticked. That box settles
    // after first paint, so it has to be swept until the submit gate actually opens
    // rather than once — see checkUntilEnabled.
    const createAccount = page.getByRole('button', { name: /create account/i })
    await checkUntilEnabled(page.getByRole('checkbox', { name: /i agree/i }), createAccount)
    await createAccount.click()

    // 3. Mandatory MFA setup — choose the authenticator-app path, which shows the
    //    TOTP secret in plaintext so we can derive codes headlessly.
    const authenticatorLink = page.getByRole('link', { name: /authenticator app/i })
    await authenticatorLink.waitFor({ state: 'visible' })
    await authenticatorLink.click()
    await page.getByRole('button', { name: /verify code/i }).waitFor({ state: 'visible' })

    // Enter the authenticator code. enterTotp re-reads the secret from the page on
    // each attempt — the page can re-render/regenerate the secret after first paint.
    let mfaSecret = await enterTotp(page)

    // 4. Clerk may step-up re-prompt with a single verification input. Read the
    //    (still-current) secret again for this code — if the page regenerated it,
    //    this later one is the enrolled secret, so it wins.
    const stepUp = page.getByRole('textbox', { name: /verification code/i })
    if (await stepUp.isVisible({ timeout: 10_000 }).catch(() => false)) {
        const secret = await readTotpSecret(page)
        mfaSecret = secret
        await stepUp.fill(totp(secret))
        await page
            .getByRole('button', { name: /continue/i })
            .click()
            .catch(() => {})
    }

    // 5. Recovery codes screen ("Go to SafeInsights") opens a "have you stored
    //    them?" confirm dialog with its OWN "Go to SafeInsights". Both buttons match
    //    the same name and the page one sits behind the modal, so target the
    //    dialog's button specifically (not .first(), which grabs the obscured page
    //    button and silently no-ops).
    await page
        .getByRole('button', { name: /go to safeinsights/i })
        .first()
        .click()
    const recoveryDialog = page.getByRole('dialog').filter({ hasText: /recovery codes/i })
    await recoveryDialog
        .getByRole('button', { name: /go to safeinsights/i })
        .click()
        .catch(() => {})

    // 6. Security-key screen: a one-time private key that must be stored, or the
    //    account can never decrypt an output.
    //
    //    Go to /account/keys DIRECTLY rather than waiting for the screen to arrive.
    //    Nothing in the recovery-codes step routes here; the page is reached only
    //    because RequireUserKey — a client effect that runs after the destination has
    //    already painted — bounces a keyless user. Waiting on that bounce is a race
    //    the flow used to lose silently: the old code polled for "Copy key" for 15s,
    //    took its absence as "not a new account", and skipped key generation
    //    altogether, so signup completed KEYLESS while reporting success. Navigating
    //    is safe here because this helper only ever runs against a brand-new account
    //    (an account that already holds a key would be rotating it instead).
    await page.goto(`${origin}${ACCOUNT_KEYS_PATH}`, {
        waitUntil: 'domcontentloaded',
    })

    // "Next" is gated behind copying, so copy first.
    const copyKey = page.getByRole('button', { name: /copy key/i })
    await copyKey.waitFor({ state: 'visible' })
    await copyKey.click()
    // "Next" is revealed only once the copy attempt settles, and under automation the
    // clipboard write can REJECT — which still reveals it, because the page gates on
    // "attempted" rather than "succeeded". click() auto-waits for it either way.
    await page.getByRole('button', { name: /^next$/i }).click()
    // The dialog's confirm is the ONLY caller of setUserPublicKeyAction, so it is not
    // best-effort — it is the step. Scoped to the dialog so a page-level button of the
    // same name can never shadow it, the trap step 5 documents.
    await page
        .getByRole('dialog')
        .filter({ hasText: /stored your security key/i })
        .getByRole('button', { name: /yes, i have stored my key/i })
        .click()
    // The key screen tears down only once the mutation resolves and the app routes on.
    await expect(copyKey).toBeHidden()

    // 7. Landed authenticated — read the new user's SafeInsights DB id for cleanup.
    //    The QA cleanup endpoint (DELETE /api/qa/users/{id}) looks up by the DB user
    //    UUID (`user.id`), NOT the Clerk id. The DB id lives in Clerk
    //    publicMetadata.user.id; poll — metadata hydrates a beat after login.
    await page.locator('text=dashboard').first().waitFor({ state: 'visible', timeout: 30_000 })
    let userId = ''
    for (let attempt = 0; attempt < 10 && !userId; attempt++) {
        userId = await page.evaluate(() => {
            const clerk = (
                window as unknown as {
                    Clerk?: { user?: { publicMetadata?: { user?: { id?: string } } } }
                }
            ).Clerk
            return clerk?.user?.publicMetadata?.user?.id ?? ''
        })
        if (!userId) await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (!userId) {
        throw new Error('Could not read the new user SafeInsights id (publicMetadata) after signup')
    }

    // 8. Assert the account actually HOLDS a key. Reaching a dashboard does not
    //    prove it: RequireUserKey is a client effect that lets the dashboard paint
    //    before it bounces a keyless user to /account/keys, so step 7's wait is
    //    satisfied either way. That is how two accounts created on 2026-08-18
    //    finished signup keyless while this helper reported success — the callers
    //    then hand out an account that cannot decrypt anything.
    //    /user-key is the cheap discriminator: it renders the existing-key view for
    //    a keyed account and redirects to ACCOUNT_KEYS_PATH for a keyless one.
    await page.goto(`${origin}${USER_KEY_PATH}`, { waitUntil: 'domcontentloaded' })
    await expect(
        page.getByRole('heading', { name: /existing security key/i }),
        'signup finished without storing a security key (the key-page confirm did not take)'
    ).toBeVisible()

    // Callers document this helper as ending on the new user's dashboard. Wait for a
    // rendered control rather than trusting domcontentloaded: the caller's next action
    // runs against this page, and an unhydrated dashboard would swallow its first
    // click (CLAUDE.md — wait on page elements, not URLs).
    await page.goto(`${origin}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.locator('text=dashboard').first().waitFor({ state: 'visible' })

    return { userId, mfaSecret }
}

export interface CreatedUser {
    userId: string
    email: string
    // Base32 TOTP secret the account's MFA was enrolled with. Pair it with
    // `qar totp --secret <v>` to sign back in as this user later.
    mfaSecret: string
}

// A collision-free-enough address for an API-minted invite. MUST start with "qa" —
// the management-app's QA endpoints guard every account they touch with assertQaEmail
// (local part matches /^qa/i), so a non-qa address is refused with a 403 and, worse,
// couldn't be cleaned up afterwards. No inbox is ever created for it: the invite URL
// comes back from the API, so nothing is delivered here.
let inviteSeq = 0
export function uniqueQaEmail(): string {
    inviteSeq += 1
    return `qa-invite-${inviteSeq}-${randomToken(8)}@qa.safeinsights.org`
}

// End-to-end "create a brand-new user from scratch" on a single held page, for ad-hoc
// validation: log in as admin (the invite API needs an SI-admin session JWT), mint an
// invite through the QA API, and complete the full signup from its URL (create-account
// → MFA → recovery → security key). Returns the new user's SafeInsights DB id + email.
//
// The invite URL comes straight from the API rather than from an inbox, so this no
// longer waits ~2min on email delivery. The signup SUITE deliberately keeps the real
// UI-invite + real-email path — that flow is the thing it exists to test.
//
// Ends logged in AS THE NEW USER (completeSignup lands on their dashboard); callers
// that need admin authority afterwards should loginAs('admin') themselves.
export async function createUserViaInvite(
    page: Page,
    env: EnvConfig,
    role: InvitedRole
): Promise<CreatedUser> {
    // loginAs returns the Clerk session JWT the /api/qa endpoints authorize with.
    const token = await loginAs(page, env, 'admin')
    if (!token) {
        throw new Error('could not read an admin Clerk session token — the QA invite API needs one')
    }
    const email = uniqueQaEmail()
    const api = new QaApiClient(env.baseURL, token)
    const invite = await api.createInvite({ email, orgSlug: ORG_FOR_ROLE[role] })
    const { userId, mfaSecret } = await completeSignup(page, invite.inviteUrl, env.baseURL)
    return { userId, email, mfaSecret }
}

// Read the base32 TOTP secret shown on the authenticator-app setup page. The secret
// renders asynchronously and may sit in a leaf node, an input's value, or a data
// attribute — so poll a few times and scan broadly for an uppercase base32 run
// (>= 26 chars, a multiple of 8 to avoid matching unrelated all-caps words).
export async function readTotpSecret(page: Page): Promise<string> {
    const deadline = Date.now() + 20_000
    // NOTE: the evaluate body must avoid named inner functions — tsx/esbuild wraps
    // them with a `__name` helper that doesn't exist in the browser, throwing
    // "ReferenceError: __name is not defined". So gather raw candidate strings in
    // the browser with plain loops, and do the base32 selection here in Node.
    while (Date.now() < deadline) {
        const candidates = await page.evaluate(() => {
            const out: string[] = []
            for (const inp of Array.from(document.querySelectorAll('input'))) {
                out.push((inp as HTMLInputElement).value || '')
            }
            for (const el of Array.from(document.querySelectorAll('body *'))) {
                let own = ''
                for (const n of Array.from(el.childNodes)) {
                    if (n.nodeType === 3) own += n.textContent || ''
                }
                out.push(own)
                out.push(el.getAttribute('data-secret') || '')
            }
            return out
        })
        // Clerk's authenticator secret is a 32-char base32 string. Require >= 26 to
        // exclude stray all-caps DOM tokens and prefer the LONGEST match.
        let best = ''
        for (const raw of candidates) {
            for (const m of raw.toUpperCase().matchAll(/\b[A-Z2-7]{26,}\b/g)) {
                if (m[0].length % 8 === 0 && m[0].length > best.length) best = m[0]
            }
        }
        if (best) return best
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const dom = await page
        .evaluate(() => document.querySelector('main')?.innerText?.slice(0, 800) ?? '(no main)')
        .catch(() => '(dom read failed)')
    throw new Error(`Could not find the TOTP secret on the MFA setup page. main text:\n${dom}`)
}

// Fill the 6-box PinInput with a freshly-computed TOTP code and submit. If the
// verify fails, wait for a fresh 30s window and retry with a newly-computed code.
// Throws if every attempt is rejected so the failure is loud, not a silent hang.
// Returns the secret that actually verified — the page can regenerate it between
// attempts, so only the accepted one can derive codes for a later sign-in.
export async function enterTotp(page: Page): Promise<string> {
    // Resolve the 6-box Mantine PinInput robustly: prefer the proven SMS-pin
    // selector (placeholder="0" in a role=group), then fall back to any role=group
    // inputs, then the accessible-name form.
    let inputs = page.locator('[role="group"] input[placeholder="0"]')
    if ((await inputs.count()) < 6) {
        const grouped = page.locator('[role="group"] input')
        inputs =
            (await grouped.count()) >= 6 ? grouped : page.getByRole('textbox', { name: 'PinInput' })
    }
    let lastSecret = ''
    for (let attempt = 0; attempt < 5; attempt++) {
        // Re-read the secret each attempt: the page can re-render/regenerate it
        // after first paint. Compute as late as possible.
        const secret = await readTotpSecret(page)
        lastSecret = secret
        const code = totp(secret)
        const count = await inputs.count()
        if (count >= 6) {
            for (let i = 0; i < 6; i++) await inputs.nth(i).fill(code[i])
        } else {
            await inputs.first().fill(code)
        }
        await page
            .getByRole('button', { name: /verify code/i })
            .click()
            .catch(() => {})

        // Success = we left the pin-entry step: either the recovery-codes screen
        // (Go to SafeInsights) or Clerk's step-up prompt appeared.
        const moved = await Promise.race([
            page
                .getByRole('button', { name: /go to safeinsights/i })
                .waitFor({ state: 'visible', timeout: 8_000 })
                .then(() => true),
            page
                .getByRole('textbox', { name: /verification code/i })
                .waitFor({ state: 'visible', timeout: 8_000 })
                .then(() => true),
        ]).catch(() => false)
        if (moved) return secret

        // Rejected (or still on the pin step). Wait for the NEXT time window so we
        // never resubmit the same code, then clear the boxes and retry.
        const msIntoWindow = Date.now() % 30_000
        await new Promise(resolve => setTimeout(resolve, 30_000 - msIntoWindow + 500))
    }
    throw new Error(
        `authenticator MFA: code rejected after multiple attempts (secret=${lastSecret})`
    )
}

import type { Page } from '@playwright/test'
import { loginAs } from '../auth'
import type { Message } from '../mailtm'
import { activeDomain, createInbox, extractSignupUrl, waitForMessage } from '../mailtm'
import { totp } from '../totp'
import type { EnvConfig } from '../types'

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
    await page.getByRole('button', { name: /invite people/i }).click()
    await page.getByRole('textbox', { name: /invite by email/i }).fill(email)
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

// Complete the full new-user signup from the emailed invitation URL and return
// the new user's SafeInsights DB id. Handles: invitation landing -> create account
// form -> mandatory authenticator-app MFA (TOTP) -> recovery codes -> security key
// -> dashboard. The new user must be UNAUTHENTICATED, so clear any existing session.
export async function completeSignup(page: Page, invitationUrl: string): Promise<string> {
    const password = SIGNUP_PASSWORD

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
    await page.getByRole('checkbox', { name: /i agree to the terms/i }).check()
    await page.getByRole('button', { name: /create account/i }).click()

    // 3. Mandatory MFA setup — choose the authenticator-app path, which shows the
    //    TOTP secret in plaintext so we can derive codes headlessly.
    const authenticatorLink = page.getByRole('link', { name: /authenticator app/i })
    await authenticatorLink.waitFor({ state: 'visible' })
    await authenticatorLink.click()
    await page.getByRole('button', { name: /verify code/i }).waitFor({ state: 'visible' })

    // Enter the authenticator code. enterTotp re-reads the secret from the page on
    // each attempt — the page can re-render/regenerate the secret after first paint.
    await enterTotp(page)

    // 4. Clerk may step-up re-prompt with a single verification input. Read the
    //    (still-current) secret again for this code.
    const stepUp = page.getByRole('textbox', { name: /verification code/i })
    if (await stepUp.isVisible({ timeout: 10_000 }).catch(() => false)) {
        const secret = await readTotpSecret(page)
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

    // 6. Security-key screen (/account/keys): a one-time private key. "Next" is
    //    gated behind copying, so click "Copy key" first, then "Next", then confirm
    //    "Yes, I have stored my key". Best-effort — only appears for a new account.
    const copyKey = page.getByRole('button', { name: /copy key/i })
    if (await copyKey.isVisible({ timeout: 15_000 }).catch(() => false)) {
        await copyKey.click()
        await page.getByRole('button', { name: /^next$/i }).click()
        await page
            .getByRole('button', { name: /yes, i have stored my key/i })
            .click()
            .catch(() => {})
    }

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
    return userId
}

export interface CreatedUser {
    userId: string
    email: string
}

// End-to-end "create a brand-new user from scratch" on a single held page, for
// ad-hoc validation: log in as admin (invites require admin), create a fresh mail.tm
// inbox, invite that address into the org implying `role`, wait for the invite email,
// and complete the full signup (create-account → MFA → recovery → security key).
// Returns the new user's SafeInsights DB id + email (for cleanup / later reference).
// Ends logged in AS THE NEW USER (completeSignup lands on their dashboard); callers
// that need admin authority afterwards should loginAs('admin') themselves.
export async function createUserViaInvite(
    page: Page,
    env: EnvConfig,
    role: InvitedRole
): Promise<CreatedUser> {
    await loginAs(page, env, 'admin')
    const inbox = await createInbox(await activeDomain())
    await inviteUser(page, env.baseURL, inbox.address, role)
    const message = await waitForMessage(inbox, isInviteEmail, INVITE_EMAIL_TIMEOUT_MS)
    const userId = await completeSignup(page, extractSignupUrl(message))
    return { userId, email: inbox.address }
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
export async function enterTotp(page: Page): Promise<void> {
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
        if (moved) return

        // Rejected (or still on the pin step). Wait for the NEXT time window so we
        // never resubmit the same code, then clear the boxes and retry.
        const msIntoWindow = Date.now() % 30_000
        await new Promise(resolve => setTimeout(resolve, 30_000 - msIntoWindow + 500))
    }
    throw new Error(
        `authenticator MFA: code rejected after multiple attempts (secret=${lastSecret})`
    )
}

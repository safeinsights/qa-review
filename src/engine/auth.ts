import type { Page } from '@playwright/test'
import type { EnvConfig, Role } from '@/engine/types'

export class AuthError extends Error {}

// Logs `page` into the live app as `role` by driving the real Clerk sign-in UI
// (email + password, then the second-factor code — a fixed SMS code on qa/staging,
// or an authenticator-app TOTP code on production). Returns the session
// cookie header string (used by the cleanup client to authorize DELETE calls as
// this user). Throws AuthError on failure so run.ts can categorize it as 'auth'.
// `bundleDir` (when provided) is where a failure screenshot is written.
export async function loginAs(
    page: Page,
    env: EnvConfig,
    role: Role,
    bundleDir?: string
): Promise<string> {
    const account = env.accounts[role]

    try {
        await page.goto(`${env.baseURL}/account/signin`, { waitUntil: 'domcontentloaded' })

        // Proactively sign out any existing Clerk session BEFORE we start, so we
        // always begin from a clean slate. This is the root-cause fix for the
        // stale-session bug: relying only on the "sign in with a different account"
        // interstitial (a racy UI click) could leave the PREVIOUS role's session
        // active alongside the new one, so the app kept acting as the old user while
        // login "succeeded". Clerk.signOut() drops ALL sessions. Best-effort: Clerk
        // may not be loaded yet on the very first visit, in which case there is no
        // session to clear anyway. After signing out, reload so the form re-renders
        // without the interstitial.
        const signedOut = await page
            .evaluate(async () => {
                const clerk = (window as unknown as { Clerk?: { signOut?: () => Promise<void> } })
                    .Clerk
                if (!clerk?.signOut) return false
                await clerk.signOut()
                return true
            })
            .catch(() => false)
        if (signedOut) {
            await page
                .goto(`${env.baseURL}/account/signin`, { waitUntil: 'domcontentloaded' })
                .catch(() => {})
        }

        // Clerk may STILL show a "You're already signed in as <x>" interstitial (e.g.
        // signOut wasn't ready in time, or a session survived) — this suite switches
        // roles mid-run via loginAs, so the PREVIOUS role's session can still be
        // live here. Clicking "Sign in with a different account" drops that session
        // and reveals the real form.
        //
        // The interstitial hydrates on its own timeline (client-rendered, behind a
        // spinner), so a one-shot "is the button visible right now?" peek races the
        // hydration and skips the click — then we'd wait uselessly for an Email
        // field the interstitial is covering. Instead race the two possible outcomes
        // (interstitial button vs. Email field); if the interstitial wins, dismiss it
        // and wait for the form. Retry the click because the button briefly disables
        // itself while Clerk tears the session down.
        const emailField = page.getByLabel('Email')
        const differentAccount = page.getByRole('button', {
            name: /sign in with a different account/i,
        })
        await Promise.race([
            emailField.waitFor({ state: 'visible', timeout: 30_000 }),
            differentAccount.waitFor({ state: 'visible', timeout: 30_000 }),
        ]).catch(() => {})
        if (await differentAccount.isVisible().catch(() => false)) {
            for (let attempt = 0; attempt < 3; attempt++) {
                await differentAccount.click().catch(() => {})
                const gone = await emailField
                    .waitFor({ state: 'visible', timeout: 10_000 })
                    .then(() => true)
                    .catch(() => false)
                if (gone) break
            }
        }
        // The app is client-rendered: a loading spinner shows first, then the
        // form hydrates. Wait for the Email field to actually appear before
        // interacting (web-first wait absorbs the spinner).
        await emailField.waitFor({ state: 'visible', timeout: 30_000 })
        await emailField.fill(account.email)
        await page.getByLabel('Password').fill(account.password)
        await page.getByRole('button', { name: 'Login' }).click()

        // After Login there is a spinner before the next screen. The account
        // either lands straight on the dashboard, or hits the MFA picker. The
        // second factor depends on the env: qa/staging test accounts use "SMS
        // Verification" (a fixed code); production accounts use an authenticator
        // app (a TOTP code computed from the seed). Both lead to the same 6-digit
        // pin input. Wait for ANY of the three to appear before deciding.
        const smsButton = page.getByRole('button', { name: 'SMS Verification' })
        const authenticatorButton = page.getByRole('button', {
            name: /authenticator|authentication app|totp/i,
        })
        const dashboard = page.locator('text=dashboard').first()
        await Promise.race([
            smsButton.waitFor({ state: 'visible', timeout: 30_000 }),
            authenticatorButton.waitFor({ state: 'visible', timeout: 30_000 }),
            dashboard.waitFor({ state: 'visible', timeout: 30_000 }),
        ]).catch(() => {})

        // MFA branch: pick whichever second-factor option this env presents, then
        // enter the code (account.mfaCode is fixed for qa/staging, TOTP-computed for
        // production). The picker→code transition has its own spinner and a Mantine
        // re-render can drop the first click, so retry until the pin input appears.
        const pinInput = page.getByTestId('sms-pin-input')
        const mfaChoice = (await authenticatorButton.isVisible().catch(() => false))
            ? authenticatorButton
            : (await smsButton.isVisible().catch(() => false))
              ? smsButton
              : null
        if (mfaChoice) {
            for (let attempt = 0; attempt < 3; attempt++) {
                await mfaChoice.click().catch(() => {})
                const appeared = await pinInput
                    .waitFor({ state: 'visible', timeout: 10_000 })
                    .then(() => true)
                    .catch(() => false)
                if (appeared) break
            }
            await fillPin(page, account.mfaCode)
            await page.getByRole('button', { name: /verify code/i }).click()
        }

        // Success = we've left the sign-in page and an authenticated marker is
        // present. After verifying the code there is a redirect chain (+ a
        // re-hydration spinner), so wait for the URL to leave /signin first, then
        // for the "Hi, <name>" sidebar that every authenticated page shows. This
        // is more robust than a bare "dashboard" text match that can race the
        // mid-redirect blank screen.
        await page.waitForURL(url => !url.pathname.endsWith('/account/signin'), { timeout: 30_000 })
        await page
            .getByText(/^Hi,/i)
            .first()
            .waitFor({ state: 'visible', timeout: 30_000 })
            .catch(async () => {
                // Fallback: some roles land on a page whose primary signal is the
                // dashboard heading rather than the greeting.
                await dashboard.waitFor({ state: 'visible', timeout: 15_000 })
            })

        // Assert we are signed in AS the intended account, on the ACTIVE session.
        // loginAs() is used to SWITCH accounts (e.g. researcher -> admin for cleanup
        // authority); a stale session that never actually switched would pass the
        // generic markers above but is the wrong user. We read the ACTIVE session's
        // user (see getActiveSessionInfo) — fail closed so a wrong-account state never
        // proceeds to e.g. run cleanup with a non-admin token that hits Access Denied.
        const active = await getActiveSessionInfo(page)
        if (!active.email) {
            throw new Error(
                `Could not read the active Clerk session's email to confirm account ` +
                    `${account.email} (role ${role}); refusing to proceed with an unverified identity`
            )
        }
        if (active.email.toLowerCase() !== account.email.toLowerCase()) {
            throw new Error(
                `Active session is ${active.email} but expected ${account.email} (role ${role}) — ` +
                    `loginAs did not switch accounts (stale session still active)`
            )
        }
        // A leftover session from the previous role means the "different account"
        // teardown didn't fully drop the old one; the app can still act as it. Refuse
        // rather than risk driving the wrong identity.
        if (active.sessionCount > 1) {
            throw new Error(
                `Signed in as ${account.email} (role ${role}) but Clerk still has ` +
                    `${active.sessionCount} active sessions — a previous account was not ` +
                    `signed out; refusing to proceed with an ambiguous session`
            )
        }
    } catch (cause) {
        // Capture what the page looked like at the point of failure so the result
        // bundle shows WHY login failed (best-effort).
        if (bundleDir) {
            await page
                .screenshot({ path: `${bundleDir}/screenshots/auth-failure.png` })
                .catch(() => {})
        }
        throw new AuthError(
            `Could not log in as ${role} on ${env.name}: ${(cause as Error).message}`
        )
    }

    // Return a Clerk SESSION JWT for the QA cleanup client (it calls the
    // /api/qa endpoints with `Authorization: Bearer <jwt>`). Best-effort: if
    // Clerk isn't ready or has no session token, return '' so cleanup simply
    // fails gracefully rather than blocking the run.
    return await getClerkToken(page)
}

// The identity of the ACTIVE Clerk session on the page: the email its user carries,
// plus how many sessions Clerk currently has active. We assert on the ACTIVE SESSION
// (Clerk.session.user), NOT the global Clerk.user — when switching accounts via
// "sign in with a different account", Clerk can hold multiple sessions and leave the
// PREVIOUS one active while Clerk.user optimistically points at the new sign-in. The
// app's cookie and getToken() both follow the ACTIVE session, so reading Clerk.user
// would report success while the browser still acts as the old user (the exact
// stale-session bug: cleanup then runs with a non-admin token and hits Access Denied).
interface ActiveSessionInfo {
    email: string
    sessionCount: number
}

async function getActiveSessionInfo(page: Page): Promise<ActiveSessionInfo> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const info = await page
            .evaluate(() => {
                const clerk = (
                    window as unknown as {
                        Clerk?: {
                            session?: { user?: { primaryEmailAddress?: { emailAddress?: string } } }
                            client?: { activeSessions?: unknown[] }
                        }
                    }
                ).Clerk
                const email = clerk?.session?.user?.primaryEmailAddress?.emailAddress ?? null
                if (!email) return null
                const sessionCount = clerk?.client?.activeSessions?.length ?? 1
                return { email, sessionCount }
            })
            .catch(() => null)
        if (info) return info
        await page.waitForTimeout(500)
    }
    return { email: '', sessionCount: 0 }
}

// Read a fresh Clerk session token from the authenticated page. Polls briefly
// because window.Clerk / its active session hydrate a beat after the redirect.
async function getClerkToken(page: Page): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const token = await page
            .evaluate(async () => {
                const clerk = (
                    window as unknown as {
                        Clerk?: { session?: { getToken(opts?: unknown): Promise<string | null> } }
                    }
                ).Clerk
                if (!clerk?.session) return null
                return await clerk.session.getToken({ skipCache: true }).catch(() => null)
            })
            .catch(() => null)
        if (token) return token
        await page.waitForTimeout(500)
    }
    return ''
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

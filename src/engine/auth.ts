import type { Page } from '@playwright/test'
import type { EnvConfig, Role } from '@/engine/types'

export class AuthError extends Error {}

// Logs `page` into the live app as `role` by driving the real Clerk sign-in UI
// (email + password, then the fixed second-factor code). Returns the session
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
        // Clerk may show a "You're already signed in as <x>" interstitial instead
        // of the login form when a prior session survived the cookie/storage clear
        // (its state is not only in the app's cookies). Clicking "Sign in with a
        // different account" drops that session and shows the real form. Best-effort:
        // only fires when the button is actually present.
        const differentAccount = page.getByRole('button', {
            name: /sign in with a different account/i,
        })
        if (await differentAccount.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await differentAccount.click().catch(() => {})
        }
        // The app is client-rendered: a loading spinner shows first, then the
        // form hydrates. Wait for the Email field to actually appear before
        // interacting (web-first wait absorbs the spinner).
        const emailField = page.getByLabel('Email')
        await emailField.waitFor({ state: 'visible', timeout: 30_000 })
        await emailField.fill(account.email)
        await page.getByLabel('Password').fill(account.password)
        await page.getByRole('button', { name: 'Login' }).click()

        // After Login there is a spinner before the next screen. The account
        // either lands straight on the dashboard, or (these test accounts) hits
        // the MFA picker. Wait for EITHER to appear before deciding.
        const smsButton = page.getByRole('button', { name: 'SMS Verification' })
        const dashboard = page.locator('text=dashboard').first()
        await Promise.race([
            smsButton.waitFor({ state: 'visible', timeout: 30_000 }),
            dashboard.waitFor({ state: 'visible', timeout: 30_000 }),
        ]).catch(() => {})

        // MFA branch: click SMS Verification, then enter the fixed code. The
        // picker→code transition has its own spinner and a Mantine re-render can
        // drop the first click, so retry until the 6-digit pin input appears.
        const pinInput = page.getByTestId('sms-pin-input')
        if (await smsButton.isVisible().catch(() => false)) {
            for (let attempt = 0; attempt < 3; attempt++) {
                await smsButton.click().catch(() => {})
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

        // Assert we are signed in AS the intended account. loginAs() is used to
        // SWITCH accounts (e.g. researcher -> admin for cleanup authority); a stale
        // session that never actually switched would pass the generic markers above
        // but is the wrong user. The greeting we just waited for is rendered from
        // Clerk's user state, so a healthy session exposes the email here — fail
        // closed (don't silently skip) so a wrong-account state never proceeds to
        // e.g. run cleanup with a non-admin token that 401s.
        const signedInEmail = await getClerkEmail(page)
        if (!signedInEmail) {
            throw new Error(
                `Could not read the signed-in email from Clerk to confirm account ` +
                    `${account.email} (role ${role}); refusing to proceed with an unverified identity`
            )
        }
        if (signedInEmail.toLowerCase() !== account.email.toLowerCase()) {
            throw new Error(
                `Logged in as ${signedInEmail} but expected ${account.email} (role ${role}) — ` +
                    `loginAs did not switch accounts`
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

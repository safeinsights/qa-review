import type { Page } from '@playwright/test'
import type { EnvConfig, Role } from '@/engine/types'

export class AuthError extends Error {}

// Logs `page` into the live app as `role` by driving the real Clerk sign-in UI
// (email + password, then the fixed second-factor code). Returns the session
// cookie header string (used by the cleanup client to authorize DELETE calls as
// this user). Throws AuthError on failure so run.ts can categorize it as 'auth'.
// `bundleDir` (when provided) is where a failure screenshot is written.
export async function loginAs(page: Page, env: EnvConfig, role: Role, bundleDir?: string): Promise<string> {
    const account = env.accounts[role]

    try {
        await page.goto(`${env.baseURL}/account/signin`, { waitUntil: 'domcontentloaded' })
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
        await page.waitForURL((url) => !url.pathname.endsWith('/account/signin'), { timeout: 30_000 })
        await page
            .getByText(/^Hi,/i)
            .first()
            .waitFor({ state: 'visible', timeout: 30_000 })
            .catch(async () => {
                // Fallback: some roles land on a page whose primary signal is the
                // dashboard heading rather than the greeting.
                await dashboard.waitFor({ state: 'visible', timeout: 15_000 })
            })
    } catch (cause) {
        // Capture what the page looked like at the point of failure so the result
        // bundle shows WHY login failed (best-effort).
        if (bundleDir) {
            await page.screenshot({ path: `${bundleDir}/screenshots/auth-failure.png` }).catch(() => {})
        }
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

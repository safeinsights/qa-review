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

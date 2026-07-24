import type { Page } from '@playwright/test'
import type { Inbox } from '../engine/mailtm'
import { activeDomain, createInbox, extractSignupUrl, waitForMessage } from '../engine/mailtm'
import { totp } from '../engine/totp'
import type { RunContext, Suite } from './types'

// researcher is invited into the research-lab org, reviewer into the data-partner
// org — the invited role is implied by the org, not chosen in the invite dialog
// (which only offers Contributor vs Administrator; we always pick Contributor).
const ORG_FOR_ROLE = {
    researcher: 'openstax-lab',
    reviewer: 'openstax',
} as const

type InvitedRole = keyof typeof ORG_FOR_ROLE

interface SignupInbox {
    role: InvitedRole
    inbox: Inbox
}

function inboxes(ctx: RunContext): SignupInbox[] {
    return ctx.state.signupInboxes as SignupInbox[]
}

// Invites two new users as admin (researcher into openstax-lab, reviewer into
// openstax), catches each invite email via mail.tm, completes the full new-user
// signup — including the mandatory authenticator-app MFA setup (TOTP) — verifies
// each reaches the dashboard, and tracks each for id-based cleanup. Ends as admin
// so the engine's cleanup (DELETE /api/qa/users/{id}) is authorized. See
// docs/superpowers/specs/2026-07-24-signup-suite-design.md.
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
        {
            name: 'Each invited user completes signup and sees their dashboard',
            run: async ctx => {
                for (const { role, inbox } of inboxes(ctx)) {
                    await ctx.step(`Sign up the invited ${role}`, async () => {
                        const message = await waitForMessage(
                            inbox,
                            m =>
                                /get started with safeinsights/i.test(m.subject) ||
                                /safeinsights/i.test(m.from)
                        )
                        const url = extractSignupUrl(message)
                        const userId = await completeSignup(ctx, url)
                        ctx.trackUser(userId)
                    })
                }
            },
        },
        {
            name: 'Switch to the admin account for cleanup authority',
            run: async ctx => {
                await ctx.step('Switch to the admin account for cleanup authority', async () => {
                    await ctx.loginAs('admin')
                })
            },
        },
    ],
}

// --- helpers ---

// Invite one user into the org that implies their role. The invite dialog offers
// only Contributor vs Administrator; we pick Contributor (the role is the org).
async function inviteUser(ctx: RunContext, email: string, role: InvitedRole): Promise<void> {
    const org = ORG_FOR_ROLE[role]
    await ctx.page.goto(`${ctx.baseURL}/${org}/admin/team`, { waitUntil: 'domcontentloaded' })
    await ctx.page.getByRole('button', { name: /invite people/i }).click()
    await ctx.page.getByRole('textbox', { name: /invite by email/i }).fill(email)
    await ctx.page
        .getByRole('radio', { name: /contributor/i })
        .check()
        .catch(async () => {
            // some Mantine radios expose as clickable label rather than checkable
            await ctx.page
                .getByText(/contributor/i)
                .first()
                .click()
        })
    await ctx.page.getByRole('button', { name: /send invitation/i }).click()
    // Confirm the invite registered: the address appears in the pending list.
    await ctx.page.getByText(email, { exact: false }).first().waitFor({ state: 'visible' })
}

// Complete the full new-user signup from the emailed invitation URL and return
// the new user's Clerk id. Handles: invitation landing -> create account form ->
// mandatory authenticator-app MFA (TOTP) -> recovery codes -> dashboard. The new
// user must be UNAUTHENTICATED, so clear any existing session first.
async function completeSignup(ctx: RunContext, invitationUrl: string): Promise<string> {
    const page = ctx.page
    const password = 'Qar-Signup-Test-9a!'

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
    await page.waitForURL(/\/account\/mfa/, { timeout: 30_000 })
    await page.getByRole('link', { name: /authenticator app/i }).click()
    await page.waitForURL(/\/account\/mfa\/app/, { timeout: 30_000 })

    // The secret is a run of base32 chars shown on the page. Read it, then fill the
    // 6-digit code. Retry across a step boundary since codes roll every 30s.
    const secret = await readTotpSecret(page)
    await enterTotp(page, secret)

    // 4. Clerk may step-up re-prompt with a single verification input.
    const stepUp = page.getByRole('textbox', { name: /verification code/i })
    if (await stepUp.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await stepUp.fill(totp(secret))
        await page
            .getByRole('button', { name: /continue/i })
            .click()
            .catch(() => {})
    }

    // 5. Recovery codes screen, then the "have you stored them?" confirm dialog.
    await page
        .getByRole('button', { name: /go to safeinsights/i })
        .first()
        .click()
    await page
        .getByRole('button', { name: /go to safeinsights/i })
        .first()
        .click()
        .catch(() => {})

    // 6. Landed authenticated — read the new user's Clerk id for cleanup.
    await page.waitForURL(url => /\/dashboard|\/openstax/i.test(url.pathname), { timeout: 30_000 })
    const userId = await page.evaluate(() => {
        const clerk = (window as unknown as { Clerk?: { user?: { id?: string } } }).Clerk
        return clerk?.user?.id ?? ''
    })
    if (!userId) throw new Error('Could not read the new user Clerk id after signup')
    return userId
}

// Read the base32 TOTP secret shown on the authenticator-app setup page. It renders
// as an uppercase base32 run (>= 16 chars). Prefer the "Copy secret key" adjacent
// text; fall back to scanning visible text for a base32 token.
async function readTotpSecret(page: Page): Promise<string> {
    const secret = await page.evaluate(() => {
        const rx = /\b[A-Z2-7]{16,}\b/
        for (const el of Array.from(document.querySelectorAll('body *'))) {
            const t = (el.textContent || '').trim()
            if (el.children.length === 0 && rx.test(t)) {
                const m = t.match(rx)
                if (m) return m[0]
            }
        }
        return ''
    })
    if (!secret) throw new Error('Could not find the TOTP secret on the MFA setup page')
    return secret
}

// Fill the 6-box PinInput with a freshly-computed TOTP code and submit. If the
// verify fails (a code that straddled a 30s rollover), recompute once and retry.
async function enterTotp(page: Page, secret: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const code = totp(secret)
        const inputs = page.locator('[role="group"] input, input[aria-label="PinInput"]')
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
        // Success if we leave the app-setup pin step (recovery codes / step-up appears).
        const moved = await page
            .getByRole('button', { name: /go to safeinsights/i })
            .waitFor({ state: 'visible', timeout: 8_000 })
            .then(() => true)
            .catch(() => false)
        const stepUp = await page
            .getByRole('textbox', { name: /verification code/i })
            .waitFor({ state: 'visible', timeout: 2_000 })
            .then(() => true)
            .catch(() => false)
        if (moved || stepUp) return
    }
}

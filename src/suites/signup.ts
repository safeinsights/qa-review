import type { Inbox } from '../engine/mailtm'
import { activeDomain, createInbox, extractSignupUrl, waitForMessage } from '../engine/mailtm'
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

// --- helpers (invite UI selectors verified live in a later task) ---

async function inviteUser(
    ctx: RunContext,
    email: string,
    role: 'researcher' | 'reviewer'
): Promise<void> {
    // PLACEHOLDER driven live in a later task: navigate to the admin invite UI,
    // enter the email, choose the role, and submit. Assert a success confirmation.
    await ctx.page.goto(`${ctx.baseURL}/admin/members`, { waitUntil: 'domcontentloaded' })
    await ctx.page
        .getByRole('button', { name: /invite/i })
        .first()
        .click()
    await ctx.page.getByLabel(/email/i).fill(email)
    // role selection + submit filled in during live wiring
    void role
}

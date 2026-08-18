import {
    completeSignup,
    INVITE_EMAIL_TIMEOUT_MS,
    type InvitedRole,
    inviteUser,
    isInviteEmail,
} from '../engine/flows/signup'
import type { Inbox } from '../engine/mailtm'
import { activeDomain, createInbox, extractSignupUrl, waitForMessage } from '../engine/mailtm'
import type { RunContext, Suite } from './types'

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
            run: ctx =>
                ctx.step(async () => {
                    const domain = await activeDomain()
                    const researcher = await createInbox(domain)
                    const reviewer = await createInbox(domain)
                    ctx.state.signupInboxes = [
                        { role: 'researcher', inbox: researcher },
                        { role: 'reviewer', inbox: reviewer },
                    ] satisfies SignupInbox[]
                }),
        },
        {
            name: 'Invite both users as admin',
            run: async ctx => {
                await ctx.step('Invite both users as admin', async () => {
                    for (const { role, inbox } of inboxes(ctx)) {
                        await inviteUser(ctx.page, ctx.baseURL, inbox.address, role)
                    }
                })
            },
        },
        {
            name: 'Each invited user completes signup and sees their dashboard',
            run: async ctx => {
                for (const { role, inbox } of inboxes(ctx)) {
                    await ctx.step(`Sign up the invited ${role}`, async () => {
                        // Invite email can take a while to be delivered; give it a
                        // realistic budget rather than the 60s default.
                        const message = await waitForMessage(
                            inbox,
                            isInviteEmail,
                            INVITE_EMAIL_TIMEOUT_MS
                        )
                        const url = extractSignupUrl(message)
                        const { userId } = await completeSignup(ctx.page, url)
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

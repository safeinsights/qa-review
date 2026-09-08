import { expect, type Locator, type Page } from '@playwright/test'
import { clickUntil } from '../engine/flows/interactions'
import {
    completeSignup,
    INVITE_EMAIL_TIMEOUT_MS,
    inviteUser,
    isInviteEmail,
    SIGNUP_PASSWORD,
} from '../engine/flows/signup'
import type { Inbox } from '../engine/mailtm'
import { activeDomain, createInbox, extractSignupUrl, waitForMessage } from '../engine/mailtm'
import { totp } from '../engine/totp'
import type { RunContext, Suite } from './types'

// Covers the three shapes an invitation landing page takes, and what a SECOND
// invitation does to an account that already exists:
//
//   signed out                     -> "Create New Account" / "Login with existing account"
//   signed in AS the invited email -> /join-team, Accept / Decline / Skip for now
//   signed in as SOMEONE ELSE      -> "You must be signed out to accept invitations"
//
// One address is invited into BOTH a research lab (openstax-lab) and a data partner
// (openstax): the first invite builds the account from scratch, the second must fold
// into it. A third invite, to a DIFFERENT address, is then accepted through "Login
// with existing account" — the path the invitation page itself recommends ("merging
// accounts later is not supported").
//
// The through-line is that MFA and the security key are set up EXACTLY ONCE. Both are
// account-scoped, not org-scoped ("You need this key to access your outputs in every
// organization you belong to"), so every later accept must land on a dashboard rather
// than back in enrolment. Re-enrolling would silently strip the account's ability to
// decrypt everything encrypted to the old key.
//
// KNOWN DEFECT — see "the merge does not carry the email over" below. The last two
// steps assert what staging does TODAY, not what it should do; each carries a TODO
// naming the expected behaviour so the suite flips to the requirement in one edit.

const RL_ORG = 'OPE-Research Lab'
const DP_ORG = 'Openstax'

// Straight apostrophes here, curly ones in the invitation copy — match either rather
// than pinning a character that is one content edit away from changing.
const RESEARCHER_EMPTY = /You haven['’]t yet participated in a study/
const REVIEWER_EMPTY = /You haven['’]t yet participated in reviewing a study/
const SIGNED_OUT_GATE = /You must be signed out to accept invitations/
// The whole sentence, date included — captured once and compared after every later
// milestone. A second enrolment on the same day would leave the date equal, which is
// why the real "only once" evidence is that key GENERATION never renders again.
const KEY_GENERATED_ON = /You generated a security key on [^.]+\./
const SIGNIN_REJECTED = /Invalid login credentials\. Please double-check your email and password\./

const originOf = (baseURL: string): string => new URL(baseURL).origin

// Every screen here is client-rendered behind a Clerk round trip, so the FIRST element
// after a navigation is reached with waitFor (the global navigation budget) rather than
// an expect (the much shorter assertion budget). waitFor throws on timeout, so it is
// the assertion — not a weaker form of one. Later checks on an already-settled page
// stay as expect().
const VISIBLE = { state: 'visible' } as const

const primaryInbox = (ctx: RunContext): Inbox => ctx.state.primaryInbox as Inbox
const mergeInbox = (ctx: RunContext): Inbox => ctx.state.mergeInbox as Inbox
const consumedInvites = (ctx: RunContext): string[] => ctx.state.consumedInvites as string[]

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Pull the next NOT-YET-SEEN invitation URL out of an inbox.
//
// The primary address receives two invites within a minute of each other, and the
// invite email names neither the org nor anything else that tells them apart. Rather
// than depend on mail.tm's listing order — which is not a contract we control —
// exclude the URLs already taken, so each call returns the one just sent.
async function nextInviteUrl(inbox: Inbox, consumed: string[]): Promise<string> {
    const message = await waitForMessage(
        inbox,
        m => {
            if (!isInviteEmail(m)) return false
            try {
                return !consumed.includes(extractSignupUrl(m))
            } catch {
                return false
            }
        },
        INVITE_EMAIL_TIMEOUT_MS
    )
    const url = extractSignupUrl(message)
    consumed.push(url)
    return url
}

// A code computed in the last seconds of its 30s window can expire between fill and
// submit, and a rejected code is indistinguishable from a slow page until the whole
// action timeout has burned. Stepping over that boundary is deterministic and cheaper
// than a retry loop that has to tell the two apart.
async function freshTotp(secret: string): Promise<string> {
    const msLeft = 30_000 - (Date.now() % 30_000)
    if (msLeft < 8_000) await sleep(msLeft + 500)
    return totp(secret)
}

// Mirrors management-app's fillPinInput: the test-id group when it is present, the
// role=group boxes otherwise (the account screens render the same 6-box Mantine
// PinInput without the test id).
async function fillPin(page: Page, code: string): Promise<void> {
    let inputs = page.getByTestId('sms-pin-input').locator('input')
    if ((await inputs.count()) === 0) {
        inputs = page.locator('[role="group"] input[placeholder="0"]')
    }
    if ((await inputs.count()) === 0) {
        inputs = page.locator('[role="group"] input:not([type="hidden"])')
    }
    for (let i = 0; i < code.length; i++) await inputs.nth(i).fill(code[i])
}

// Sign in as an account this suite created. ctx.loginAs only covers the shared role
// accounts, and their second factor comes from settings; this one's TOTP secret was
// minted during signup and lives in ctx.state.
async function signInWithTotp(page: Page, email: string, mfaSecret: string): Promise<void> {
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(SIGNUP_PASSWORD)
    await page.getByRole('button', { name: 'Login' }).click()
    const authenticator = page
        .getByRole('button', { name: /authenticator app verification/i })
        .or(page.getByRole('link', { name: /authenticator app verification/i }))
    // Wait on the code BOXES, not the "Verify code" button: that button is disabled
    // until all six digits are in, and clickUntil requires its target to be enabled —
    // so it would re-click the picker until the budget ran out on a control that was
    // never going to enable itself before we typed.
    await clickUntil(authenticator, page.locator('[role="group"] input').first())
    await fillPin(page, await freshTotp(mfaSecret))
    await page.getByRole('button', { name: /verify code/i }).click()
}

// Read the "You generated a security key on <date>." notice. /user-key renders the
// existing-key view for an account that holds one and bounces a keyless account to
// /account/keys, so reaching this view is itself the assertion that a key is enrolled.
async function readSecurityKeyNotice(page: Page, baseURL: string): Promise<string> {
    await page.goto(`${originOf(baseURL)}/user-key`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: /existing security key/i }).waitFor(VISIBLE)
    const notice = page.getByText(KEY_GENERATED_ON)
    await expect(notice).toBeVisible()
    return ((await notice.innerText()).match(KEY_GENERATED_ON) ?? [''])[0]
}

// Assert the account still holds the SAME single MFA enrolment and the SAME security
// key it left signup with — i.e. whatever just happened did not re-run enrolment.
async function expectEnrolledExactlyOnce(ctx: RunContext): Promise<void> {
    const page = ctx.page
    // Key generation is a full-page step with its own copy control; if the app had
    // routed back into it, this is what would be on screen instead of a dashboard.
    await expect(page.getByRole('button', { name: /copy key/i })).toHaveCount(0)
    await expect(page.getByText(/Multi-Factor Authentication/i)).toHaveCount(0)

    const totpEnabled = await page.evaluate(() => {
        const clerk = (window as unknown as { Clerk?: { user?: { totpEnabled?: boolean } } }).Clerk
        return clerk?.user?.totpEnabled === true
    })
    expect(totpEnabled, 'the account lost its authenticator enrolment').toBe(true)

    const notice = await readSecurityKeyNotice(page, ctx.baseURL)
    expect(notice, 'a second security key was generated').toBe(ctx.state.keyNotice as string)
}

const audienceTab = (page: Page, name: string): Locator =>
    page.locator('.mantine-SegmentedControl-label').filter({ hasText: new RegExp(`^${name}$`) })

async function gotoMyDashboard(page: Page, baseURL: string): Promise<void> {
    await page.goto(`${originOf(baseURL)}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'My dashboard', level: 1 }).waitFor(VISIBLE)
    // "My studies" renders only once the studies query settles, so waiting for it is
    // what makes a following empty-state assertion meaningful rather than a race
    // against an unpopulated list.
    await page.getByRole('heading', { name: 'My studies', level: 3 }).waitFor(VISIBLE)
}

export const inviteMergeSuite: Suite = {
    name: 'invite-merge',
    description:
        'One address invited into a research lab and a data partner, then a second address merged into the same account — MFA and the security key enrolled exactly once',
    roles: ['admin'],
    steps: [
        {
            name: 'Create mail.tm inboxes for the invited user and the merge invite',
            run: ctx =>
                ctx.step(async () => {
                    const domain = await activeDomain()
                    ctx.state.primaryInbox = await createInbox(domain)
                    ctx.state.mergeInbox = await createInbox(domain)
                    ctx.state.consumedInvites = []
                }),
        },
        {
            name: 'Invite the new user into the Research Lab',
            run: ctx =>
                ctx.step(async () => {
                    const inbox = primaryInbox(ctx)
                    await inviteUser(ctx.page, ctx.baseURL, inbox.address, 'researcher')
                    ctx.state.rlInviteUrl = await nextInviteUrl(inbox, consumedInvites(ctx))
                }),
        },
        {
            name: 'Invite the SAME address into the Data Partner org',
            run: ctx =>
                ctx.step(async () => {
                    const inbox = primaryInbox(ctx)
                    await inviteUser(ctx.page, ctx.baseURL, inbox.address, 'reviewer')
                    ctx.state.dpInviteUrl = await nextInviteUrl(inbox, consumedInvites(ctx))
                }),
        },
        {
            name: 'The Research Lab invite is refused while the admin is still signed in',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    // The admin who sent the invites is still signed in. An invitation
                    // binds to whoever accepts it, so the app refuses to act on one from
                    // an authenticated browser and offers a sign-out instead.
                    await page.goto(ctx.state.rlInviteUrl as string, {
                        waitUntil: 'domcontentloaded',
                    })
                    await page.getByText(SIGNED_OUT_GATE).waitFor(VISIBLE)
                    // Same URL either side of the sign-out, so there is no navigation to
                    // wait on — only a re-render once Clerk has torn the session down.
                    // clickUntil is the bounded way to sit out that gap; the button
                    // detaches on success, so it is not re-clicked.
                    await clickUntil(
                        page.getByRole('button', { name: /sign out to continue/i }),
                        page.getByRole('link', { name: /create new account/i })
                    )
                    await expect(
                        page.getByRole('link', { name: /login with existing account/i })
                    ).toBeVisible()
                }),
        },
        {
            name: 'The invited user completes signup from the Research Lab invite',
            run: ctx =>
                ctx.step(async () => {
                    const { userId, mfaSecret } = await completeSignup(
                        ctx.page,
                        ctx.state.rlInviteUrl as string,
                        ctx.baseURL
                    )
                    ctx.trackUser(userId)
                    ctx.state.userId = userId
                    ctx.state.mfaSecret = mfaSecret
                    ctx.state.keyNotice = await readSecurityKeyNotice(ctx.page, ctx.baseURL)
                }),
        },
        {
            name: 'My dashboard is empty, with no audience toggle for a single-org user',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    await gotoMyDashboard(page, ctx.baseURL)
                    await expect(page.getByText(RESEARCHER_EMPTY)).toBeVisible()
                    // The Reviewer/Researcher toggle is earned by belonging to both a lab
                    // and a data partner; this account is only in the lab so far.
                    await expect(page.getByRole('radio', { name: 'Reviewer' })).toHaveCount(0)
                }),
        },
        {
            name: 'The same user accepts the Data Partner invite from the join-team page',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    // Signed in AS the invited address: the app recognises the account and
                    // offers to join the team rather than build a second one.
                    await page.goto(ctx.state.dpInviteUrl as string, {
                        waitUntil: 'domcontentloaded',
                    })
                    await page
                        .getByRole('heading', {
                            name: new RegExp(`You.{0,3}ve been invited to join ${DP_ORG}`),
                        })
                        .waitFor(VISIBLE)
                    await expect(
                        page.getByText(/Join the team to access its dashboard and studies/)
                    ).toBeVisible()
                    await expect(
                        page.getByText(/This invitation will expire in 7 days/)
                    ).toBeVisible()
                    await expect(
                        page.getByRole('button', { name: 'Decline invitation' })
                    ).toBeVisible()
                    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible()

                    await page.getByRole('button', { name: 'Accept invitation' }).click()
                    await page.getByText(`You have been added to ${DP_ORG}.`).waitFor(VISIBLE)
                }),
        },
        {
            name: 'Joining the second org did not re-enrol MFA or the security key',
            run: ctx => ctx.step(() => expectEnrolledExactlyOnce(ctx)),
        },
        {
            name: 'My dashboard is empty for BOTH audiences now that the user is in two orgs',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    await gotoMyDashboard(page, ctx.baseURL)
                    await expect(page.getByRole('radio', { name: 'Researcher' })).toBeChecked()
                    await expect(page.getByText(RESEARCHER_EMPTY)).toBeVisible()

                    // Mantine renders the segmented control as a zero-size radio behind a
                    // label, so the label is the only clickable half.
                    await audienceTab(page, 'Reviewer').click()
                    await expect(page.getByRole('radio', { name: 'Reviewer' })).toBeChecked()
                    // Switching audience refetches, so this is a fresh render rather than
                    // a check against something already on screen.
                    await page.getByText(REVIEWER_EMPTY).waitFor(VISIBLE)
                }),
        },
        {
            name: 'Admin invites a SECOND address into the Research Lab',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.loginAs('admin')
                    const inbox = mergeInbox(ctx)
                    await inviteUser(ctx.page, ctx.baseURL, inbox.address, 'researcher')
                    ctx.state.mergeInviteUrl = await nextInviteUrl(inbox, consumedInvites(ctx))
                }),
        },
        {
            name: 'The second invite is accepted through "Login with existing account"',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    // Admin is signed in again, so the same signed-out gate stands between
                    // us and the invitation.
                    await page.goto(ctx.state.mergeInviteUrl as string, {
                        waitUntil: 'domcontentloaded',
                    })
                    await page.getByText(SIGNED_OUT_GATE).waitFor(VISIBLE)
                    const existing = page.getByRole('link', {
                        name: /login with existing account/i,
                    })
                    await clickUntil(
                        page.getByRole('button', { name: /sign out to continue/i }),
                        existing
                    )
                    await clickUntil(existing, page.getByLabel('Password'))
                    await signInWithTotp(
                        page,
                        primaryInbox(ctx).address,
                        ctx.state.mfaSecret as string
                    )
                    // The invite is folded into the account that signed in — no new account,
                    // and straight onto the org dashboard rather than back into enrolment.
                    await page.getByText(`You have been added to ${RL_ORG}.`).waitFor(VISIBLE)
                }),
        },
        {
            name: 'The merge did not re-enrol MFA or the security key either',
            run: ctx => ctx.step(() => expectEnrolledExactlyOnce(ctx)),
        },
        {
            name: 'The merged account is still one account (My dashboard stays empty)',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    await gotoMyDashboard(page, ctx.baseURL)
                    await expect(page.getByText(RESEARCHER_EMPTY)).toBeVisible()
                    const dbId = await page.evaluate(() => {
                        const clerk = (
                            window as unknown as {
                                Clerk?: { user?: { publicMetadata?: { user?: { id?: string } } } }
                            }
                        ).Clerk
                        return clerk?.user?.publicMetadata?.user?.id ?? ''
                    })
                    expect(dbId, 'the merge created a second SafeInsights user').toBe(
                        ctx.state.userId as string
                    )
                }),
        },
        {
            name: 'Settings lists the account emails after the merge',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    await clickUntil(
                        page.getByRole('button', { name: /toggle profile menu/i }),
                        page.getByRole('menuitem', { name: 'Settings' })
                    )
                    await page.getByRole('menuitem', { name: 'Settings' }).click()
                    const account = page
                        .getByRole('dialog')
                        .filter({ hasText: /Manage your account info/i })
                    await account.getByText('Email addresses').waitFor(VISIBLE)
                    await expect(account.getByText(primaryInbox(ctx).address)).toBeVisible()

                    // TODO(merge-email): asserts CURRENT behaviour. Accepting an invitation
                    // through "Login with existing account" merges the ORG membership but
                    // never adds the invited address to the account, so Settings still shows
                    // a single email. Confirmed on staging 2026-09-08, and not an
                    // already-a-member short-circuit: a control run against an org the
                    // account did NOT belong to added the org and still dropped the address.
                    // The invitation page recommends this path precisely because "merging
                    // accounts later is not supported", so the address is expected to land
                    // here. When that is fixed, flip this to a toBeVisible().
                    await expect(account.getByText(mergeInbox(ctx).address)).toHaveCount(0)
                }),
        },
        {
            name: 'Signing in with the second address',
            run: ctx =>
                ctx.step(async () => {
                    const page = ctx.page
                    await page.evaluate(async () => {
                        const clerk = (
                            window as unknown as { Clerk?: { signOut?: () => Promise<void> } }
                        ).Clerk
                        if (clerk?.signOut) await clerk.signOut()
                    })
                    await page.goto(`${originOf(ctx.baseURL)}/account/signin`, {
                        waitUntil: 'domcontentloaded',
                    })
                    await page.getByLabel('Email').fill(mergeInbox(ctx).address)
                    await page.getByLabel('Password').fill(SIGNUP_PASSWORD)
                    await page.getByRole('button', { name: 'Login' }).click()

                    // TODO(merge-email): asserts CURRENT behaviour — the second address never
                    // reached the account (see the step above), so the app answers "Couldn't
                    // find your account". It is expected to sign in to the MERGED account and
                    // land on the Research Lab dashboard; when the merge is fixed, replace
                    // this with signInWithTotp + a dashboard assertion.
                    await page.getByText(SIGNIN_REJECTED).waitFor(VISIBLE)
                }),
        },
        {
            name: 'Switch to the admin account for cleanup authority',
            run: ctx => ctx.step(() => ctx.loginAs('admin')),
        },
    ],
}

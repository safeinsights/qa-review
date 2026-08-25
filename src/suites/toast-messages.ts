import { expect, type Locator, type Page } from '@playwright/test'
import { beginProposal, chooseOrgAndCaptureId, openProposalDashboard } from '../engine/flows/study'
import type { RunContext, Suite } from './types'

// Verifies the app's TOAST messages across all three roles. Every toast in
// management-app is a Mantine notification (@mantine/notifications) — there is no second
// toast mechanism — and both app shells mount the tray identically: `position="top-right"`,
// autoClose 8s. So the selectors here apply to all ~95 toast call sites.
//
// The suite starts as admin and switches accounts with ctx.loginAs, ending as the
// researcher who authored the throwaway draft so teardown cleanup has delete authority.
//
// ROLE COVERAGE, and its honest limits:
//   admin      — the SI-admin legal upload reject, plus the org-admin data source
//                add/delete pair (the only `reportSuccess()` call sites in the app).
//   researcher — the "Proposal draft deleted" toast.
//                The four profile "Saved"/"Save failed" toasts are deliberately NOT here:
//                the `user-profile` suite already asserts them card by card, and a profile
//                is a SINGLETON per user. Two suites writing the same profile — that one
//                restoring what it finds, this one converging on its own values — is a
//                cross-suite flake waiting to happen, so that surface stays its owner's.
//   session    — the inactivity WARNING toast, reached by faking the page clock rather
//                than idling for eight hours. Its partner 'Session Expired' toast is
//                deliberately not asserted; see the step for why.
//   reviewer   — the shared tray only. There is NO reviewer-specific toast this suite can
//                trigger deterministically: on that side they are all either error paths
//                (Failed to update study status, Failed to submit review, decryption
//                failed), cross-session realtime notices ("Decision submitted", which
//                needs two browsers at once), or gated behind a job with encrypted
//                results — 'Invalid private key' fires from the decrypt form's
//                isNotEmpty() validator, so it needs no valid key, but the form only
//                renders when a job HAS artifacts. Building that fixture is most of
//                study-happy-path, and qa currently holds no such study. Covering it
//                properly means the QA API (`qar study-state --result …`) against a study
//                that already has a job, which belongs in its own suite.
//
// The red reportError/reportMutationError family (45 sites) is likewise uncovered: it
// needs an induced server failure, and faking one is the kind of masking that makes a
// suite lie.
//
// Writes: the data source pair and the draft proposal are created and then deleted by the
// suite itself — the deletes ARE the assertions. The researcher's first name is edited and
// restored in the same step. A run that dies mid-step can therefore leave one data source
// named `QA toast probe <tag>`, one draft titled `Toast probe draft <tag>` (registered with
// ctx.trackStudy on that failure path only, so teardown cleanup catches it).

// Mirrors INACTIVITY_TIMEOUT_MS / WARNING_THRESHOLD_MS in the app's src/lib/types.ts:
// eight hours idle signs you out, with a warning over the last ten minutes.
const INACTIVITY_TIMEOUT_MS = 8 * 60 * 60 * 1000
// How far off the timeout the faked clock parks, in both directions. Five minutes sits
// well inside the app's ten-minute warning window and well past the timeout on the other
// side, so neither edge is close enough for a stale lastActiveAt to land the app in the
// branch this step is not asserting.
const EXPIRY_OFFSET_MS = 5 * 60 * 1000

const ADMIN_ORG = 'openstax' // the org the shared admin account administers
// ?audience=researcher pins the personal dashboard's tab, so the draft row is on screen
// regardless of which tab the signed-in account defaults to.
const RESEARCHER_DASHBOARD = '/dashboard?audience=researcher'

// Mantine's public class names. `role=alert` alone is NOT specific enough to find a toast:
// the App Router mounts its own permanently-empty `div[role=alert]` route announcer.
const TOAST = '.mantine-Notification-root'
const TOAST_TITLE = '.mantine-Notification-title'
const TOAST_BODY = '.mantine-Notification-description'
const TOAST_CLOSE = '.mantine-Notification-closeButton'
const POPOVER = '.mantine-Popover-dropdown'

const DELETE_SOURCE_CONFIRM =
    'Are you sure you want to delete this data source? This cannot be undone.'

type ExpectedToast = {
    // A RegExp for the session-expiry warning only: its description holds a live minute
    // count plus the label of the button embedded in it, so there is no exact string.
    message: string | RegExp
    // Omitted for the message-only toasts — the invitation notices raise no title, and
    // asserting that absence is the point (a title-based selector would miss them).
    title?: string
    // Mantine palette key, read back from the `--notification-color` custom property
    // Mantine writes inline from the `color` prop. This is what makes a toast read as
    // success or failure, so it is part of the message being verified. Optional because
    // the session-expiry notices in activity-context.tsx pass NO `color`, so there is no
    // custom property on them to match — asserting one would fail on a toast that is
    // behaving exactly as written.
    color?: 'green' | 'teal' | 'red'
}

function toastWith(page: Page, message: string | RegExp): Locator {
    return page.locator(TOAST).filter({ hasText: message })
}

async function expectToast(page: Page, expected: ExpectedToast): Promise<void> {
    const toast = toastWith(page, expected.message)
    // waitFor, not expect, for the appearance: a toast can be gated on a server round trip
    // or on hydration, and that needs the action timeout rather than the shorter assertion
    // one. (Timeouts are configured globally, never inline.)
    await toast.waitFor({ state: 'visible' })
    await expect(toast).toHaveAttribute('role', 'alert')
    await expect(toast.locator(TOAST_BODY)).toHaveText(expected.message)
    if (expected.title) {
        await expect(toast.locator(TOAST_TITLE)).toHaveText(expected.title)
    } else {
        await expect(toast.locator(TOAST_TITLE)).toHaveCount(0)
    }
    if (expected.color) {
        await expect(toast).toHaveAttribute(
            'style',
            new RegExp(`--notification-color:\\s*var\\(--mantine-color-${expected.color}-filled\\)`)
        )
    }
}

// Clear the tray between checks so a still-open toast can neither satisfy the next
// assertion nor cover a control. Clicking each close button beats waiting out the 8s
// autoClose; the clicks are best-effort (one can hit autoClose mid-loop, detaching the
// node), and the `toHaveCount(0)` below is the real gate.
async function dismissToasts(page: Page): Promise<void> {
    for (const closeButton of await page.locator(TOAST_CLOSE).all()) {
        await closeButton.click().catch(() => {})
    }
    await expect(page.locator(TOAST)).toHaveCount(0)
}

// A server-rendered control is present and clickable BEFORE React wires its onClick, so a
// one-shot click can land on a dead button and nothing opens (the same failure the
// inviteUser flow documents). Re-click until the target actually renders.
async function clickUntil(control: Locator, target: Locator): Promise<void> {
    await expect(async () => {
        await control.click()
        await expect(target).toBeVisible()
    }).toPass()
}

async function openModal(page: Page, buttonName: string, dialogName: string): Promise<Locator> {
    const dialog = page.getByRole('dialog', { name: dialogName })
    await clickUntil(page.getByRole('button', { name: buttonName }), dialog)
    return dialog
}

// The two invitation notices, raised by useInvitationNotices() straight off these query
// params — no invitation, no org and no second account needed. Reused per role because it
// is the one toast pair every signed-in user can reach, so it doubles as "this role's shell
// mounts the tray at all".
async function expectInvitationNotices(ctx: RunContext): Promise<void> {
    const skipped = `Skip Org ${ctx.tag}`
    const declined = `Decline Lab ${ctx.tag}`
    const params = new URLSearchParams({ skip: skipped, decline: declined })
    await ctx.page.goto(`${ctx.baseURL}/dashboard?${params}`, { waitUntil: 'domcontentloaded' })
    await expectToast(ctx.page, {
        message: `You have opted to skip the invitation to ${skipped}. The invitation can be found in your inbox and is valid for 7 days.`,
        color: 'green',
    })
    await expectToast(ctx.page, {
        message: `You've declined ${declined}'s invitation.`,
        color: 'green',
    })
    // The app pins ids on these two so it can address them later.
    await expect(ctx.page.locator('#skip-invitation')).toBeVisible()
    await expect(ctx.page.locator('#decline-invitation')).toBeVisible()
    // The hook is also meant to router.replace() the params away once the toasts are up. On
    // qa that often does NOT happen: ?skip=/?decline= survive, so a reload re-fires the
    // toast — OTTER-736.
    //
    // Not asserted here, and please don't add it back without reading this first. An
    // assertion for it WAS written and then reverted, because it is not deterministic under
    // automation: it failed as intended on one run and passed on the very next run of a
    // byte-identical file, while the bug still reproduced 3/3 by hand in a real browser
    // (toast at ~460ms, the param present at the toast and 2.5s later, with and without a
    // second param alongside it). A check that goes green while the defect is present is
    // worse than no check — and it may have been passing for an unrelated reason, since
    // user-studies.tsx runs its OWN router.replace for the audience tab, which could strip
    // `skip` without the cleanup ever running.
    //
    // What it would take to assert this honestly: work out why a Playwright context and a
    // hand-driven browser disagree, then write a check that fails reliably while the bug is
    // there. Until then this stays a ticket, not a test.
    await dismissToasts(ctx.page)
}

// Derived from ctx.tag rather than threaded through ctx.state: these have to survive a
// single-step retry, and a pure function of the run tag does that without depending on an
// earlier step having run in THIS process.
function probeSourceName(ctx: RunContext): string {
    return `QA toast probe ${ctx.tag}`
}
function probeDraftTitle(ctx: RunContext): string {
    return `Toast probe draft ${ctx.tag}`
}
function settingsUrl(ctx: RunContext): string {
    return `${ctx.baseURL}/${ADMIN_ORG}/admin/settings`
}

export const toastMessagesSuite: Suite = {
    name: 'toast-messages',
    description:
        'Verify toast notifications (text, title, severity, dismissal) as admin, reviewer and researcher',
    roles: ['admin'],
    steps: [
        {
            name: 'Admin: invitation skip + decline toasts',
            run: ctx => ctx.step(() => expectInvitationNotices(ctx)),
        },
        {
            name: 'Admin: unsupported-file toast in the legal upload modal',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.goto(`${ctx.baseURL}/admin/safeinsights/legal`, {
                        waitUntil: 'domcontentloaded',
                    })
                    const dialog = await openModal(ctx.page, 'Upload', 'Terms of Service')
                    // The dropzone accepts only .md and react-dropzone validates the file
                    // input's own change event, so a .txt takes the onDropRejected path:
                    // nothing is uploaded and no draft row is created.
                    await dialog.locator('input[type="file"]').setInputFiles({
                        name: `not-markdown-${ctx.tag}.txt`,
                        mimeType: 'text/plain',
                        buffer: Buffer.from('this is not markdown'),
                    })
                    await expectToast(ctx.page, {
                        title: 'Unsupported file',
                        message: 'Please upload a single Markdown (.md) file.',
                        color: 'red',
                    })
                    await dismissToasts(ctx.page)
                    await ctx.page.keyboard.press('Escape')
                    await expect(dialog).toBeHidden()
                }),
        },
        {
            name: 'Admin: data source added toast',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.goto(settingsUrl(ctx), { waitUntil: 'domcontentloaded' })
                    const dialog = await openModal(ctx.page, 'Add Data Source', 'Add Data Source')
                    // Anchored accessible names: the modal's URL row inputs are labelled
                    // "New URL" and "New URL description", and an unanchored /description/
                    // matches that one too (strict-mode violation).
                    await dialog.getByRole('textbox', { name: /^Name/ }).fill(probeSourceName(ctx))
                    await dialog
                        .getByRole('textbox', { name: /^Description/ })
                        .fill('Created by the toast-messages suite; removed by the next step.')
                    await dialog.getByRole('button', { name: 'Save Data Source' }).click()
                    // reportSuccess(): teal, and a title the caller never passes ('Success'
                    // is the helper's default).
                    await expectToast(ctx.page, {
                        title: 'Success',
                        message: 'Data source added successfully',
                        color: 'teal',
                    })
                    await expect(dialog).toBeHidden()
                    await dismissToasts(ctx.page)
                }),
        },
        {
            name: 'Admin: data source deleted toast (and cleanup)',
            run: ctx =>
                ctx.step(async () => {
                    const name = probeSourceName(ctx)
                    // Re-navigate so this step stands alone on a retry.
                    await ctx.page.goto(settingsUrl(ctx), { waitUntil: 'domcontentloaded' })
                    // The innermost div holding BOTH the name and a delete control is the
                    // row. Its ancestors match the same filters, and a parent precedes its
                    // child in document order, so .last() is the row itself.
                    const row = ctx.page
                        .locator('div')
                        .filter({ hasText: name })
                        .filter({ has: ctx.page.getByLabel('Delete data source') })
                        .last()
                    const confirm = ctx.page
                        .locator(POPOVER)
                        .filter({ hasText: DELETE_SOURCE_CONFIRM })
                    await clickUntil(
                        row
                            .locator('button')
                            .filter({ has: ctx.page.getByLabel('Delete data source') }),
                        confirm
                    )
                    await confirm.getByRole('button', { name: 'Yes' }).click()
                    await expectToast(ctx.page, {
                        title: 'Success',
                        message: 'Data source was deleted successfully',
                        color: 'teal',
                    })
                    await expect(ctx.page.getByText(name, { exact: true })).toHaveCount(0)
                    await dismissToasts(ctx.page)
                }),
        },
        {
            name: 'Reviewer: session renders toasts',
            // No reviewer-SPECIFIC toast is asserted here — see the role-coverage note at
            // the top of this file for why there isn't one to reach. What this does prove is
            // that the reviewer account's shell mounts the tray and renders into it.
            run: ctx =>
                ctx.step(async () => {
                    await ctx.loginAs('reviewer')
                    await expectInvitationNotices(ctx)
                }),
        },
        {
            name: 'Researcher: proposal draft deleted toast (and cleanup)',
            run: ctx =>
                ctx.step(async () => {
                    const title = probeDraftTitle(ctx)
                    // Signs in itself rather than inheriting a session from the step before
                    // it: the engine can jump to or retry one step in isolation, and a step
                    // that assumed its predecessor had just run would fail there for a
                    // reason that says nothing about toasts.
                    await ctx.loginAs('researcher')
                    // Fixture: the smallest thing the delete-draft toast needs is a DRAFT
                    // study with a known title. Proceeding to Step 2 creates the row;
                    // "Previous" flushes the title to it (in single-user mode that is the
                    // only write path). No toast is raised by either, so nothing to assert
                    // until the delete.
                    await openProposalDashboard(ctx.page, ctx.baseURL)
                    await beginProposal(ctx.page)
                    const studyId = await chooseOrgAndCaptureId(ctx.page)
                    try {
                        await ctx.page.getByLabel('Study Title').fill(title)
                        await ctx.page.getByRole('button', { name: /^Previous$/ }).click()
                        await ctx.page.getByTestId('org-select').waitFor({ state: 'visible' })

                        await ctx.page.goto(`${ctx.baseURL}${RESEARCHER_DASHBOARD}`, {
                            waitUntil: 'domcontentloaded',
                        })
                        // Per-row aria-label, so this is unique to THIS run's draft. Its
                        // presence is also the proof that the title above persisted.
                        const deleteDraft = ctx.page.getByLabel(`Delete draft study ${title}`)
                        const modal = ctx.page.getByRole('dialog', {
                            name: 'Confirm proposal draft deletion?',
                        })
                        await clickUntil(deleteDraft, modal)
                        await modal
                            .getByRole('button', { name: 'Yes, delete proposal draft' })
                            .click()
                        await expectToast(ctx.page, {
                            title: 'Proposal draft deleted',
                            message: `Proposal draft ${title} was successfully deleted`,
                            color: 'green',
                        })
                        await expect(deleteDraft).toHaveCount(0)
                        await dismissToasts(ctx.page)
                    } catch (error) {
                        // Register for id-based teardown cleanup ONLY when the in-app delete
                        // did NOT happen. Tracking it unconditionally made every GREEN run
                        // report `cleanup ok: false`: the cleanup DELETE answers 403 for a
                        // study the app has already soft-deleted, and cleanup counts only 2xx
                        // and 404 as done. A cleanup warning that fires on success is a
                        // cleanup warning people learn to ignore.
                        ctx.trackStudy(studyId)
                        throw error
                    }
                }),
        },
        {
            // LAST on purpose, for two reasons: it signs the account out, and Playwright
            // has no way to uninstall a faked clock (it is installed for the whole browser
            // CONTEXT). Nothing after it would start from a clean session or a real clock.
            // Teardown cleanup is unaffected — a green run tracks no ids, so the client
            // issues no authenticated requests.
            name: 'Session expiry: inactivity warning toast, then auto-logout',
            run: ctx =>
                ctx.step(async () => {
                    // Signs in itself, like the researcher step, so a retry of this one
                    // step stands alone.
                    await ctx.loginAs('admin')
                    await ctx.page.goto(`${ctx.baseURL}/dashboard`, {
                        waitUntil: 'domcontentloaded',
                    })
                    // The signed-in AppShell mounts BOTH the notification tray and the
                    // ActivityContext that raises these toasts, so its footer is this
                    // step's readiness signal — not just "some page rendered".
                    await ctx.page.locator('.mantine-AppShell-footer').waitFor({ state: 'visible' })
                    let restoreFailure: Error | undefined
                    try {
                        // Park the page's Date five minutes short of the eight-hour
                        // timeout. setFixedTime, NOT install()/fastForward(): it fakes
                        // Date alone and leaves every timer running at real speed, so
                        // ActivityContext's own 10s interval fires by itself and Clerk's
                        // token refresh keeps working against the real server clock. It
                        // also survives a mid-step session.touch(), which writes a
                        // REAL-time lastActiveAt — still ~8h behind the faked now.
                        await ctx.page.clock.setFixedTime(
                            Date.now() + INACTIVITY_TIMEOUT_MS - EXPIRY_OFFSET_MS
                        )
                        await expectToast(ctx.page, {
                            title: 'Session Expiration Warning',
                            // The minute count is matched loosely on purpose: it is
                            // derived from Clerk's lastActiveAt, which is already seconds
                            // to minutes old by the time this runs, so pinning the number
                            // would flake on timing alone.
                            message: /logged out in \d+ minutes? due to inactivity/,
                        })
                        const warning = toastWith(ctx.page, 'Session Expiration Warning')
                        // The in-toast button is the user's only way out, which is why this
                        // notice ships with withCloseButton false and autoClose false.
                        // Both halves of that are part of the message.
                        await expect(
                            warning.getByRole('button', { name: 'Stay Signed In' })
                        ).toBeVisible()
                        await expect(warning.locator(TOAST_CLOSE)).toHaveCount(0)
                        // Past the timeout now. Clicking "Stay Signed In" first is NOT
                        // asserted: session.touch() writes a real-time lastActiveAt, which
                        // against the faked clock reads as another eight hours idle, so the
                        // app re-expires on the next tick. That is an artifact of faking
                        // time, not a defect — testing the recovery path needs a real idle
                        // session, which no suite can afford.
                        await ctx.page.clock.setFixedTime(
                            Date.now() + INACTIVITY_TIMEOUT_MS + EXPIRY_OFFSET_MS
                        )
                        // What IS asserted is the consequence: signed out, back on the
                        // sign-in form. The 'Session Expired' toast is not, and please read
                        // this before adding it. It is raised at the moment use-sign-out
                        // router.replace()s to /account/signin, which swaps the signed-in
                        // AppShell for FocusedLayout. Both mount their OWN <Notifications />
                        // against the same module-global Mantine store, so the notice
                        // probably does survive that swap — and "probably" is the whole
                        // problem: nobody has watched it happen in a real browser. Asserting
                        // unobserved behaviour across a layout swap plus a soft navigation is
                        // how a suite acquires a flake. Watch it by hand, then assert what
                        // you saw.
                        await ctx.page.getByLabel('Email').waitFor({ state: 'visible' })
                    } finally {
                        // Hand back a real, flowing clock. There is no uninstall, so this
                        // is the closest thing to one; without it a retry — or a jump to
                        // another step — would run eight hours in the future.
                        //
                        // Recorded rather than swallowed: a failed restore is not a local
                        // problem, it poisons every later step, which then fails for
                        // reasons that look nothing like the cause. Stashed on ctx.state
                        // and rethrown below only if the body itself succeeded — throwing
                        // from `finally` would replace a real assertion failure with this
                        // one and hide what actually broke.
                        restoreFailure = await ctx.page.clock
                            .setSystemTime(new Date())
                            .then(() => undefined)
                            .catch((cause: unknown) => cause as Error)
                    }
                    if (restoreFailure) {
                        throw new Error(
                            `could not restore the page clock (${restoreFailure.message}) — ` +
                                'every later step would run eight hours in the future',
                            { cause: restoreFailure }
                        )
                    }
                }),
        },
    ],
}

import { expect, type Locator, type Page } from '@playwright/test'
import {
    conformanceStep,
    openSettled,
    recordScan,
    type ScanOptions,
    scanCurrentPage,
    scanPage,
} from '../engine/flows/accessibility'
import { clickUntil } from '../engine/flows/interactions'
import { DEFAULT_RESEARCHER_ORG } from '../engine/flows/study'
import type { Role } from '../engine/types'
import type { RunContext, Step, Suite } from './types'

// Scans the researcher, reviewer and administrator pages with axe-core against
// WCAG 2.2 A/AA, signing in as each role so every page is seen as that persona.
//
// Scan steps RECORD rather than fail; the final step fails if any page had a
// violation (see conformanceStep).
//
// Unlike Lighthouse scores, axe violations are deterministic for a given build, so
// failing on them is a real verdict, not a flaky threshold.
//
// Study pages are not scanned here: shared-dashboard studies change from run to run,
// so accessibility-lifecycle scans them on a study it creates.

const LAB = DEFAULT_RESEARCHER_ORG
const DATA_ORG = 'openstax'
const SETTINGS = `/${DATA_ORG}/admin/settings`
const SI_LEGAL = '/admin/safeinsights/legal'

type Ready = (page: Page, ctx: RunContext) => Locator

async function record(
    ctx: RunContext,
    route: string,
    ready?: Ready,
    opts?: ScanOptions
): Promise<void> {
    recordScan(ctx, await scanPage(ctx, route, ready && (page => ready(page, ctx)), opts))
}

function scanStep(
    name: string,
    route: string | ((ctx: RunContext) => string),
    ready?: Ready,
    opts?: ScanOptions
): Step {
    return {
        name,
        run: ctx =>
            ctx.step(() =>
                record(ctx, typeof route === 'string' ? route : route(ctx), ready, opts)
            ),
    }
}

// Open a page, put it into a state no URL reaches (a form in edit mode, a field in
// error), and scan that.
function stateStep(
    name: string,
    route: string,
    act: (page: Page, ctx: RunContext) => Promise<void>,
    ready?: Ready,
    opts: ScanOptions = {}
): Step {
    return {
        name,
        run: ctx =>
            ctx.step(async () => {
                await openSettled(ctx, route, ready && (page => ready(page, ctx)))
                await act(ctx.page, ctx)
                recordScan(ctx, await scanCurrentPage(ctx, { ...opts, label: labelOf(name) }))
            }),
    }
}

// Open a dialog, scan it, and dismiss it with Escape — nothing is ever submitted, so
// these can run against the shared accounts' real data. clickUntil because the
// buttons are server-rendered and a pre-hydration click opens nothing.
function dialogStep(
    name: string,
    route: string,
    button: (page: Page) => Locator,
    before?: (page: Page) => Promise<void>
): Step {
    return {
        name,
        run: ctx =>
            ctx.step(async () => {
                const { page } = ctx
                await openSettled(ctx, route)
                if (before) await before(page)
                // Mantine keeps closed modals mounted in portals, so only a VISIBLE dialog
                // is the one this click opened.
                const dialog = page.getByRole('dialog').filter({ visible: true }).first()
                await clickUntil(button(page), dialog)
                recordScan(ctx, await scanCurrentPage(ctx, { label: labelOf(name) }))
                await page.keyboard.press('Escape')
                await expect(dialog).toBeHidden()
            }),
    }
}

// "Scan admin: add data source dialog" -> "add data source dialog"
function labelOf(stepName: string): string {
    return stepName.replace(/^Scan [^:]+: /, '')
}

// The profile loads its values client-side, after hydration.
const profileLoaded: Ready = (page, ctx) =>
    page.getByRole('main').getByText(ctx.account.email, { exact: true })

const SIGNED_OUT: ScanOptions = { as: 'signed out' }

// Sign-in pages are only reachable signed out. Clearing cookies is NOT a sign-out
// here (the sign-in page still recognised the session), so this goes through the app's
// own "already signed in" screen — scanned on the way, since every returning user who
// follows a sign-in link meets it — and its "Sign in with a different account" button.
// loginAs() is the way back in, so this section sits between two role switches.
const signOutViaAlreadySignedIn: Step = {
    name: 'Scan signed in: already signed in, then sign out',
    run: ctx =>
        ctx.step(async () => {
            const { page } = ctx
            await openSettled(ctx, '/account/signin')
            const different = page.getByRole('button', { name: 'Sign in with a different account' })
            await different.waitFor({ state: 'visible' })
            recordScan(ctx, await scanCurrentPage(ctx, { label: 'already signed in' }))
            await clickUntil(different, page.getByLabel('Email'))
        }),
}

// An address no account has, so the error state never counts against a real
// account's failed-attempt limit.
const UNKNOWN_EMAIL = 'qar-accessibility-nobody@example.com'

async function showInvalidCredentials(page: Page): Promise<void> {
    await page.getByLabel('Email').fill(UNKNOWN_EMAIL)
    await page.getByLabel('Password').fill('not-the-password-1')
    await page.getByRole('button', { name: 'Login' }).click()
    await page.getByText(/Invalid login credentials/i).waitFor({ state: 'visible' })
}

// The real account's credentials, stopped at the second factor: the picker, then
// the code entry. Last of the signed-out scans, so nothing runs on the half-done
// sign-in; the loginAs() that follows clears the context.
// HTML is redacted because the password field is still in the DOM behind the picker.
const secondFactorScreens: Step = {
    name: 'Scan signed out: second-factor screens',
    run: ctx =>
        ctx.step(async () => {
            const { page } = ctx
            await openSettled(ctx, '/account/signin', p => p.getByLabel('Email'))
            await page.getByLabel('Email').fill(ctx.account.email)
            await page.getByLabel('Password').fill(ctx.account.password)
            await page.getByRole('button', { name: 'Login' }).click()
            const sms = page.getByRole('button', { name: 'SMS Verification' })
            const app = page.getByRole('button', { name: /authenticator|authentication app/i })
            const choice = sms.or(app).first()
            await choice.waitFor({ state: 'visible' })
            const opts = { ...SIGNED_OUT, redactHtml: true }
            recordScan(ctx, await scanCurrentPage(ctx, { ...opts, label: 'second-factor choice' }))
            await clickUntil(choice, page.getByTestId('sms-pin-input'))
            recordScan(
                ctx,
                await scanCurrentPage(ctx, { ...opts, label: 'second-factor code entry' })
            )
        }),
}

// Every card of the profile at once: three plain "Edit" buttons, plus the positions
// table's per-row pencil (the institutional card has no plain Edit).
async function openEveryProfileCard(page: Page): Promise<void> {
    const main = page.getByRole('main')
    const edits = main.getByRole('button', { name: 'Edit', exact: true })
    for (let n = await edits.count(); n > 0; n--) {
        await edits.first().click()
        await expect(edits).toHaveCount(n - 1)
    }
    const position = main.getByRole('button', { name: 'Edit current position' }).first()
    if (await position.isVisible()) {
        await position.click()
        await main.locator('#affiliation').waitFor({ state: 'visible' })
    }
}

// Empty a required field, the state a screen reader most needs announced. Never
// saved: the Save button disables, and the next step's navigation discards it.
async function emptyRequiredName(page: Page): Promise<void> {
    await openEveryProfileCard(page)
    const firstName = page.locator('#firstName')
    await firstName.fill('')
    await firstName.blur()
    await expect(page.getByRole('button', { name: 'Save changes' }).first()).toBeDisabled()
}

const byName = (name: string | RegExp) => (page: Page) =>
    page
        .getByRole('main')
        .getByRole('button', { name, exact: typeof name === 'string' })
        .first()

const clickTab = (name: string) => async (page: Page) => {
    const tab = page.getByRole('tab', { name, exact: true })
    await clickUntil(tab, page.getByRole('tab', { name, exact: true, selected: true }))
}

function signInStep(role: Role): Step {
    return { name: `Sign in as ${role}`, run: ctx => ctx.step(() => ctx.loginAs(role)) }
}

export const accessibilitySuite: Suite = {
    name: 'accessibility',
    description:
        'Scan researcher, reviewer and admin pages with axe-core for WCAG 2.2 A/AA conformance',
    roles: ['researcher'],
    steps: [
        scanStep('Scan researcher: My studies', '/dashboard?audience=researcher'),
        scanStep('Scan researcher: lab dashboard', `/${LAB}/dashboard`),
        scanStep('Scan researcher: profile', '/researcher/profile', profileLoaded),
        stateStep(
            'Scan researcher: profile, every card in edit mode',
            '/researcher/profile',
            openEveryProfileCard,
            profileLoaded
        ),
        stateStep(
            'Scan researcher: profile, required field left empty',
            '/researcher/profile',
            emptyRequiredName,
            profileLoaded
        ),
        dialogStep('Scan researcher: profile menu', '/dashboard', page =>
            page.getByRole('button', { name: /profile menu/i })
        ),
        scanStep('Scan researcher: new study proposal', `/${LAB}/study/request`),
        scanStep('Scan researcher: account keys', '/account/keys'),
        scanStep('Scan researcher: existing security key', '/user-key'),
        scanStep('Scan researcher: MFA status', '/account/mfa'),
        // The phone-number form only; nothing is sent until it is submitted. (The
        // authenticator-app page is NOT scanned here: it starts an enrolment on load,
        // which would disturb the shared account. accessibility-onboarding covers it
        // with a brand-new user.)
        scanStep('Scan researcher: add SMS MFA', '/account/mfa/sms'),
        signOutViaAlreadySignedIn,
        scanStep(
            'Scan signed out: sign in',
            '/account/signin',
            page => page.getByLabel('Email'),
            SIGNED_OUT
        ),
        stateStep(
            'Scan signed out: sign in, invalid credentials',
            '/account/signin',
            showInvalidCredentials,
            page => page.getByLabel('Email'),
            SIGNED_OUT
        ),
        scanStep(
            'Scan signed out: reset password',
            '/account/reset-password',
            undefined,
            SIGNED_OUT
        ),
        scanStep('Scan signed out: legal', '/legal', undefined, SIGNED_OUT),
        secondFactorScreens,
        signInStep('reviewer'),
        scanStep('Scan reviewer: My studies', '/dashboard'),
        scanStep('Scan reviewer: org dashboard', `/${DATA_ORG}/dashboard`),
        signInStep('admin'),
        scanStep('Scan admin: org settings', SETTINGS),
        stateStep('Scan admin: org details in edit mode', SETTINGS, page =>
            byName('Edit')(page).click()
        ),
        dialogStep(
            'Scan admin: add code environment dialog',
            SETTINGS,
            byName('Add Code Environment')
        ),
        dialogStep('Scan admin: add data source dialog', SETTINGS, byName('Add Data Source')),
        dialogStep('Scan admin: edit data source dialog', SETTINGS, byName('Edit data source')),
        dialogStep('Scan admin: add test lab dialog', SETTINGS, byName('Add Test Lab')),
        dialogStep(
            'Scan admin: code environment history dialog',
            SETTINGS,
            byName(/^History for /)
        ),
        dialogStep('Scan admin: starter code dialog', SETTINGS, byName(/starter code for /)),
        dialogStep(
            'Scan admin: scan results dialog',
            SETTINGS,
            byName(/^View Scan .* results for /)
        ),
        // Opened and dismissed with Escape; the confirm button is never pressed.
        dialogStep('Scan admin: delete code environment confirm', SETTINGS, byName(/^Delete /)),
        scanStep('Scan admin: manage team', `/${DATA_ORG}/admin/team`),
        dialogStep(
            'Scan admin: invite people dialog',
            `/${DATA_ORG}/admin/team`,
            byName('Invite People')
        ),
        scanStep('Scan admin: legal center', `/${DATA_ORG}/admin/legal`),
        stateStep(
            'Scan admin: legal center, DOPA tab',
            `/${DATA_ORG}/admin/legal`,
            clickTab('Data Organization Participation Agreement')
        ),
        scanStep('Scan admin: SafeInsights admin', '/admin/safeinsights'),
        dialogStep(
            'Scan admin: add organization dialog',
            '/admin/safeinsights',
            byName('Add new organization')
        ),
        scanStep('Scan admin: SafeInsights legal', SI_LEGAL),
        ...['Privacy Notice', 'DOPA', 'ROPA', 'Study Agreements'].map(tab =>
            stateStep(`Scan admin: SafeInsights legal, ${tab} tab`, SI_LEGAL, clickTab(tab))
        ),
        dialogStep(
            'Scan admin: upload signed study agreement dialog',
            SI_LEGAL,
            byName('Upload signed study agreement'),
            clickTab('Study Agreements')
        ),
        scanStep('Scan admin: support', '/support'),
        conformanceStep,
    ],
}

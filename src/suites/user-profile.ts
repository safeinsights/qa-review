import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { dismissToasts, TOAST } from '../engine/flows/toasts'
import type { RunContext, Suite } from './types'

// Regression coverage for the User Profile feature (/researcher/profile).
//
// The page is four independently-saved cards — Personal information, Highest
// level of education, Current institutional information, Research details. Each
// card has TWO renderings and the suite must cope with both on every run:
//
//   empty profile  -> the card renders its edit FORM directly
//   saved profile  -> the card renders a read-only summary + an "Edit" button
//
// That is why every step goes through `openForEdit()` instead of assuming a form
// is on screen: the first run against a fresh account takes the first shape and
// every run after it takes the second. The suite is IDEMPOTENT rather than
// cleanup-based — a profile is a singleton per user, not a created entity, so
// there is nothing to hand to ctx.trackStudy/trackUser. Each run overwrites the
// same known values, and the personal-name check restores what it found.
//
// Each step also re-establishes what it needs rather than inheriting on-screen
// state from the step before it. The engine can jump to, or retry, one step in
// isolation (see applyJump in engine/run.ts), so a step that assumed its
// predecessor had just run would fail there in a way that says nothing useful.
//
// Sections are addressed through their Mantine Paper card (`sectionCard`) because
// the four "Save changes" buttons are otherwise indistinguishable, and one of
// them (institutional) sits OUTSIDE its own <form>, so scoping by form does not
// work uniformly.

const PROFILE_HEADING = 'Researcher Profile'

const SECTION = {
    personal: 'Personal information',
    education: 'Highest level of education',
    institutional: 'Current institutional information',
    research: 'Research details',
} as const

// Values this suite writes. Fixed (not ctx.tag-suffixed) so a re-run converges on
// the same profile instead of accumulating variants of the same field.
const EDUCATION = {
    institution: 'Rice University',
    degree: 'Doctoral level degree',
    fieldOfStudy: 'Cognitive Neuroscience',
}
const PRIMARY_POSITION = {
    affiliation: 'Rice University',
    position: 'Senior Researcher',
    profileUrl: 'https://profiles.rice.edu/faculty/qa-review',
}
const SECOND_POSITION = {
    affiliation: 'Baylor College of Medicine',
    position: 'Adjunct Faculty',
}
const RESEARCH = {
    interests: ['Neuroscience', 'Cognition', 'Learning Analytics', 'Education Policy'],
    detailedUrl: 'https://scholar.google.com/citations?user=qareview',
    featured: ['https://doi.org/10.1234/qa-review-one', 'https://doi.org/10.1234/qa-review-two'],
}
const INVALID_URL = 'not-a-valid-url'
// The interest the cap must refuse. Named so the rejection can be asserted by value
// rather than only by a count that never moved.
const SIXTH_INTEREST = 'Sixth Interest'
// The research-interests field caps at five, so clearing it can never need more
// clicks than that plus slack. Bounds the removal loop in setInterests.
const MAX_PILL_REMOVALS = 10

// Mantine's public class names, named here rather than inlined at three call sites.
// They are the part of this suite most likely to move under a Mantine upgrade, and a
// selector that silently stops matching would leave the suite green while asserting
// nothing. toast-messages keeps its own class constants the same way.
const CARD = '.mantine-Paper-root'
const PILL = '.mantine-Pill-root'
// Addressed by class because there is nothing else to address it by: Mantine renders the
// pill's X as aria-hidden="true" tabindex="-1" with no label and no text, so it is
// invisible to getByRole. That is Mantine's pill pattern rather than an app defect — the X
// is a mouse affordance and the accessible path is Backspace in the field, which was
// verified to work (one pill, Backspace, count 1 -> 0). So: not a bug to file, just a
// control that only a class selector can reach.
const PILL_REMOVE = '.mantine-Pill-remove'

const sectionCard = (page: Page, heading: string): Locator =>
    page.locator(CARD).filter({
        has: page.getByRole('heading', { level: 3, name: heading, exact: true }),
    })

const saveButton = (section: Locator): Locator =>
    section.getByRole('button', { name: 'Save changes' })

// Put a card into edit mode regardless of which of its two renderings is up.
// A saved card shows "Edit"; an empty one is already a form.
async function openForEdit(section: Locator, anyFieldId: string): Promise<void> {
    const field = section.locator(anyFieldId)
    if (await field.isVisible().catch(() => false)) return
    await section.getByRole('button', { name: 'Edit', exact: true }).click()
    await field.waitFor({ state: 'visible' })
}

// Converge on "no second position" before one is added. A run that died between the
// add and the delete in the second-position step strands a leftover row, and on the
// NEXT run the same locator would resolve to two rows — a strict-mode violation whose
// message names the locator rather than the stale data that caused it. Absorbing the
// leftover is the same idempotency move `originalName` makes for a stray "-QA".
//
// Targeted at the second affiliation rather than "every row with a Delete button":
// once two positions exist BOTH rows offer delete, so a blind sweep could remove the
// primary position instead.
async function removeSecondPositions(section: Locator): Promise<void> {
    const rows = section.getByRole('row').filter({ hasText: SECOND_POSITION.affiliation })
    // Bounded by the initial count, and each pass asserts the count actually fell, so a
    // delete that stops deleting fails here instead of spinning to the step deadline.
    for (let remaining = await rows.count(); remaining > 0; remaining--) {
        await rows.first().getByRole('button', { name: 'Delete current position' }).click()
        await expect(rows).toHaveCount(remaining - 1)
    }
}

// The institutional card is the ONE section without a plain "Edit" button: saved
// positions are a table whose rows each carry a pencil ("Edit current position"),
// so the generic openForEdit cannot reach it.
async function openPositionForEdit(section: Locator): Promise<void> {
    const field = section.locator('#affiliation')
    if (await field.isVisible().catch(() => false)) return
    await section.getByRole('button', { name: 'Edit current position' }).first().click()
    await field.waitFor({ state: 'visible' })
}

// Validation reacts to input, so clearing alone is enough to invalidate a field.
// The blur is here only to leave focus somewhere predictable between probes.
async function clearAndBlur(field: Locator): Promise<void> {
    await field.fill('')
    await field.blur()
}

// Save a card and wait for its own toast. Each section emits a distinct message,
// so asserting the text is what proves the right card was persisted — but only
// against an EMPTY tray. Mantine holds a toast for 8s, and both of the repeat
// saves here (personal information saves twice inside one step; institutional
// saves once per step across two consecutive steps) land well inside that window,
// so a leftover toast would satisfy the next assertion without the save having
// happened at all. Clear, save, assert, clear.
//
// Scoped to the notification root rather than page.getByText: an unscoped text
// match can be satisfied by ordinary card copy, and would keep passing if the tray
// stopped rendering entirely. Whether the string arrives as the toast's title or
// its body is deliberately NOT asserted — that surface belongs to toast-messages.
async function saveSection(page: Page, section: Locator, toast: string): Promise<void> {
    await dismissToasts(page)
    const button = saveButton(section)
    await expect(button).toBeEnabled()
    await button.click()
    // waitFor, not expect: the toast is raised on a server round trip, which needs
    // the action timeout rather than the shorter assertion one.
    await page.locator(TOAST).filter({ hasText: toast }).waitFor({ state: 'visible' })
    await dismissToasts(page)
}

// Mantine Select renders its options in a portal OUTSIDE the card, so the option
// has to be found on the page rather than within `section`.
async function selectDegree(page: Page, section: Locator, degree: string): Promise<void> {
    await section.locator('#degree').click()
    await page.getByRole('option', { name: degree, exact: true }).click()
    await expect(section.locator('#degree')).toHaveValue(degree)
}

const pills = (section: Locator): Locator => section.locator(PILL)

// Reset the research-interests pills to `values`.
async function setInterests(section: Locator, values: string[]): Promise<void> {
    const input = section.locator('#researchInterests')
    const remove = section.locator(PILL_REMOVE)
    // Bounded, not `while (count > 0)`: if a click ever stops removing (disabled
    // control, a pill that re-adds itself) an unbounded loop spins until the global
    // step timeout with nothing said about why. The field caps at five, so anything
    // past a handful of iterations is a real defect worth naming.
    for (let i = 0; (await remove.count()) > 0; i++) {
        if (i >= MAX_PILL_REMOVALS) {
            throw new Error(
                `research-interest pills are not clearing: ${await remove.count()} still present after ${i} removals`
            )
        }
        await remove.first().click()
    }
    await expect(pills(section)).toHaveCount(0)
    for (const value of values) {
        await input.fill(value)
        await input.press('Enter')
    }
    await expect(pills(section)).toHaveCount(values.length)
}

// The account's name as it should be left behind, cached on ctx.state so the two
// personal-information steps agree on one value within a run.
//
// Read from the form rather than passed between steps: the engine can jump to or
// retry an individual step, so a step that assumed its predecessor had populated
// ctx.state would crash there rather than simply re-deriving what it needs.
//
// The `-QA` strip absorbs a run that died between the rename and its restore —
// the suffix is stripped repeatedly, so a dirty account converges on the original
// name instead of accumulating "-QA-QA".
async function originalName(
    ctx: RunContext,
    section: Locator
): Promise<{ first: string; last: string }> {
    const cached = ctx.state.originalName as { first: string; last: string } | undefined
    if (cached) return cached

    await openForEdit(section, '#firstName')
    const original = {
        first: (await section.locator('#firstName').inputValue()).trim(),
        last: (await section.locator('#lastName').inputValue()).trim().replace(/(-QA)+$/, ''),
    }
    ctx.state.originalName = original
    return original
}

async function gotoProfile(ctx: RunContext): Promise<void> {
    const { page } = ctx
    await page.getByRole('button', { name: 'Toggle profile menu' }).click()
    await page.getByRole('menuitem', { name: 'Profile', exact: true }).click()
    // Wait on the destination heading, never the URL — the SPA router can swap the
    // path before this card tree is interactive.
    await expect(page.getByRole('heading', { level: 1, name: PROFILE_HEADING })).toBeVisible()
}

export const userProfileSuite: Suite = {
    name: 'user-profile',
    description: 'Regression: User Profile, all four cards save, validate and persist',
    // NOT 'reviewer', and that is BY DESIGN — a reviewer has no profile, confirmed by
    // the team. Their account menu carries no Profile item, so step 1 times out waiting
    // on it. Don't re-add the role and don't file it as a bug; admin and researcher
    // pass end to end and are the whole supported set.
    roles: ['admin', 'researcher'],
    steps: [
        {
            name: 'Open Profile from the account menu',
            run: ctx =>
                ctx.step(async () => {
                    await gotoProfile(ctx)
                    const personal = sectionCard(ctx.page, SECTION.personal)
                    // The signed-in account's own email must be what the card shows;
                    // a stale/global fetch here would be invisible otherwise.
                    await expect(
                        personal.getByText(ctx.account.email, { exact: true })
                    ).toBeVisible()
                    for (const heading of Object.values(SECTION)) {
                        await expect(
                            ctx.page.getByRole('heading', { level: 3, name: heading, exact: true })
                        ).toBeVisible()
                    }
                    // There is no SECOND route to this page to cover. The "Profile" row in
                    // the sidebar is not a link of its own — it is the account menu above,
                    // rendered inline in the sidebar while expanded, which is exactly what
                    // gotoProfile already drives. A dump of every anchor on the loaded page
                    // returns five ('/', '/dashboard' twice, one empty) and no element
                    // anywhere carries the text 'Profile' while the menu is closed.
                    //
                    // Worth stating because the obvious selectors fail in a MISLEADING way:
                    // getByRole('link', { name: 'Profile' }) and a[href$="/profile"] both
                    // find nothing, which reads like a control with bad semantics. It isn't
                    // one — the element simply is not rendered until the menu opens, and
                    // gotoProfile's getByRole('menuitem', { name: 'Profile' }) matching on
                    // every run is proof it has both a role and an accessible name.
                }),
        },
        {
            name: 'Personal information: email is read-only and a blank name blocks saving',
            run: ctx =>
                ctx.step(async () => {
                    const section = sectionCard(ctx.page, SECTION.personal)
                    await openForEdit(section, '#firstName')

                    // Email is account identity, not profile data — it must not be editable.
                    await expect(section.locator('#email')).toBeDisabled()

                    const firstName = section.locator('#firstName')
                    const original = await originalName(ctx, section)

                    await firstName.fill('')
                    await expect(saveButton(section)).toBeDisabled()
                    await firstName.fill(original.first)
                    await expect(saveButton(section)).toBeEnabled()
                }),
        },
        {
            name: 'Personal information: rename round-trips, then restores',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    const section = sectionCard(page, SECTION.personal)
                    // Re-derive rather than requiring the previous step's state: the engine
                    // can jump to or retry a single step, and reading ctx.state blindly
                    // fails there with an undefined-destructure instead of anything useful.
                    const original = await originalName(ctx, section)
                    const renamed = `${original.last}-QA`

                    await section.locator('#lastName').fill(renamed)
                    await saveSection(page, section, 'Personal information updated')
                    await expect(section.getByText(renamed, { exact: true })).toBeVisible()

                    // Restore, so the shared account is left exactly as it was found.
                    await openForEdit(section, '#lastName')
                    await section.locator('#lastName').fill(original.last)
                    await saveSection(page, section, 'Personal information updated')
                    await expect(section.getByText(original.last, { exact: true })).toBeVisible()
                }),
        },
        {
            name: 'Education: all three fields are required before saving',
            run: ctx =>
                ctx.step(async () => {
                    const section = sectionCard(ctx.page, SECTION.education)
                    await openForEdit(section, '#educationalInstitution')

                    const institution = section.locator('#educationalInstitution')
                    const fieldOfStudy = section.locator('#fieldOfStudy')
                    const degree = section.locator('#degree')

                    // Establish a known-valid baseline first, so this step behaves the
                    // same on a fresh profile (card renders an empty form) as on a
                    // profile a previous run already populated (card renders a summary).
                    await institution.fill(EDUCATION.institution)
                    await fieldOfStudy.fill(EDUCATION.fieldOfStudy)
                    if ((await degree.inputValue()) !== EDUCATION.degree) {
                        await selectDegree(ctx.page, section, EDUCATION.degree)
                    }
                    await expect(saveButton(section)).toBeEnabled()

                    // Each required text field independently gates saving.
                    for (const field of [institution, fieldOfStudy]) {
                        const original = await field.inputValue()
                        await clearAndBlur(field)
                        await expect(saveButton(section)).toBeDisabled()
                        // Whitespace does not satisfy "required" either.
                        await field.fill('   ')
                        await field.blur()
                        await expect(saveButton(section)).toBeDisabled()
                        await field.fill(original)
                        await field.blur()
                    }
                    await expect(saveButton(section)).toBeEnabled()

                    // The degree is required too, but it is deliberately NOT exercised the
                    // way the two text fields above are, because on this account it CANNOT
                    // be: once a degree is chosen there is no way to un-choose it. The card
                    // offers no clear control (its only button in edit mode is "Save
                    // changes"), and emptying the Select's text does not empty its value —
                    // running exactly that leaves the input reading '' while Save stays
                    // ENABLED, because the selection survives the cleared search text.
                    //
                    // So the "degree required" rule is only reachable on a never-saved
                    // profile, which a shared QA account is not after its first run. A
                    // check that selected a degree and asserted Save enabled would assert
                    // nothing about the requirement. Left as a known gap rather than a
                    // check that reads like coverage; it needs either a clear control in
                    // the app or a throwaway account.
                }),
        },
        {
            name: 'Education: saves and reports the currently-pursuing degree',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    const section = sectionCard(page, SECTION.education)
                    // Named, not a bare getByRole('checkbox'): an unscoped match would
                    // become an ambiguous-locator error the moment this card gains a
                    // second checkbox, instead of a legible selector mismatch.
                    const pursuing = section.getByRole('checkbox', { name: /currently pursuing/i })
                    if (!(await pursuing.isChecked())) await pursuing.check()

                    await saveSection(page, section, 'Education updated')

                    await expect(
                        section.getByText(EDUCATION.institution, { exact: true })
                    ).toBeVisible()
                    await expect(section.getByText(EDUCATION.degree, { exact: true })).toBeVisible()
                    await expect(
                        section.getByText(EDUCATION.fieldOfStudy, { exact: true })
                    ).toBeVisible()
                    // The checkbox is not echoed as a field of its own — it changes the
                    // degree's LABEL, which is the only place the flag is observable.
                    await expect(
                        section.getByText('Degree (currently pursuing)', { exact: true })
                    ).toBeVisible()

                    // Clearing it has to be observable too. Asserting only the checked
                    // arm would pass for a label hard-coded to the pursuing text, which
                    // is exactly how this flag would break unnoticed.
                    await openForEdit(section, '#educationalInstitution')
                    await pursuing.uncheck()
                    await saveSection(page, section, 'Education updated')
                    await expect(section.getByText('Degree', { exact: true })).toBeVisible()
                    await expect(
                        section.getByText('Degree (currently pursuing)', { exact: true })
                    ).toHaveCount(0)

                    // Leave the flag set, so the reload step downstream sees one known state.
                    await openForEdit(section, '#educationalInstitution')
                    await pursuing.check()
                    await saveSection(page, section, 'Education updated')
                    await expect(
                        section.getByText('Degree (currently pursuing)', { exact: true })
                    ).toBeVisible()
                }),
        },
        {
            name: 'Education: an emptied required field is caught while still focused',
            run: ctx =>
                ctx.step(async () => {
                    const section = sectionCard(ctx.page, SECTION.education)
                    await openForEdit(section, '#educationalInstitution')
                    const institution = section.locator('#educationalInstitution')

                    // Cleared by KEYBOARD and deliberately NOT blurred: validation must
                    // react to the keystrokes themselves. If it ever regresses to
                    // firing only on blur, a user could clear a required field and still
                    // click an enabled "Save changes".
                    await institution.click()
                    await institution.press('ControlOrMeta+a')
                    await institution.press('Backspace')
                    await expect(institution).toHaveValue('')
                    await expect(institution).toBeFocused()
                    await expect(saveButton(section)).toBeDisabled()

                    await institution.fill(EDUCATION.institution)
                    await expect(saveButton(section)).toBeEnabled()
                }),
        },
        {
            name: 'Institutional: an invalid profile URL blocks saving',
            run: ctx =>
                ctx.step(async () => {
                    const section = sectionCard(ctx.page, SECTION.institutional)
                    await openPositionForEdit(section)

                    await section.locator('#affiliation').fill(PRIMARY_POSITION.affiliation)
                    await section.locator('#position').fill(PRIMARY_POSITION.position)
                    // Profile URL is optional, so affiliation + position alone must save.
                    await expect(saveButton(section)).toBeEnabled()

                    await section.locator('#profileUrl').fill(INVALID_URL)
                    await expect(saveButton(section)).toBeDisabled()

                    await section.locator('#profileUrl').fill(PRIMARY_POSITION.profileUrl)
                    await expect(saveButton(section)).toBeEnabled()
                }),
        },
        {
            name: 'Institutional: saves the position and links the profile URL',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    const section = sectionCard(page, SECTION.institutional)
                    // Re-establish the form rather than saving whatever the previous step
                    // left on screen: run on its own against a saved profile this card is
                    // a read-only table, and saveSection would time out waiting for a
                    // "Save changes" button that is not rendered.
                    await openPositionForEdit(section)
                    await section.locator('#affiliation').fill(PRIMARY_POSITION.affiliation)
                    await section.locator('#position').fill(PRIMARY_POSITION.position)
                    await section.locator('#profileUrl').fill(PRIMARY_POSITION.profileUrl)

                    await saveSection(page, section, 'Current institutional information updated')

                    await expect(
                        section.getByRole('row').filter({ hasText: PRIMARY_POSITION.affiliation })
                    ).toBeVisible()
                    // The saved URL renders as a real anchor, not plain text — and one
                    // that actually POINTS at the URL. Matching only the visible name
                    // passes for an anchor whose text is the URL and whose href is not.
                    await expect(
                        section.getByRole('link', { name: PRIMARY_POSITION.profileUrl })
                    ).toHaveAttribute('href', PRIMARY_POSITION.profileUrl)
                }),
        },
        {
            name: 'Institutional: a second position can be added and deleted',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    const section = sectionCard(page, SECTION.institutional)
                    const secondRow = section
                        .getByRole('row')
                        .filter({ hasText: SECOND_POSITION.affiliation })
                    await removeSecondPositions(section)

                    await section
                        .getByRole('button', { name: /Add another current position/ })
                        .click()
                    await section.locator('#affiliation').fill(SECOND_POSITION.affiliation)
                    await section.locator('#position').fill(SECOND_POSITION.position)
                    await saveSection(page, section, 'Current institutional information updated')
                    await expect(secondRow).toBeVisible()

                    // Delete is per-row and only offered once a second position exists —
                    // the sole position can never be removed.
                    await secondRow.getByRole('button', { name: 'Delete current position' }).click()
                    await expect(secondRow).toBeHidden()
                    await expect(
                        section.getByRole('row').filter({ hasText: PRIMARY_POSITION.affiliation })
                    ).toBeVisible()
                }),
        },
        {
            name: 'Research details: interests cap at five',
            run: ctx =>
                ctx.step(async () => {
                    const section = sectionCard(ctx.page, SECTION.research)
                    await openForEdit(section, '#researchInterests')

                    await setInterests(section, [...RESEARCH.interests, 'Statistics'])
                    await expect(pills(section)).toHaveCount(5)

                    // A sixth is refused. The field is documented as "up to five", so the
                    // count must not move — this is the assertion that catches a
                    // regression in the cap itself.
                    const input = section.locator('#researchInterests')
                    await input.fill(SIXTH_INTEREST)
                    await input.press('Enter')
                    // Named, not just counted. `toHaveCount(5)` alone is satisfied the
                    // instant it is evaluated — including in the world where a sixth pill
                    // was one tick from landing — so it can pass while the cap is broken.
                    // Asserting the specific rejected value is absent still can't prove a
                    // negative on its own, but it survives a re-render that merely
                    // reorders or relabels pills, which a bare count does not.
                    await expect(pills(section).filter({ hasText: SIXTH_INTEREST })).toHaveCount(0)
                    await expect(pills(section)).toHaveCount(5)

                    await setInterests(section, RESEARCH.interests)
                }),
        },
        {
            name: 'Research details: invalid publication URLs are reported on submit',
            run: ctx =>
                ctx.step(async () => {
                    const section = sectionCard(ctx.page, SECTION.research)
                    await openForEdit(section, '#detailedPublicationsUrl')
                    await section.locator('#detailedPublicationsUrl').fill(INVALID_URL)
                    await section.locator('#featured0').fill(INVALID_URL)

                    // Unlike the other cards, this one leaves Save enabled and validates on
                    // submit, so the click is required to surface the errors.
                    await saveButton(section).click()
                    await expect(
                        section.getByText(
                            'Please enter a valid URL (e.g., must start with http:// or https://).'
                        )
                    ).toBeVisible()
                    await expect(
                        section.getByText('Featured publications URL: please enter a valid URL.')
                    ).toBeVisible()
                    await expect(section.locator('#detailedPublicationsUrl')).toHaveAttribute(
                        'aria-invalid',
                        'true'
                    )

                    // Clear the deliberately-bad values before leaving. The next step would
                    // overwrite them anyway, but a run that stops here should not strand the
                    // card mid-error for whoever opens the page next.
                    await section.locator('#detailedPublicationsUrl').fill(RESEARCH.detailedUrl)
                    await section.locator('#featured0').fill(RESEARCH.featured[0])
                }),
        },
        {
            name: 'Research details: saves interests and publication URLs',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    const section = sectionCard(page, SECTION.research)
                    await openForEdit(section, '#detailedPublicationsUrl')
                    // Set the interests here rather than inheriting the unsaved form the
                    // cap step happened to leave behind. This step is what PERSISTS them,
                    // and the engine can retry or jump straight to it — against a profile
                    // that has none, inheriting would save an empty set and only fail one
                    // step later, in the reload check, pointing at the wrong step.
                    await setInterests(section, RESEARCH.interests)
                    await section.locator('#detailedPublicationsUrl').fill(RESEARCH.detailedUrl)
                    await section.locator('#featured0').fill(RESEARCH.featured[0])
                    await section.locator('#featured1').fill(RESEARCH.featured[1])

                    await saveSection(page, section, 'Research details updated')
                    await expect(
                        section.getByRole('link', { name: RESEARCH.detailedUrl })
                    ).toBeVisible()
                }),
        },
        {
            name: 'Every card survives a reload',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    await page.reload({ waitUntil: 'domcontentloaded' })
                    await expect(
                        page.getByRole('heading', { level: 1, name: PROFILE_HEADING })
                    ).toBeVisible()

                    // Personal information is checked here for the RESTORE, not the save:
                    // the rename step asserts its own summary re-render, which a save that
                    // never reached the server would also satisfy. A "-QA" suffix surviving
                    // a reload is that failure, and this is the only place it shows up.
                    const personal = sectionCard(page, SECTION.personal)
                    await expect(
                        personal.getByText(ctx.account.email, { exact: true })
                    ).toBeVisible()
                    await expect(personal.getByText(/-QA$/)).toHaveCount(0)

                    const education = sectionCard(page, SECTION.education)
                    await expect(
                        education.getByText(EDUCATION.institution, { exact: true })
                    ).toBeVisible()
                    await expect(
                        education.getByText(EDUCATION.degree, { exact: true })
                    ).toBeVisible()
                    await expect(
                        education.getByText(EDUCATION.fieldOfStudy, { exact: true })
                    ).toBeVisible()

                    const institutional = sectionCard(page, SECTION.institutional)
                    await expect(
                        institutional.getByRole('link', { name: PRIMARY_POSITION.profileUrl })
                    ).toHaveAttribute('href', PRIMARY_POSITION.profileUrl)
                    const positionRow = institutional
                        .getByRole('row')
                        .filter({ hasText: PRIMARY_POSITION.position })
                    await expect(positionRow).toBeVisible()
                    // The delete must have reached the server too. Asserting the row is
                    // gone only from the live DOM would pass for a delete that removed the
                    // row client-side and never persisted.
                    await expect(
                        institutional
                            .getByRole('row')
                            .filter({ hasText: SECOND_POSITION.affiliation })
                    ).toHaveCount(0)

                    const research = sectionCard(page, SECTION.research)
                    for (const interest of RESEARCH.interests) {
                        await expect(research.getByText(interest, { exact: true })).toBeVisible()
                    }
                    for (const url of [RESEARCH.detailedUrl, ...RESEARCH.featured]) {
                        await expect(research.getByRole('link', { name: url })).toHaveAttribute(
                            'href',
                            url
                        )
                    }
                }),
        },
    ],
}

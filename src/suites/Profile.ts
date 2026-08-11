import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { RunContext, Suite } from './types'

// Regression coverage for the Profile feature (/researcher/profile).
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

const sectionCard = (page: Page, heading: string): Locator =>
    page.locator('.mantine-Paper-root').filter({
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
// so asserting the text is what proves the right card was persisted.
async function saveSection(page: Page, section: Locator, toast: string): Promise<void> {
    const button = saveButton(section)
    await expect(button).toBeEnabled()
    await button.click()
    await expect(page.getByText(toast, { exact: true })).toBeVisible()
}

// Mantine Select renders its options in a portal OUTSIDE the card, so the option
// has to be found on the page rather than within `section`.
async function selectDegree(page: Page, section: Locator, degree: string): Promise<void> {
    await section.locator('#degree').click()
    await page.getByRole('option', { name: degree, exact: true }).click()
    await expect(section.locator('#degree')).toHaveValue(degree)
}

const pills = (section: Locator): Locator => section.locator('.mantine-Pill-root')

// Reset the research-interests pills to `values`.
//
// The pill remove control is addressed by class, not by role/name, because it
// carries NO accessible name — no aria-label and no text content, so there is
// nothing for getByRole to match. If that is fixed, switch to getByRole here.
async function setInterests(section: Locator, values: string[]): Promise<void> {
    const input = section.locator('#researchInterests')
    const remove = section.locator('.mantine-Pill-remove')
    while ((await remove.count()) > 0) {
        await remove.first().click()
    }
    await expect(pills(section)).toHaveCount(0)
    for (const value of values) {
        await input.fill(value)
        await input.press('Enter')
    }
    await expect(pills(section)).toHaveCount(values.length)
}

async function gotoProfile(ctx: RunContext): Promise<void> {
    const { page } = ctx
    await page.getByRole('button', { name: 'Toggle profile menu' }).click()
    await page.getByRole('menuitem', { name: 'Profile', exact: true }).click()
    // Wait on the destination heading, never the URL — the SPA router can swap the
    // path before this card tree is interactive.
    await expect(page.getByRole('heading', { level: 1, name: PROFILE_HEADING })).toBeVisible()
}

export const profileSuite: Suite = {
    name: 'Profile',
    description: 'Regression: Profile — all four cards save, validate and persist',
    roles: ['admin', 'researcher', 'reviewer'],
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
                    const original = {
                        first: (await firstName.inputValue()).trim(),
                        // Strip a suffix left by a previous interrupted run so the
                        // restore below converges instead of stacking "-QA-QA".
                        last: (await section.locator('#lastName').inputValue())
                            .trim()
                            .replace(/(-QA)+$/, ''),
                    }
                    ctx.state.originalName = original

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
                    const original = ctx.state.originalName as { first: string; last: string }
                    const section = sectionCard(page, SECTION.personal)
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
                }),
        },
        {
            name: 'Education: saves and reports the currently-pursuing degree',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    const section = sectionCard(page, SECTION.education)
                    const pursuing = section.getByRole('checkbox')
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
                    await saveSection(page, section, 'Current institutional information updated')

                    await expect(
                        section.getByRole('row').filter({ hasText: PRIMARY_POSITION.affiliation })
                    ).toBeVisible()
                    // The saved URL renders as a real anchor, not plain text.
                    await expect(
                        section.getByRole('link', { name: PRIMARY_POSITION.profileUrl })
                    ).toBeVisible()
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
                    await input.fill('Sixth Interest')
                    await input.press('Enter')
                    await expect(pills(section)).toHaveCount(5)

                    await setInterests(section, RESEARCH.interests)
                }),
        },
        {
            name: 'Research details: invalid publication URLs are reported on submit',
            run: ctx =>
                ctx.step(async () => {
                    const section = sectionCard(ctx.page, SECTION.research)
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
                }),
        },
        {
            name: 'Research details: saves interests and publication URLs',
            run: ctx =>
                ctx.step(async () => {
                    const { page } = ctx
                    const section = sectionCard(page, SECTION.research)
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
                    ).toBeVisible()
                    const positionRow = institutional
                        .getByRole('row')
                        .filter({ hasText: PRIMARY_POSITION.position })
                    await expect(positionRow).toBeVisible()

                    const research = sectionCard(page, SECTION.research)
                    for (const interest of RESEARCH.interests) {
                        await expect(research.getByText(interest, { exact: true })).toBeVisible()
                    }
                    for (const url of [RESEARCH.detailedUrl, ...RESEARCH.featured]) {
                        await expect(research.getByRole('link', { name: url })).toBeVisible()
                    }
                }),
        },
    ],
}

import { faker } from '@faker-js/faker'
import type { Page } from '@playwright/test'
import { loginAs } from '../auth'
import type { EnvConfig } from '../types'
import { clickUntil } from './interactions'

// Shared create-study-proposal helpers, extracted from src/suites/study-happy-path.ts
// so both the happy-path suite AND ad-hoc validation suites drive the SAME create
// flow. Page-driving helpers take a Playwright `page` (+ `baseURL`) rather than a
// RunContext; suite concerns (ctx.step/state/trackStudy/loginAs) stay in the suite.

export const RESEARCHER_DASH = '/openstax-lab/dashboard'

export interface StudyContent {
    title: string
    researchQuestion: string
    summary: string
    impact: string
    proposalFeedback: string
    changeRequestFeedback: string
    resubmissionNote: string
    codeApprovalFeedback: string
    resultsApprovalFeedback: string
}

// OTTER-690's "Set up study" page caps the title at 60 characters and blocks
// "Save & continue" until it fits, so the title must be BUILT to fit rather than
// trimmed after the fact. `ctx.tag` alone is 33 characters
// (`qa-<suite>-<startedAt>`), which left every generated title over the limit.
export const STUDY_TITLE_MAX = 60

// Trim at a word boundary so a truncated title still reads as words rather than
// stopping mid-word. Cuts on CHARACTERS, not UTF-16 code units, so a mid-word cut
// can never land inside a surrogate pair and leave a lone half of one.
function trimToWords(text: string, max: number): string {
    if (text.length <= max) {
        return text
    }
    const cut = [...text].slice(0, max).join('')
    const lastSpace = cut.lastIndexOf(' ')
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()
}

// The tag is what makes the row findable, so when the 60-character budget is tight
// the DESCRIPTIVE half gives way and the tag is kept whole.
export function taggedTitle(subject: string, tag: string): string {
    const marker = '(QA '
    const suffix = ` ${marker}${tag})`
    const room = STUDY_TITLE_MAX - suffix.length
    if (room < 1) {
        // A tag longer than the whole budget: keep the marker and the tag's TAIL,
        // which carries the per-run timestamp that actually distinguishes one run
        // from another. Slicing the finished group instead would cut the marker
        // off the FRONT, leaving an orphaned ")" and nothing identifying it as ours.
        const tail = tag.slice(-(STUDY_TITLE_MAX - marker.length - 1))
        return `${marker}${tail})`
    }
    // trimToWords can come back empty (an empty subject, or a first word longer than
    // room), which would leave the leading space of `suffix` at the front. Forms often
    // trim on save, so a stored value that differs from what we look the row up by
    // would break the lookup.
    return (trimToWords(subject, room) + suffix).trim()
}

// Fit a title that was assembled elsewhere — or carried over in ctx.state from a
// previous attempt, which is what a single-step RETRY re-uses. A trailing
// "(QA <tag>)" group is kept whole and only the descriptive half is trimmed.
//
// With NO such group there is nothing marking which part is the identifier, so the
// only option left is a plain trim from the right — which drops whatever run-unique
// text was at the end. Build titles with `taggedTitle` rather than relying on this
// to recognise a suffix that was never put there.
export function fitStudyTitle(title: string): string {
    if (title.length <= STUDY_TITLE_MAX) {
        return title
    }
    const tagged = title.match(/\s*\(QA ([^)]*)\)\s*$/)
    if (!tagged || tagged.index === undefined) {
        return trimToWords(title, STUDY_TITLE_MAX)
    }
    return taggedTitle(title.slice(0, tagged.index), tagged[1])
}

// Realistic-but-synthetic study + review text via faker, using English-word
// generators (not the Latin faker.lorem). The title keeps `tag` (the
// unique-per-run suffix) so the study row stays findable and traceable.
export function generateStudyContent(tag: string): StudyContent {
    const topic = faker.commerce.productName().toLowerCase()
    const cohort = faker.helpers.arrayElement([
        'first-year',
        'transfer',
        'STEM',
        'part-time',
        'online',
    ])
    // Used in the research question and impact text. Deliberately NOT in the title:
    // a realistic tag leaves ~21 characters for the descriptive half, so anything
    // past the first phrase is always trimmed away before it can render.
    const outcome = faker.helpers.arrayElement([
        'course completion',
        'assessment scores',
        'time-on-task',
        'retention',
        'engagement',
    ])
    const para = () =>
        faker.helpers.multiple(() => faker.hacker.phrase(), { count: { min: 2, max: 3 } }).join(' ')
    const body = (paras: number) =>
        faker.helpers.multiple(para, { count: { min: 1, max: paras } }).join('\n\n')
    return {
        title: taggedTitle(faker.company.catchPhraseNoun(), tag),
        researchQuestion: `How does ${topic} relate to ${outcome} among ${cohort} students? ${faker.hacker.phrase()}`,
        summary: body(2),
        impact: `This work informs ${faker.company.buzzPhrase()}. ${faker.hacker.phrase()}`,
        proposalFeedback: `Approving this initial request. ${body(1)}`,
        changeRequestFeedback: `Requesting revisions before approval. ${body(1)}`,
        resubmissionNote: `Addressed reviewer feedback. ${body(1)}`,
        codeApprovalFeedback: `Code approved and ready to run. ${body(1)}`,
        resultsApprovalFeedback: `Outputs reviewed, no sensitive or restricted data found. ${body(1)}`,
    }
}

// Fill a Lexical contenteditable field by aria-label: click to focus, then type.
export async function fillLexical(page: Page, ariaLabel: string, text: string): Promise<void> {
    const field = page.locator(`[aria-label="${ariaLabel}"]`)
    await field.click()
    await page.keyboard.type(text)
}

// Open the researcher org dashboard; the "Propose New Study" link is visible.
export async function openProposalDashboard(page: Page, baseURL: string): Promise<void> {
    await page.goto(`${baseURL}${RESEARCHER_DASH}`, { waitUntil: 'domcontentloaded' })
    await page
        .getByRole('link', { name: /Propose New Study/i })
        .first()
        .waitFor({ state: 'visible' })
}

// Click "Propose New Study" and land on the request page with its org picker READY
// TO CLICK — which is a later state than "rendered", and the distinction is the whole
// point of this helper.
//
// The picker is CLIENT-rendered (the server HTML for /<org>/study/request contains no
// org-select at all) and Mantine renders it DISABLED while the org list loads —
// measured at ~0.5-1s on qa. Waiting only for `visible` therefore hands the caller a
// control it cannot click, and the caller burns its ENTIRE action timeout on it. That
// wait, the re-driven click (a click landing before the dashboard hydrates navigates
// outside the router's knowledge and can be undone), and the bound on the loop are
// all clickUntil's job — this flow just names the control and the target.
export async function beginProposal(page: Page): Promise<void> {
    await clickUntil(
        page.getByRole('link', { name: /Propose New Study/i }).first(),
        page.getByTestId('org-select')
    )
}

// Open the dashboard and begin a proposal in one call (for ad-hoc callers).
export async function startProposal(page: Page, baseURL: string): Promise<void> {
    await openProposalDashboard(page, baseURL)
    await beginProposal(page)
}

// Step 1 (the Set Up page): NAME the study, choose the Data Partner + language, then
// advance to Step 2 — which CREATES the study record. Returns the study id captured
// from the proposal-page URL. The caller tracks it for cleanup (ctx.trackStudy).
//
// The title is set HERE, not on Step 2, which is why this takes it as a parameter.
// OTTER-690 moved the field to Step 1 so that every saved draft has a title from the
// start, and Step 2 no longer renders a title field at all.
export async function completeSetupAndCaptureId(page: Page, title: string): Promise<string> {
    // An over-long title leaves the form invalid, so "Save & continue" never opens the
    // modal and clickUntil burns its full budget on a timeout that names the DIALOG.
    // Fail here instead, naming the real cause.
    if (title.length > STUDY_TITLE_MAX) {
        throw new Error(
            `Study title is ${title.length} characters; the Set up study page allows ${STUDY_TITLE_MAX}: ${title}`
        )
    }
    await page.getByLabel('Study title').fill(title)
    await page.getByTestId('org-select').click()
    await page
        .getByRole('option', { name: /openstax/i })
        .first()
        .click()
    const rRadio = page.getByRole('radio', { name: 'R', exact: true })
    await rRadio.waitFor({ state: 'visible' })
    await rRadio.click()
    // "Save & continue" opens a confirmation modal rather than navigating straight on,
    // so the modal — not a URL — is what says the click landed. clickUntil because the
    // button is server-rendered and clickable before React wires its onClick.
    const setupConfirm = page.getByRole('dialog', { name: 'Continue to the next step?' })
    await clickUntil(page.getByRole('button', { name: /Save & continue/i }), setupConfirm)
    await setupConfirm.getByRole('button', { name: 'Continue', exact: true }).click()
    // Confirming creates the study record; its id is in the proposal-page URL. Wait for
    // a field that only Step 2 has, so the page is rendered before the URL is read —
    // the URL changes before the form is there, and reading it first would race.
    await page.getByLabel('Dataset(s) of interest').waitFor({ state: 'visible' })
    const match = page.url().match(/\/study\/([0-9a-f-]+)\/proposal/i)
    if (!match) {
        throw new Error(`Could not find study id in proposal URL: ${page.url()}`)
    }
    return match[1]
}

// Step 2: fill the proposal form (dataset, the three Lexical fields, PI). The title is
// NOT here — completeSetupAndCaptureId sets it on Step 1.
export async function fillProposal(page: Page, content: StudyContent): Promise<void> {
    // By label, not by placeholder: OTTER-691 removed the placeholder text from every
    // field on this page, so the old getByPlaceholder locator can never match again.
    await page.getByLabel('Dataset(s) of interest').click()
    await page.getByRole('option').first().click()
    await fillLexical(page, 'Research question(s)', content.researchQuestion)
    await fillLexical(page, 'Project summary', content.summary)
    await fillLexical(page, 'Impact', content.impact)
    const pi = page.getByRole('textbox', { name: 'Principal Investigator' })
    await pi.click()
    await page.getByRole('option').first().click()
}

// Submit the proposal and confirm the success banner.
export async function submitProposal(page: Page): Promise<void> {
    // The page trigger and the modal's confirm button carry the SAME accessible name,
    // "Submit proposal". So the trigger is addressed by id — the id OTTER-691 gave it
    // for its own scroll-to-submit path — and the confirm click is scoped to the
    // dialog. A bare by-name locator matches both once the modal is open and fails as
    // a strict-mode violation.
    const submitConfirm = page.getByRole('dialog', { name: 'Submit your proposal?' })
    await clickUntil(page.locator('#submit-proposal'), submitConfirm)
    await submitConfirm.getByRole('button', { name: /Submit proposal/i }).click()
    await page.getByText(/successfully submitted/i).waitFor({ state: 'visible' })
}

// End-to-end convenience: start → capture id → fill → submit. Returns the study id
// (the caller tracks it for cleanup). Suites that need per-step reporting call the
// granular helpers instead.
export async function createStudyProposal(
    page: Page,
    baseURL: string,
    content: StudyContent
): Promise<string> {
    await startProposal(page, baseURL)
    const studyId = await completeSetupAndCaptureId(page, content.title)
    await fillProposal(page, content)
    await submitProposal(page)
    return studyId
}

// Self-contained "create a study from scratch" on a held page, for ad-hoc
// validation: log in as researcher, generate synthetic study content, and submit a
// full proposal. Returns the new study id (for cleanup / later reference). Ends
// logged in as researcher.
export async function createStudyFromScratch(page: Page, env: EnvConfig): Promise<string> {
    await loginAs(page, env, 'researcher')
    // A short unique tag keeps the study row findable/traceable in the UI.
    const tag = Math.random().toString(36).slice(2, 8)
    return createStudyProposal(page, env.baseURL, generateStudyContent(tag))
}

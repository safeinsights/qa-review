import { faker } from '@faker-js/faker'
import type { Page } from '@playwright/test'
import { loginAs } from '../auth'
import type { EnvConfig } from '../types'

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
        title: `${faker.company.catchPhraseNoun()} and ${outcome} (QA ${tag})`,
        researchQuestion: `How does ${topic} relate to ${outcome} among ${cohort} students? ${faker.hacker.phrase()}`,
        summary: body(2),
        impact: `This work informs ${faker.company.buzzPhrase()}. ${faker.hacker.phrase()}`,
        proposalFeedback: `Approving this initial request. ${body(1)}`,
        changeRequestFeedback: `Requesting revisions before approval. ${body(1)}`,
        resubmissionNote: `Addressed reviewer feedback. ${body(1)}`,
        codeApprovalFeedback: `Code approved and ready to run. ${body(1)}`,
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

// Click "Propose New Study" and land on the request page (its org picker rendered).
export async function beginProposal(page: Page): Promise<void> {
    await page
        .getByRole('link', { name: /Propose New Study/i })
        .first()
        .click()
    await page.getByTestId('org-select').waitFor({ state: 'visible' })
}

// Open the dashboard and begin a proposal in one call (for ad-hoc callers).
export async function startProposal(page: Page, baseURL: string): Promise<void> {
    await openProposalDashboard(page, baseURL)
    await beginProposal(page)
}

// Step 1: choose org + language (R), then proceed to Step 2 — which CREATES the
// study record. Returns the study id captured from the proposal-page URL. The
// caller is responsible for tracking it for cleanup (ctx.trackStudy).
export async function chooseOrgAndCaptureId(page: Page): Promise<string> {
    await page.getByTestId('org-select').click()
    await page
        .getByRole('option', { name: /openstax/i })
        .first()
        .click()
    const rRadio = page.getByRole('radio', { name: 'R', exact: true })
    await rRadio.waitFor({ state: 'visible' })
    await rRadio.click()
    // Proceeding to Step 2 creates the study record; its id is in the proposal-page
    // URL. Wait for the proposal form (Study Title) so the URL is settled, then read.
    await page.getByRole('button', { name: /Proceed to Step 2/i }).click()
    await page.getByLabel('Study Title').waitFor({ state: 'visible' })
    const match = page.url().match(/\/study\/([0-9a-f-]+)\/proposal/i)
    if (!match) {
        throw new Error(`Could not find study id in proposal URL: ${page.url()}`)
    }
    return match[1]
}

// Step 2: fill the proposal form (title, dataset, the three Lexical fields, PI).
export async function fillProposal(page: Page, content: StudyContent): Promise<void> {
    await page.getByLabel('Study Title').fill(content.title)
    await page.getByPlaceholder('Select dataset(s) of interest').click()
    await page.getByRole('option').first().click()
    await fillLexical(page, 'Research question(s)', content.researchQuestion)
    await fillLexical(page, 'Project summary', content.summary)
    await fillLexical(page, 'Impact', content.impact)
    const pi = page.getByRole('textbox', { name: 'Principal Investigator' })
    await pi.click()
    await page.getByRole('option').first().click()
}

// Submit the initial request and confirm the success banner.
export async function submitProposal(page: Page): Promise<void> {
    await page.getByRole('button', { name: /Submit initial request/i }).click()
    await page.getByRole('button', { name: /Yes, submit initial request/i }).click()
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
    const studyId = await chooseOrgAndCaptureId(page)
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

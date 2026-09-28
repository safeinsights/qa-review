import { expect } from '@playwright/test'
import { clickUntil } from '../engine/flows/interactions'
import type { StudyContent } from '../engine/flows/study'
import { studyLifecycleSteps } from './study-happy-path'
import type { RunContext, Step, Suite } from './types'

// The study-happy-path lifecycle, proposed from Agreements Lab instead of Openstax Lab.
//
// The swap is the whole point: since Sep 23 2026 Openstax Lab is a TEST LAB under
// Openstax, so every study it creates is stamped a test study and skips the Study
// Agreement gate entirely. Agreements Lab is not a Test Lab, so its approved study is
// held at "Study agreements are being prepared" until an SI admin publishes a signed
// agreement — which this suite asserts from both sides, then publishes, then has the
// researcher and the reviewer each acknowledge before the rest of the lifecycle runs.
//
// Requires the shared researcher account to be a member of Agreements Lab (added via
// /agreements/admin/team on qa, Sep 24 2026). Without that the dashboard step 404s.

const RESEARCHER_ORG = 'agreements'
const RESEARCHER_ORG_NAME = 'Agreements Lab'
const REVIEWER_ORG = 'openstax'
const REVIEWER_ORG_NAME = 'Openstax'
// Agreements Lab has more than one member, and the first PI option is a real person.
const PRINCIPAL_INVESTIGATOR = 'QA Researcher'

const AGREEMENT_GATE_COPY = /Study agreements are being prepared/i

function studyId(ctx: RunContext): string {
    return ctx.state.studyId as string
}

function studyTitle(ctx: RunContext): string {
    return (ctx.state.study as StudyContent).title
}

const agreementSteps: Step[] = [
    {
        name: 'Reviewer sees the study agreement gate',
        run: ctx =>
            ctx.step(async () => {
                // The approval re-renders the review page in place; the gate notice is
                // what separates a non-test study from a test one, which shows none.
                await expect(ctx.page.getByText(AGREEMENT_GATE_COPY)).toBeVisible()
            }),
    },
    {
        name: 'Switch to the researcher account',
        run: ctx => ctx.step(() => ctx.loginAs('researcher')),
    },
    {
        name: 'Researcher is held at the agreement gate',
        // The researcher is NOT stopped at /submitted — "Next step" still leads to /code,
        // and the IDE can be launched. The gate is a notice on /code that blocks
        // SUBMITTING code. It is asserted by its copy rather than by the disabled
        // "Submit code for review" button, which is disabled anyway until a main file is
        // chosen. Its removal needs no step of its own: round 1's submit, later in the
        // lifecycle, cannot succeed while the gate is up.
        run: ctx =>
            ctx.step(async () => {
                await ctx.page.goto(`${ctx.baseURL}/${RESEARCHER_ORG}/study/${studyId(ctx)}/code`, {
                    waitUntil: 'domcontentloaded',
                })
                await ctx.page
                    .getByRole('button', { name: /Launch IDE|Edit files in IDE/i })
                    .first()
                    .waitFor({ state: 'visible' })
                await expect(ctx.page.getByText(AGREEMENT_GATE_COPY)).toBeVisible()
                await expect(
                    ctx.page.getByText(/You cannot submit code until the required/i)
                ).toBeVisible()
            }),
    },
    {
        name: 'Switch to the admin account',
        run: ctx => ctx.step(() => ctx.loginAs('admin')),
    },
    {
        name: 'Admin publishes the signed study agreement',
        run: ctx =>
            ctx.step(async () => {
                await publishStudyAgreement(ctx)
            }),
    },
]

// Publishing does not by itself unblock either side: each party's first visit to the
// study afterwards raises a "Study Agreement" modal over the page (it intercepts every
// click beneath it) that they must acknowledge. Continue stays disabled until the
// acknowledgement box is ticked — asserted both ways, so a Continue that skipped the
// acknowledgement would fail here.
async function acknowledgeStudyAgreement(ctx: RunContext): Promise<void> {
    const modal = ctx.page.getByRole('dialog', { name: 'Study Agreement' })
    await modal.waitFor({ state: 'visible' })
    await expect(modal.getByRole('link', { name: /Study Agreement/i })).toBeVisible()
    const proceed = modal.getByRole('button', { name: 'Continue', exact: true })
    await expect(proceed).toBeDisabled()
    await modal
        .getByRole('checkbox', { name: /I have read and acknowledge the Study Agreement/i })
        .check()
    await expect(proceed).toBeEnabled()
    await proceed.click()
    await expect(modal).toBeHidden()
}

const researcherAcknowledgementSteps: Step[] = [
    {
        // Runs on the /code page the lifecycle has just routed to.
        name: 'Researcher acknowledges the study agreement',
        run: ctx =>
            ctx.step(async () => {
                await acknowledgeStudyAgreement(ctx)
                await expect(ctx.page.getByText(AGREEMENT_GATE_COPY)).toHaveCount(0)
            }),
    },
]

const reviewerAcknowledgementSteps: Step[] = [
    {
        // The reviewer's first look at the submitted code is the first time they reach
        // the study since the agreement was published, so the modal is raised there.
        name: 'Reviewer acknowledges the study agreement',
        run: ctx =>
            ctx.step(async () => {
                await ctx.page.goto(`${ctx.baseURL}/${REVIEWER_ORG}/study/${studyId(ctx)}/review`, {
                    waitUntil: 'domcontentloaded',
                })
                await acknowledgeStudyAgreement(ctx)
            }),
    },
]

// SI Admin → Legal → Study Agreements. The upload modal is a cascade: each select
// stays disabled until the one above it loads, and the Study list holds only
// approved studies with no agreement yet — so our study appearing in it at all is
// itself a check that the gate is still open for it.
async function publishStudyAgreement(ctx: RunContext): Promise<void> {
    const page = ctx.page
    await page.goto(`${ctx.baseURL}/admin/safeinsights/legal`, { waitUntil: 'domcontentloaded' })
    // Both controls are server-rendered: a click before hydration is swallowed (the
    // tab stays on Terms of Service), so each is re-driven until its target renders.
    await clickUntil(
        page.getByRole('tab', { name: 'Study Agreements' }),
        page.getByRole('button', { name: 'Upload signed study agreement' })
    )
    const upload = page.getByRole('dialog', { name: 'Upload a signed study agreement' })
    await clickUntil(page.getByRole('button', { name: 'Upload signed study agreement' }), upload)

    await pickOption(ctx, 'Data Partner', REVIEWER_ORG_NAME)
    await pickOption(ctx, 'Research Lab', RESEARCHER_ORG_NAME)
    await pickOption(ctx, 'Study', studyTitle(ctx))
    await upload.getByLabel('Signed on').fill(new Date().toISOString().slice(0, 10))
    await upload.locator('input[type="file"]').setInputFiles({
        name: 'study-agreement.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(minimalPdf(`QA study agreement ${ctx.tag}`)),
    })
    await upload.getByText('study-agreement.pdf').first().waitFor()

    // Publish opens a SECOND dialog stacked in its own portal above the upload modal;
    // its "Yes, publish" is the control that actually commits.
    const confirm = page.getByRole('dialog', { name: 'Publish this file?' })
    await upload.getByRole('button', { name: 'Publish', exact: true }).click()
    await confirm.getByRole('button', { name: 'Yes, publish' }).click()
    await expect(confirm).toBeHidden()
    await expect(upload).toBeHidden()
    await expect(page.getByRole('row').filter({ hasText: studyId(ctx) })).toBeVisible()
}

// Mantine Selects: the textbox opens a portal listbox. Scoped to the upload dialog for
// the textbox, but the options live outside it, so they are matched page-wide.
async function pickOption(ctx: RunContext, label: string, option: string): Promise<void> {
    const upload = ctx.page.getByRole('dialog', { name: 'Upload a signed study agreement' })
    const select = upload.getByRole('textbox', { name: label, exact: true })
    await select.click()
    await ctx.page.getByRole('option', { name: option, exact: true }).click()
    await expect(select).toHaveValue(option)
}

// A one-page PDF built in memory, so the suite ships no binary fixture. The xref
// offsets are computed rather than hardcoded, which keeps it a well-formed file for
// any server-side PDF check.
function minimalPdf(text: string): string {
    const safe = text.replace(/[()\\]/g, '')
    const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    let out = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
        offsets.push(out.length)
        out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = out.length
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return out
}

export const studyAgreementsHappyPathSuite: Suite = {
    name: 'study-agreements-happy-path',
    description:
        'Full study lifecycle from Agreements Lab (a non-test lab): the agreement gate holds the study until an SI admin publishes a signed Study Agreement',
    roles: ['researcher'],
    steps: studyLifecycleSteps({
        researcherOrg: RESEARCHER_ORG,
        principalInvestigator: PRINCIPAL_INVESTIGATOR,
        afterProposalApproval: agreementSteps,
        onCodeStepReached: researcherAcknowledgementSteps,
        beforeCodeReview: reviewerAcknowledgementSteps,
    }),
}

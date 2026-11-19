import path from 'node:path'
import { expect } from '@playwright/test'
import {
    DATA_ORG_SETTING,
    DATA_ORGS,
    resolveDataOrg,
    type StudyContent,
} from '../engine/flows/study'
import { expectToastVisible } from '../engine/flows/toasts'
import { repoDir } from '../engine/paths'
import {
    dataOrg,
    electMainFile,
    fileRow,
    openCodeReview,
    setCodeCriteria,
    studyLifecycleSteps,
    submitCodeReview,
    typeCodeFeedback,
} from './study-happy-path'
import type { RunContext, Step, Suite } from './types'

// Leaves a study whose code is APPROVED, so its job is queued for the chosen Data
// Partner's enclave, and stops. Nothing waits for results and nothing is deleted:
// the study is the product, for someone to watch run in the enclave by hand.
//
// The Data Partner comes from the QAR_DATA_ORG setting (`qar run --data-org mars-u`),
// default openstax. The researcher proposes from Openstax Lab either way.
//
// No IDE and no change-request round: those are study-happy-path's subject. The code
// goes up through the /code page's file input and is approved on the first review.

const RESEARCHER_ORG = 'openstax-lab'
const MAIN_FILE = 'main.r'

// Openstax Lab is a Test Lab under Openstax, so its studies to Openstax skip the
// Study Agreement gate. Whether that holds for another partner is not known, and a
// gated study cannot submit code, so the suite names the gate instead of timing out
// on a Submit dialog that never opens. Singular since management-app 1e6718e (Nov 13
// 2026); the plural is kept for releases before it.
const AGREEMENT_GATE_COPY = /Study Agreements? (is|are) being prepared/i

function studyId(ctx: RunContext): string {
    return ctx.state.studyId as string
}

function reviewUrl(ctx: RunContext): string {
    return `${ctx.baseURL}/${dataOrg(ctx)}/study/${studyId(ctx)}/review`
}

// The notice renders only once the agreement status query resolves, so a one-shot
// isVisible() could pass a gated study. "Submit code for review" is disabled while that
// status is in flight and while it blocks, and by nothing else, so wait until either it
// is enabled or the notice shows: then the page has settled one way or the other.
async function failIfAgreementGate(ctx: RunContext): Promise<void> {
    const submit = ctx.page.getByRole('button', { name: /^Submit code for review$/i })
    const gate = ctx.page.getByText(AGREEMENT_GATE_COPY).first()
    await expect(submit.and(ctx.page.locator(':enabled')).or(gate)).toBeVisible()
    if (await gate.isVisible()) {
        throw new Error(
            `Study ${studyId(ctx)} is held at the Study Agreement gate ("Study Agreement is being prepared"): ` +
                `${RESEARCHER_ORG} is not a test lab for ${DATA_ORGS[dataOrg(ctx)]}. ` +
                'An SI admin must publish a signed study agreement (see study-agreements-happy-path) before code can be submitted.'
        )
    }
}

const chooseDataOrgStep: Step = {
    name: 'Choose the data partner',
    run: ctx =>
        ctx.step(async () => {
            ctx.state.dataOrg = resolveDataOrg(ctx.setting(DATA_ORG_SETTING))
        }),
}

const codeSteps: Step[] = [
    {
        name: 'Researcher is not held at the agreement gate',
        run: ctx => ctx.step(() => failIfAgreementGate(ctx)),
    },
    {
        name: 'Upload main.r',
        run: ctx =>
            ctx.step(async () => {
                await ctx.page
                    .locator('input[type="file"]')
                    .setInputFiles(
                        path.join(
                            repoDir(),
                            'src',
                            'suites',
                            'fixtures',
                            'study-ready-to-run',
                            MAIN_FILE
                        )
                    )
                await fileRow(ctx, MAIN_FILE).waitFor({ state: 'visible' })
            }),
    },
    {
        name: 'Submit the study code',
        run: ctx =>
            ctx.step(async () => {
                await electMainFile(ctx, MAIN_FILE)
                await failIfAgreementGate(ctx)
                // The fixed AppShell footer intercepts pointer events on the button.
                await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
                await ctx.page.getByRole('button', { name: /Submit code/i }).click()
                // Scoped to the dialog: the page's own "Submit code for review" button
                // also matches a bare "Submit code" name.
                const submitDialog = ctx.page.getByRole('dialog', {
                    name: 'Submit code for review?',
                })
                await submitDialog.waitFor({ state: 'visible' })
                await submitDialog.getByRole('button', { name: 'Submit code', exact: true }).click()
                await ctx.page
                    .getByTestId('status-alert')
                    .filter({ hasText: /code submitted/i })
                    .waitFor({ state: 'visible' })
                await expectToastVisible(ctx.page, { title: 'Code submitted.' })
            }),
    },
    {
        name: 'Switch to the reviewer account',
        run: ctx => ctx.step(() => ctx.loginAs('reviewer')),
    },
    {
        name: 'Reviewer approves the code',
        run: ctx =>
            ctx.step(async () => {
                await openCodeReview(ctx, studyId(ctx))
                await setCodeCriteria(ctx, 'yes')
                await ctx.page.getByTestId('code-review-decision-approve').click()
                await typeCodeFeedback(ctx, (ctx.state.study as StudyContent).codeApprovalFeedback)
                // Anchored to the status line: the feedback text also begins "Code approved".
                await submitCodeReview(ctx, /^Approve code$/i, /^Code approved by /i)
            }),
    },
    {
        // The step's recorded URL carries the id too, so `run --json` shows it; the
        // stderr line is for a person reading the terminal.
        name: 'Report the ready-to-run study',
        run: ctx =>
            ctx.step(async () => {
                await ctx.page.goto(reviewUrl(ctx), { waitUntil: 'domcontentloaded' })
                await expect(ctx.page.getByText(/^Code approved by /i)).toBeVisible()
                process.stderr.write(
                    `[qar] Study ${studyId(ctx)} is approved and ready to run on ${dataOrg(ctx)}: ${reviewUrl(ctx)}\n`
                )
            }),
    },
]

export const studyReadyToRunSuite: Suite = {
    name: 'study-ready-to-run',
    description:
        'Create a study for a Data Partner (QAR_DATA_ORG / --data-org, default openstax), get its proposal and code approved, and leave it ready to run in the enclave (no results wait, no cleanup)',
    roles: ['researcher'],
    steps: [
        chooseDataOrgStep,
        ...studyLifecycleSteps({
            researcherOrg: RESEARCHER_ORG,
            endAtCodeStep: codeSteps,
            keepStudy: true,
        }),
    ],
}

import type { Page } from '@playwright/test'
import {
    conformanceStep,
    enableCheckpoints,
    type Insert,
    scanRouteStep,
    scanStep,
    withInserts,
} from '../engine/flows/accessibility'
import { DEFAULT_RESEARCHER_ORG } from '../engine/flows/study'
import { gotoReview, openCodeReview, studyLifecycleSteps } from './study-happy-path'
import type { RunContext, Step, Suite } from './types'

// The study-lifecycle half of the accessibility sweep. The `accessibility` suite scans
// pages reachable by URL with existing data; most study pages only exist mid-flow (a
// filled proposal, a code review awaiting a decision, outputs behind a key), so this
// suite drives a NEW study through the whole happy path and scans each stage as the
// flow reaches it. The happy path's own steps do the driving; this file only says
// where to look.
//
// Scans record and never fail; conformanceStep at the end gives the verdict, AFTER the
// happy path's cleanup has deleted the study.

const LAB = DEFAULT_RESEARCHER_ORG
const DATA_ORG = 'openstax'

function studyId(ctx: RunContext): string {
    return ctx.state.studyId as string
}

// Scan a study subpage by URL, as the signed-in role sees it at this stage. These are
// pages linked from the stage the flow is on but never opened by it.
function scanRoute(label: string, org: string, subpage: string): Step {
    return scanRouteStep(label, ctx => `/${org}/study/${studyId(ctx)}/${subpage}`)
}

async function gotoStudyPage(ctx: RunContext, page: string): Promise<void> {
    await ctx.page.goto(`${ctx.baseURL}/${LAB}/study/${studyId(ctx)}/${page}`, {
        waitUntil: 'domcontentloaded',
    })
}

const statusAlert = (page: Page) => page.getByTestId('status-alert')

const INSERTS: Insert[] = [
    { after: 'Start a new study proposal', steps: [scanStep('study setup (dataset picker)')] },
    {
        after: 'Step 1: name the study, choose org and language, then capture the study id',
        steps: [scanStep('proposal form, empty')],
    },
    { after: 'Step 2: fill the proposal', steps: [scanStep('proposal form, filled')] },
    {
        after: 'Submit the initial request',
        steps: [
            scanStep('proposal submitted'),
            scanRoute('submitted proposal, read-only edit page', LAB, 'edit'),
        ],
    },
    {
        after: 'Switch to the reviewer account',
        steps: [
            scanStep(
                'reviewer proposal review',
                ctx => gotoReview(ctx, studyId(ctx)),
                page => page.getByTestId('review-decision-section')
            ),
        ],
    },
    {
        after: 'Reviewer approves the proposal',
        steps: [
            scanStep('reviewer proposal approved'),
            scanRoute('reviewer full proposal', DATA_ORG, 'review/proposal'),
            scanRoute('reviewer agreements', DATA_ORG, 'agreements/reviewer'),
        ],
    },
    {
        after: 'Switch back to the researcher account',
        steps: [
            scanRoute('researcher full proposal', LAB, 'proposal'),
            scanRoute('researcher agreements', LAB, 'agreements/researcher'),
        ],
    },
    { after: 'Upload the study code (round 1)', steps: [scanStep('code upload with files')] },
    {
        after: 'Submit the study code (round 1)',
        steps: [
            scanStep('researcher view, code submitted'),
            scanRoute('researcher submitted code', LAB, 'view/code'),
        ],
    },
    {
        // The reviewer's first code review, before the form is touched.
        after: 'Switch to the reviewer account',
        occurrence: 2,
        steps: [scanStep('reviewer code review', ctx => openCodeReview(ctx, studyId(ctx)))],
    },
    {
        after: 'Reviewer requests code changes',
        steps: [scanStep('reviewer code changes requested')],
    },
    {
        after: 'Switch back to the researcher account',
        occurrence: 2,
        steps: [
            scanStep(
                'researcher view, code changes requested',
                ctx => gotoStudyPage(ctx, 'view'),
                statusAlert
            ),
            scanStep(
                'resubmit code (Edit code)',
                ctx => gotoStudyPage(ctx, 'resubmit'),
                page => page.getByRole('heading', { name: /^Edit code$/i })
            ),
        ],
    },
    {
        after: 'Resubmit the study code with vulnerable scripts (round 2 / re-run)',
        steps: [scanStep('researcher view, code resubmitted')],
    },
    {
        after: 'The AI summary describes the insecure code',
        // /review/code waits for loaders to clear, so it is scanned once the analysis
        // has finished rather than while the scan is still pending.
        steps: [
            scanStep('reviewer code review with scan and AI summary'),
            scanRoute('reviewer submitted code', DATA_ORG, 'review/code'),
        ],
    },
    { after: 'Reviewer approves the code', steps: [scanStep('reviewer code approved')] },
    {
        after: 'Wait for the run to complete and produce results',
        steps: [
            scanStep(
                'reviewer results, locked',
                ctx => gotoReview(ctx, studyId(ctx)),
                page => page.getByRole('textbox', { name: /(results|security) key/i })
            ),
        ],
    },
    {
        after: 'Reviewer decrypts and views the results',
        steps: [scanStep('reviewer results, decrypted')],
    },
    { after: 'Reviewer approves the results', steps: [scanStep('reviewer results approved')] },
    {
        after: 'Switch back to the researcher account',
        occurrence: 3,
        steps: [
            scanStep(
                'researcher outputs, locked',
                ctx => gotoStudyPage(ctx, 'view'),
                page => page.getByTestId('security-key-form')
            ),
        ],
    },
    {
        after: 'Researcher decrypts and sees the shared outputs',
        steps: [scanStep('researcher outputs, decrypted')],
    },
]

function lifecycleWithScans(): Step[] {
    const base = studyLifecycleSteps({
        researcherOrg: LAB,
        onCodeStepReached: [scanStep('code upload, empty')],
    })
    return [enableCheckpoints, ...withInserts(base, INSERTS), conformanceStep]
}

export const accessibilityLifecycleSuite: Suite = {
    name: 'accessibility-lifecycle',
    description:
        'Drive a new study through the full lifecycle and scan every stage with axe-core for WCAG 2.2 A/AA',
    roles: ['researcher'],
    steps: lifecycleWithScans(),
}

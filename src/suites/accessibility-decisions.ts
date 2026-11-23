import { accessibilitySweep, scanRouteStep, scanStep } from '../engine/flows/accessibility'
import { DEFAULT_RESEARCHER_ORG } from '../engine/flows/study'
import { proposalDecisionsSuite } from './proposal-decisions'
import type { RunContext } from './types'

// Part of the accessibility sweep over flows the happy path never reaches: it runs the
// proposal-decisions suite's own steps unchanged, with scans spliced in after the steps
// that leave a new screen up and checkpoints switched on for screens that exist only
// inside a step (see accessibilitySweep). One suite per file, named after the suite: a
// retry reloads src/suites/<suite name>.ts.

const LAB = DEFAULT_RESEARCHER_ORG

function studyId(ctx: RunContext): string {
    return ctx.state.studyId as string
}

export const accessibilityDecisionsSuite = accessibilitySweep(
    proposalDecisionsSuite,
    'accessibility-decisions',
    'Scan the proposal revision, resubmission and decline screens for WCAG 2.2 A/AA',
    [
        {
            after: 'Reviewer requests a revision',
            steps: [scanStep('reviewer, revision requested')],
        },
        {
            after: 'Researcher sees the revision request and opens Edit proposal',
            steps: [scanStep('edit and resubmit proposal')],
        },
        {
            after: 'Resubmitting without a note is blocked',
            steps: [scanStep('resubmit blocked, note required error')],
        },
        {
            after: 'Researcher revises the proposal and resubmits it with a note',
            steps: [scanStep('researcher, proposal resubmitted')],
        },
        {
            after: 'Reviewer sees the revised proposal and the resubmission note',
            steps: [scanStep('reviewer, revised proposal with note')],
        },
        {
            after: 'Reviewer declines the proposal',
            steps: [scanStep('reviewer, proposal declined')],
        },
        {
            after: 'Researcher sees the decline and can no longer edit the proposal',
            steps: [
                scanStep('page not found, signed in'),
                scanRouteStep(
                    'researcher, proposal declined',
                    ctx => `/${LAB}/study/${studyId(ctx)}/submitted`
                ),
            ],
        },
    ]
)

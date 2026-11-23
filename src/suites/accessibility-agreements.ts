import { accessibilitySweep, scanStep } from '../engine/flows/accessibility'
import { studyAgreementsHappyPathSuite } from './study-agreements-happy-path'

// Part of the accessibility sweep over flows the happy path never reaches: it runs the
// study-agreements-happy-path suite's own steps unchanged, with scans spliced in after
// the steps that leave a new screen up and checkpoints switched on for screens that
// exist only inside a step (see accessibilitySweep). One suite per file, named after
// the suite: a retry reloads src/suites/<suite name>.ts.

export const accessibilityAgreementsSuite = accessibilitySweep(
    studyAgreementsHappyPathSuite,
    'accessibility-agreements',
    'Scan the study agreement gate, publishing and acknowledgement screens for WCAG 2.2 A/AA',
    [
        {
            after: 'Reviewer sees the study agreement gate',
            steps: [scanStep('reviewer, study agreement gate')],
        },
        {
            after: 'Researcher is held at the agreement gate',
            steps: [scanStep('researcher, held at the agreement gate')],
        },
        {
            after: 'Admin publishes the signed study agreement',
            steps: [scanStep('SafeInsights legal, study agreement published')],
        },
        {
            after: 'Researcher is no longer held at the agreement gate',
            steps: [scanStep('researcher, agreement gate cleared')],
        },
        {
            after: 'Reviewer acknowledges the study agreement',
            steps: [scanStep('reviewer, agreement acknowledged')],
        },
    ]
)

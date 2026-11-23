import { accessibilitySweep, scanStep } from '../engine/flows/accessibility'
import { newUserSignupFlowsSuite } from './new-user-signup-flows'

// Part of the accessibility sweep over flows the happy path never reaches: it runs the
// new-user-signup-flows suite's own steps unchanged, with scans spliced in after the
// steps that leave a new screen up and checkpoints switched on for screens that exist
// only inside a step (see accessibilitySweep). One suite per file, named after the
// suite: a retry reloads src/suites/<suite name>.ts.

// Every onboarding screen sits inside a step (invite landing, signup, MFA enrolment,
// recovery codes, security key, join-team, link-email), so they come from checkpoints
// in the flow; the inserts add the dashboards a brand-new user lands on.
export const accessibilityOnboardingSuite = accessibilitySweep(
    newUserSignupFlowsSuite,
    'accessibility-onboarding',
    'Scan invitation, signup, MFA enrolment, security key and team-joining screens for WCAG 2.2 A/AA',
    [
        {
            after: 'My dashboard is empty, with no audience toggle for a single-org user',
            steps: [scanStep('new user, empty researcher dashboard')],
        },
        {
            after: 'My dashboard is empty for BOTH audiences now that the user is in two orgs',
            steps: [scanStep('new user, empty dashboard with audience toggle')],
        },
    ]
)

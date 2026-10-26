import { signedInMarker } from '../engine/auth'
import type { Role } from '../engine/types'
import { studyHappyPathSuite } from './study-happy-path'
import type { Step, Suite } from './types'

// The regression baseline every release run starts with: each shared account can
// sign in, then the whole study lifecycle (create, IDE, submit, review, re-run,
// results) on the target env. The lifecycle steps are study-happy-path's own, so
// the two suites cannot drift.
function signInStep(role: Role): Step {
    return {
        name: `Sign in as ${role}: dashboard visible`,
        run: ctx =>
            ctx.step(async () => {
                await ctx.loginAs(role)
                await signedInMarker(ctx.page).waitFor({ state: 'visible' })
            }),
    }
}

export const releaseHappyPathSuite: Suite = {
    name: 'release-happy-path',
    description:
        'Release baseline: every role signs in, then the full study lifecycle runs end to end',
    roles: ['researcher'],
    // The lifecycle starts as the researcher, so that sign-in goes last.
    steps: [
        signInStep('admin'),
        signInStep('reviewer'),
        signInStep('researcher'),
        ...studyHappyPathSuite.steps,
    ],
}

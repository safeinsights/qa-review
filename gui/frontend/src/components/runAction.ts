// Which action the run control bar's primary button offers, given the run's state.
//
// Kept in a plain .ts module (not RunControls.tsx) so the engine's tsconfig — which
// has no JSX/DOM lib — can typecheck the tests that cover it. The component maps the
// returned kind to Mantine props; the precedence itself is the part worth pinning.
export type RunActionKind = 'teardown' | 'retryStep' | 'resume' | 'stop' | 'run'

export interface RunActionState {
    // Tearing down after Stop or Give up.
    stopping?: boolean
    // A step failed and the browser is held open for a retry.
    stepFailed?: boolean
    // Halted at a paused step, or an error-hold.
    paused?: boolean
    running?: boolean
}

// Teardown outranks everything: once the run is finishing there is no valid action
// left. Give up in particular reaches this state while `running` is still true — the
// engine has yet to emit its result — and without teardown winning, the button falls
// through to a live Stop. That reads as "give up did nothing", and pressing it exits
// the process before the result line, losing the verdict the run already reached.
// A stale step-failed envelope arriving mid-teardown must not resurrect Retry step
// either, so the check sits above that too.
export function runActionKind(s: RunActionState): RunActionKind {
    if (s.stopping) return 'teardown'
    if (s.stepFailed) return 'retryStep'
    if (s.paused) return 'resume'
    if (s.running) return 'stop'
    return 'run'
}

// The teardown button names the action that started it — Give up is not a stop, and
// labelling it "Stopping…" invites the same doubt the disabled state exists to remove.
export function teardownLabel(startedBy: 'stop' | 'giveUp'): string {
    return startedBy === 'giveUp' ? 'Finishing…' : 'Stopping…'
}

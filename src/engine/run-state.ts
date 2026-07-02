import type { RunResult, RunState, StepEvent } from '@/engine/types'

// Collapse the append-only step stream into one entry per executed position
// (same rule as the GUI's stepsByIndex): a 'running' opens a position; its
// resolution replaces it in place. Positional so repeated step names don't merge.
export function buildRunState(events: StepEvent[], result?: RunResult): RunState {
    const steps: StepEvent[] = []
    for (const e of events) {
        if (e.status === 'running') steps.push(e)
        else if (steps.length > 0) steps[steps.length - 1] = e
        else steps.push(e)
    }
    return { steps, result, running: result === undefined }
}

// Truncate the append-only event stream to the first `position` executed positions,
// mutating `events` in place. Used by the run loop when a failed step is retried:
// dropping the failed position's events lets the retried step's re-emitted
// 'running'→'passed' re-occupy that position instead of appending a duplicate (which
// would misalign the GUI's positional step list). Mirrors buildRunState's collapse
// rule: a 'running' opens a position; its resolution stays within the same one.
export function truncateEventsToPosition(events: StepEvent[], position: number): void {
    let seen = 0
    let cut = events.length
    for (let i = 0; i < events.length; i++) {
        if (events[i].status === 'running') {
            if (seen === position) {
                cut = i
                break
            }
            seen++
        }
    }
    events.length = cut
}

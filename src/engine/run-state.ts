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

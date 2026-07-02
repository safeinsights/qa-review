import type { ConsoleLine } from './screencast'

export type StepEnvelope = {
    type: 'step'
    name: string
    status: string
    error?: string
    screenshot?: string
    url?: string
    console?: ConsoleLine[]
    // Epoch ms when this event was emitted (engine's StepEvent.at). On a 'running'
    // event this is the step's start; on a resolved event it's the finish.
    at?: number
    // The 'running' event's `at`, carried onto the resolved event by stepsByIndex so
    // a row can show its duration (resolved.at − startedAt). Only on resolved rows.
    startedAt?: number
}
export type ResultEnvelope = {
    type: 'result'
    ok: boolean
    failureCategory?: string
    bundleDir?: string
    cleanup?: { ok: boolean; failed?: string[] }
    [k: string]: unknown
}
export type ScreencastEnvelope = { type: 'screencast'; port: number; cdpPort: number }
// Emitted when the run halts before a step the user marked "pause before".
export type PausedEnvelope = { type: 'paused'; name: string }
// Emitted when a run FAILS and the engine holds the browser open (frozen at the
// failure) so the companion can inspect/drive it. The run stays blocked until a
// {type:'resume'} control message arrives (same channel as `paused`), then it tears
// down. Mirrors the engine's ErrorHoldInfo (src/engine/types.ts).
export type ErrorHoldEnvelope = { type: 'error-hold'; failureCategory?: string; error?: string }
// Emitted when a suite STEP throws and the engine holds the browser open for an
// in-process retry. Distinct from error-hold: the user can edit the suite (via the
// companion) then send {type:'retry-step'} to re-run this step against the live
// browser, or {type:'give-up'} to fail the run. Mirrors StepFailedInfo.
export type StepFailedEnvelope = {
    type: 'step-failed'
    index: number
    stepName: string
    error?: string
    failureCategory?: string
}
export type Envelope =
    | StepEnvelope
    | ResultEnvelope
    | ScreencastEnvelope
    | PausedEnvelope
    | ErrorHoldEnvelope
    | StepFailedEnvelope

// Collapse the append-only step-event stream into one event per EXECUTED
// position, in order. The engine emits each step as a 'running' entry then
// replaces it with 'passed'/'failed' — both stream in. A 'running' opens the
// next position; its resolution updates that same position. Positional (not
// keyed by name) so a suite with repeated step names doesn't light up every
// same-named row when a single instance passes.
export function stepsByIndex(steps: StepEnvelope[]): StepEnvelope[] {
    const byIndex: StepEnvelope[] = []
    for (const s of steps) {
        if (s.status === 'running') byIndex.push(s)
        else if (byIndex.length > 0) {
            // Carry the 'running' event's start time onto the resolved event so the
            // row can render its duration (the running entry is replaced here).
            byIndex[byIndex.length - 1] = { ...s, startedAt: byIndex[byIndex.length - 1].at }
        } else byIndex.push(s) // resolved event with no preceding 'running' (defensive)
    }
    return byIndex
}

// Short, human duration for a completed step: `<1s`, whole seconds under a minute
// (`35s`), else minutes:seconds (`1:23`). Returns null when timing is unavailable
// (e.g. a resolved event with no preceding 'running', or a still-running step).
export function stepDuration(step: StepEnvelope): string | null {
    if (step.startedAt === undefined || step.at === undefined) return null
    const ms = step.at - step.startedAt
    if (ms < 0) return null
    if (ms < 1000) return '<1s'
    const secs = Math.round(ms / 1000)
    if (secs < 60) return `${secs}s`
    const mins = Math.floor(secs / 60)
    return `${mins}:${String(secs % 60).padStart(2, '0')}`
}

function parse(line: string): Envelope | null {
    let obj: unknown
    try {
        obj = JSON.parse(line)
    } catch {
        return null
    }
    if (obj && typeof obj === 'object' && 'type' in obj) {
        const t = (obj as { type: unknown }).type
        if (
            t === 'step' ||
            t === 'result' ||
            t === 'screencast' ||
            t === 'paused' ||
            t === 'error-hold' ||
            t === 'step-failed'
        )
            return obj as Envelope
    }
    return null
}

// Accumulates stdout chunks and yields complete NDJSON envelopes, holding any
// trailing partial line until the rest arrives.
export class StreamParser {
    private buffer = ''

    push(chunk: string): Envelope[] {
        this.buffer += chunk
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() ?? ''
        const out: Envelope[] = []
        for (const line of lines) {
            const env = parse(line)
            if (env) out.push(env)
        }
        return out
    }
}

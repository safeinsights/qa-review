import type { PausedInfo, RunResult, ScreencastInfo, SessionInfo, StepEvent } from '@/engine/types'

export type StepEnvelope = { type: 'step' } & StepEvent
export type ResultEnvelope = { type: 'result' } & RunResult
export type ScreencastEnvelope = { type: 'screencast' } & ScreencastInfo
export type SessionEnvelope = { type: 'session' } & SessionInfo
export type PausedEnvelope = { type: 'paused' } & PausedInfo
export type Envelope =
    | StepEnvelope
    | ResultEnvelope
    | ScreencastEnvelope
    | SessionEnvelope
    | PausedEnvelope

export function stepLine(event: StepEvent): string {
    return `${JSON.stringify({ type: 'step', ...event })}\n`
}

export function resultLine(result: RunResult): string {
    return `${JSON.stringify({ type: 'result', ...result })}\n`
}

export function screencastLine(info: ScreencastInfo): string {
    return `${JSON.stringify({ type: 'screencast', ...info })}\n`
}

export function sessionLine(info: SessionInfo): string {
    return `${JSON.stringify({ type: 'session', ...info })}\n`
}

export function pausedLine(info: PausedInfo): string {
    return `${JSON.stringify({ type: 'paused', ...info })}\n`
}

// Parse one stdout line into an Envelope, or null if it isn't one of ours
// (lets consumers ignore stray log output interleaved on stdout).
export function parseLine(line: string): Envelope | null {
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
            t === 'session' ||
            t === 'paused'
        ) {
            return obj as Envelope
        }
    }
    return null
}

// --- Inbound control channel (GUI → engine, over the run's stdin) ---
//
// The GUI writes these NDJSON lines to the engine's stdin to drive pausing:
//   { "type": "pause-set", "steps": ["Step A", "Step B"] }  — replace the paused set
//   { "type": "resume" }                                    — continue a halted run
// pause-set carries the FULL current set (idempotent, race-free): each live toggle
// sends the whole set, so engine and GUI never drift.
export type ControlMessage = { type: 'pause-set'; steps: string[] } | { type: 'resume' }

export function pauseSetLine(steps: string[]): string {
    return `${JSON.stringify({ type: 'pause-set', steps })}\n`
}

export function resumeLine(): string {
    return `${JSON.stringify({ type: 'resume' })}\n`
}

// Parse one inbound control line, or null if it isn't a valid control message.
export function parseControlLine(line: string): ControlMessage | null {
    let obj: unknown
    try {
        obj = JSON.parse(line)
    } catch {
        return null
    }
    if (!obj || typeof obj !== 'object' || !('type' in obj)) return null
    const t = (obj as { type: unknown }).type
    if (t === 'resume') return { type: 'resume' }
    if (t === 'pause-set') {
        const steps = (obj as Record<string, unknown>).steps
        if (Array.isArray(steps) && steps.every(s => typeof s === 'string')) {
            return { type: 'pause-set', steps: steps as string[] }
        }
    }
    return null
}

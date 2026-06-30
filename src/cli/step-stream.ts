import type { StepEvent, RunResult } from '@/engine/types'

export type StepEnvelope = { type: 'step' } & StepEvent
export type ResultEnvelope = { type: 'result' } & RunResult
export type Envelope = StepEnvelope | ResultEnvelope

export function stepLine(event: StepEvent): string {
    return JSON.stringify({ type: 'step', ...event }) + '\n'
}

export function resultLine(result: RunResult): string {
    return JSON.stringify({ type: 'result', ...result }) + '\n'
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
        if (t === 'step' || t === 'result') return obj as Envelope
    }
    return null
}

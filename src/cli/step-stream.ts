import type { StepEvent, RunResult, ScreencastInfo } from '@/engine/types'

export type StepEnvelope = { type: 'step' } & StepEvent
export type ResultEnvelope = { type: 'result' } & RunResult
export type ScreencastEnvelope = { type: 'screencast' } & ScreencastInfo
export type Envelope = StepEnvelope | ResultEnvelope | ScreencastEnvelope

export function stepLine(event: StepEvent): string {
    return JSON.stringify({ type: 'step', ...event }) + '\n'
}

export function resultLine(result: RunResult): string {
    return JSON.stringify({ type: 'result', ...result }) + '\n'
}

export function screencastLine(info: ScreencastInfo): string {
    return JSON.stringify({ type: 'screencast', ...info }) + '\n'
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
        if (t === 'step' || t === 'result' || t === 'screencast') return obj as Envelope
    }
    return null
}

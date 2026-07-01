export type StepEnvelope = { type: 'step'; name: string; status: string; error?: string; screenshot?: string; url?: string }
export type ResultEnvelope = { type: 'result'; ok: boolean; [k: string]: unknown }
export type ScreencastEnvelope = { type: 'screencast'; port: number }
// Emitted when the run halts before a step the user marked "pause before".
export type PausedEnvelope = { type: 'paused'; name: string }
export type Envelope = StepEnvelope | ResultEnvelope | ScreencastEnvelope | PausedEnvelope

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
        else if (byIndex.length > 0) byIndex[byIndex.length - 1] = s
        else byIndex.push(s) // resolved event with no preceding 'running' (defensive)
    }
    return byIndex
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
        if (t === 'step' || t === 'result' || t === 'screencast' || t === 'paused') return obj as Envelope
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

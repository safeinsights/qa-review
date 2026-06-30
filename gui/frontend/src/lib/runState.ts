// A tiny module-level snapshot of the latest Suites run, so the header's "Report
// Issue" button can attach the current run state without prop-drilling through the
// tab tree. RunScreen writes it; ReportIssueButton reads it at click time.
import type { StepEnvelope, ResultEnvelope } from './stepStream'

interface RunState {
    spec: string[] | null // the qar args of the active run
    steps: StepEnvelope[]
    result: ResultEnvelope | null
    running: boolean
    error: string | null
}

let current: RunState = { spec: null, steps: [], result: null, running: false, error: null }

export function setRunState(s: RunState): void {
    current = s
}

// A human-readable summary of the current Suites run for an issue body.
export function runStateSummary(): string {
    const { spec, steps, result, running, error } = current
    if (!spec && steps.length === 0 && !result && !error) return ''

    const lines: string[] = []
    if (spec) lines.push('command: qar ' + spec.join(' '))
    lines.push('status: ' + (running ? 'running' : result ? (result.ok ? 'passed' : 'failed') : error ? 'error' : 'idle'))
    if (result?.failureCategory) lines.push('failureCategory: ' + String(result.failureCategory))
    if (result?.bundleDir) lines.push('bundleDir: ' + String(result.bundleDir))
    if (error) lines.push('error: ' + error)

    if (steps.length > 0) {
        lines.push('', 'steps:')
        for (const s of steps) {
            const mark = s.status === 'passed' ? 'PASS' : s.status === 'failed' ? 'FAIL' : s.status.toUpperCase()
            lines.push(`  [${mark}] ${s.name}${s.error ? ' — ' + s.error : ''}`)
        }
    }

    const cleanup = result?.cleanup as { ok: boolean; failed?: string[] } | undefined
    if (cleanup) {
        lines.push('', `cleanup: ${cleanup.ok ? 'ok' : 'FAILED'}${cleanup.failed?.length ? ' (' + cleanup.failed.join(', ') + ')' : ''}`)
    }
    return lines.join('\n')
}

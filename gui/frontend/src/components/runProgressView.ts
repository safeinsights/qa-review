import type { RunProgress } from '../lib/ipc'

// Text for the progress panel above a release run's browser. A plain module, not the
// component, so the engine's tsconfig (no --jsx) can typecheck its tests.

const STEP_TEXT: Record<Exclude<RunProgress['step'], ''>, string> = {
    setup: 'Setting up',
    cleanup: 'Cleaning up',
    report: 'Writing the report',
}

export interface ProgressView {
    headline: string
    detail: string
    percent: number
    countsText: string
    remainingText: string
}

export function remainingText(p: RunProgress): string {
    if (p.total > 0 && p.done >= p.total) return 'All lines have a result'
    if (p.remainingSec <= 0) return 'Estimate after the first few lines'
    const minutes = Math.max(1, Math.round(p.remainingSec / 60))
    const hours = Math.floor(minutes / 60)
    const time = hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`
    return `About ${time} left at the pace so far`
}

function headline(p: RunProgress): string {
    if (p.line) return `${p.line.id} · ${p.line.title}`
    if (p.step) return STEP_TEXT[p.step]
    return 'Between lines'
}

function detail(p: RunProgress): string {
    const parts = p.line ? [p.line.group, `line ${p.position} of ${p.total}`] : []
    if (p.note) parts.push(p.note)
    return parts.join(' — ')
}

const COUNT_ORDER = ['PASS', 'FAIL', 'NOT TESTED', 'UNCLEAR', 'CONFLICT']

function countsText(p: RunProgress): string {
    const parts = COUNT_ORDER.filter(r => p.counts[r]).map(r => `${r} ${p.counts[r]}`)
    return `${p.done} of ${p.total} done${parts.length ? ` · ${parts.join(' · ')}` : ''}`
}

export function progressView(p: RunProgress): ProgressView {
    if (!p.started) {
        return {
            headline: 'Waiting for the run to start',
            detail: p.total ? `${p.total} lines in the plan` : '',
            percent: 0,
            countsText: '',
            remainingText: '',
        }
    }
    return {
        headline: headline(p),
        detail: detail(p),
        percent: p.total ? Math.round((p.done / p.total) * 100) : 0,
        countsText: countsText(p),
        remainingText: remainingText(p),
    }
}

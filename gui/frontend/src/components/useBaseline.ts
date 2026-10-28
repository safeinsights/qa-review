import { useEffect, useState } from 'react'
import { onBaselineDone, onBaselineStep } from '../lib/ipc'
import type { BaselineState } from './runProgressView'

export type { BaselineState }

// The release-happy-path baseline. Go starts it inside the run session, on the
// session's streamed browser (gui/baseline.go startSessionBaseline); this only
// follows its events. Stopping the session stops it.
export function useBaseline(tag: string) {
    const [state, setState] = useState<BaselineState>({ phase: 'idle' })

    useEffect(() => {
        let gone = false
        const unsubs: (() => void)[] = []
        const keep = (u: () => void) => (gone ? u() : unsubs.push(u))
        onBaselineStep(s => {
            if (s.tag !== tag) return
            setState({ phase: 'running', index: s.index, total: s.total, name: s.name })
        }).then(keep)
        onBaselineDone(d => {
            if (d.tag !== tag) return
            setState({ phase: 'done', passed: d.passed, failedStep: d.failedStep, error: d.error })
        }).then(keep)
        return () => {
            gone = true
            for (const u of unsubs) u()
        }
    }, [tag])

    const reset = () => setState({ phase: 'idle' })
    return { state, reset, isRunning: state.phase === 'running' }
}

export function baselineLabel(state: BaselineState): string {
    if (state.phase === 'idle') return ''
    if (state.phase === 'running') {
        if (state.index === 0) return 'Baseline: starting in the browser…'
        const of = state.total ? `/${state.total}` : ''
        return `Baseline: step ${state.index}${of} ${state.name}`
    }
    if (state.passed) return 'Baseline: passed'
    const where = state.failedStep ? ` at "${state.failedStep}"` : ''
    return `Baseline: FAILED${where}${state.error ? ` — ${state.error}` : ''}`
}

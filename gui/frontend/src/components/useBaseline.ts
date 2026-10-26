import { useEffect, useRef, useState } from 'react'
import { onBaselineDone, onBaselineStep, runBaseline, stopRun } from '../lib/ipc'

export type BaselineState =
    | { phase: 'idle' }
    | { phase: 'running'; index: number; total: number; name: string }
    | { phase: 'done'; passed: boolean; failedStep: string; error: string }

// The release-happy-path run that comes before the run session. `onFinished` fires
// when it ends on its own, passed or failed (a failed baseline does not stop the
// run); a baseline the user stopped does not start the session.
export function useBaseline(tag: string, onFinished: (env: string) => void) {
    const [state, setState] = useState<BaselineState>({ phase: 'idle' })
    const stopped = useRef(false)
    const running = useRef(false)
    const finished = useRef(onFinished)
    finished.current = onFinished

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
            running.current = false
            setState({ phase: 'done', passed: d.passed, failedStep: d.failedStep, error: d.error })
            if (!stopped.current) finished.current(d.env)
        }).then(keep)
        return () => {
            gone = true
            for (const u of unsubs) u()
            // Leaving the Run phase must not leave a browser run going with nobody
            // watching it.
            if (running.current) void stopRun()
        }
    }, [tag])

    const start = async (env: string) => {
        stopped.current = false
        setState({ phase: 'running', index: 0, total: 0, name: '' })
        running.current = true
        try {
            await runBaseline(tag, env)
        } catch (e) {
            running.current = false
            setState({ phase: 'idle' })
            throw e
        }
    }

    const stop = async () => {
        stopped.current = true
        await stopRun()
    }

    return { state, start, stop, isRunning: state.phase === 'running' }
}

export function baselineLabel(state: BaselineState): string {
    if (state.phase === 'idle') return ''
    if (state.phase === 'running') {
        if (state.index === 0) return 'Baseline: starting…'
        const of = state.total ? `/${state.total}` : ''
        return `Baseline: step ${state.index}${of} ${state.name}`
    }
    if (state.passed) return 'Baseline: passed'
    const where = state.failedStep ? ` at "${state.failedStep}"` : ''
    return `Baseline: FAILED${where}${state.error ? ` — ${state.error}` : ''}`
}

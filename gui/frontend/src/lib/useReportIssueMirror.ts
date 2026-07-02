import { useEffect } from 'react'
import type { RunSpec } from '../components/RunScreen'
import { setRunState } from './runState'
import type { RunState } from './useRunStream'

// Mirrors the live run into the module-level runState store so the header's
// "Report Issue" button can attach the current state regardless of which tab is
// active — without prop-drilling the run all the way up the tab tree.
export function useReportIssueMirror(spec: RunSpec | null, run: RunState): void {
    const { steps, result, running, error } = run
    useEffect(() => {
        const specArgs =
            spec?.kind === 'engine' ? spec.args : spec ? [spec.program, ...spec.args] : null
        setRunState({ spec: specArgs, steps, result, running, error })
    }, [spec, steps, result, running, error])
}

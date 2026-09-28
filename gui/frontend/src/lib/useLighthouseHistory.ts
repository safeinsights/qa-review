import { useCallback, useEffect, useState } from 'react'
import { type LighthouseRun, listLighthouseRuns } from './ipc'

export interface LighthouseHistory {
    runs: LighthouseRun[]
    loading: boolean
    error: string | null
    reload: () => void
}

// Loads past Lighthouse runs for the Performance tab. Fetching and error handling
// live here so the component stays presentational (see the React rules in
// CLAUDE.md: state and data processing belong in a hook, not in the JSX).
export function useLighthouseHistory(): LighthouseHistory {
    const [runs, setRuns] = useState<LighthouseRun[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [nonce, setNonce] = useState(0)

    const reload = useCallback(() => setNonce(n => n + 1), [])

    // `nonce` is the ONLY intended trigger: it bumps when reload() is called, which
    // is what re-reads the results dir after a new run. Biome reads it as an extra
    // dependency because the effect body never uses its value — but dropping it
    // would leave the Refresh button doing nothing.
    // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the reload trigger
    useEffect(() => {
        let cancelled = false
        setLoading(true)
        listLighthouseRuns()
            .then(list => {
                if (cancelled) return
                setRuns(list)
                setError(null)
            })
            .catch(e => {
                if (cancelled) return
                // Surface the failure rather than rendering an empty chart, which
                // would read as "no runs yet" and hide a broken read.
                setError(String(e))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [nonce])

    return { runs, loading, error, reload }
}

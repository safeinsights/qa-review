import { useCallback, useRef, useState } from 'react'

export interface AsyncAction<Args extends unknown[], T> {
    // Invoke the wrapped async fn: sets busy, clears the prior error, stores the
    // result (or the stringified error). Returns the result, or undefined on throw
    // — so callers can `await run()` and branch without a second try/catch.
    run: (...args: Args) => Promise<T | undefined>
    busy: boolean
    error: string | null
    result: T | null
    reset: () => void
}

// Wraps the "run an async backend action, track busy/result/error" pattern that
// recurs across every action button/panel (Sync, RequestAccess, ReportIssue,
// SetupDoctor, SetupGate, SaveSuite…). Normalizes thrown errors to `String(e)`
// and guarantees busy is cleared in `finally`. `run` is stable (safe as a
// useEffect dep), so components no longer need per-handler useCallback.
export function useAsyncAction<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>
): AsyncAction<Args, T> {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [result, setResult] = useState<T | null>(null)

    // Hold the latest fn in a ref so `run` stays referentially stable even when
    // the caller passes a fresh closure each render.
    const fnRef = useRef(fn)
    fnRef.current = fn

    const run = useCallback(async (...args: Args): Promise<T | undefined> => {
        setBusy(true)
        setError(null)
        try {
            const out = await fnRef.current(...args)
            setResult(out)
            return out
        } catch (e) {
            setError(String(e))
            return undefined
        } finally {
            setBusy(false)
        }
    }, [])

    const reset = useCallback(() => {
        setError(null)
        setResult(null)
    }, [])

    return { run, busy, error, result, reset }
}

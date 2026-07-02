import { useEffect, useState } from 'react'
import { readScreenshot } from './ipc'

// Loads a per-step screenshot's PNG bytes through the Go backend (file:// is
// blocked in the webview), keyed on the bundle dir + relative path. Returns the
// data URI (`src`) once fetched, or an `error` string on failure. The `alive`
// guard drops a resolution that lands after the inputs changed / the panel
// unmounted, so a stale screenshot never flashes in.
export function useScreenshot(
    bundleDir: string,
    rel: string
): { src: string | null; error: string | null } {
    const [src, setSrc] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let alive = true
        setSrc(null)
        setError(null)
        readScreenshot(bundleDir, rel)
            .then(dataUri => alive && setSrc(dataUri))
            .catch(e => alive && setError(String(e)))
        return () => {
            alive = false
        }
    }, [bundleDir, rel])

    return { src, error }
}

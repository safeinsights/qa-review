import { useEffect, useState } from 'react'
import { readVideoObjectUrl } from './ipc'

// Loads the run's recorded replay as a blob object URL, keyed on the bundle dir.
//
// It lives here (above RecordingPanel) rather than inside the panel because the
// panel unmounts every time the user flips to a per-step snapshot and back — local
// state there would re-fetch the video bytes and reset playback on every flip. The
// object URL is revoked on cleanup so the blob isn't leaked between runs.
export function useVideoObjectUrl(bundleDir: string | null): string | null {
    const [videoUrl, setVideoUrl] = useState<string | null>(null)

    useEffect(() => {
        if (!bundleDir) {
            setVideoUrl(null)
            return
        }
        let url: string | null = null
        let alive = true
        readVideoObjectUrl(bundleDir)
            .then(u => {
                if (alive) {
                    url = u
                    setVideoUrl(u)
                } else {
                    // Unmounted before the fetch resolved — don't leak the blob.
                    URL.revokeObjectURL(u)
                }
            })
            .catch(() => alive && setVideoUrl(null))
        return () => {
            alive = false
            if (url) URL.revokeObjectURL(url)
            setVideoUrl(null)
        }
    }, [bundleDir])

    return videoUrl
}

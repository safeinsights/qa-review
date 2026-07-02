import { type RefObject, useEffect, useRef, useState } from 'react'

// Drives a <video> element's playback state for VideoPlayer: it owns the
// play/pause + current-time + duration state, wires up the media event listeners,
// and applies the mount-time seek/resume handoff. The component just renders the
// returned state and wires `toggle`/`seek` to its buttons.
//
// Position handoff: onProgress reports (time, playing) so a sibling player can
// pick up where this one left off when the view switches between inline and
// expanded.
export function useVideoPlayback({
    src,
    startAt,
    startPlaying,
    onProgress,
}: {
    src: string
    startAt?: number
    startPlaying?: boolean
    onProgress?: (time: number, playing: boolean) => void
}): {
    ref: RefObject<HTMLVideoElement | null>
    playing: boolean
    current: number
    duration: number
    toggle: () => void
    seek: (e: React.ChangeEvent<HTMLInputElement>) => void
} {
    const ref = useRef<HTMLVideoElement>(null)
    const [playing, setPlaying] = useState(false)
    const [current, setCurrent] = useState(0)
    const [duration, setDuration] = useState(0)

    // Re-attach when the source changes (a new <video> element/src). `src` isn't
    // read inside the effect, but keeping it in the deps re-runs teardown+setup so
    // listeners bind to the new element — dropping it is a bug.
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach listeners on src change
    useEffect(() => {
        const v = ref.current
        if (!v) return
        const onTime = () => {
            setCurrent(v.currentTime)
            onProgress?.(v.currentTime, !v.paused)
        }
        const onMeta = () => setDuration(Number.isFinite(v.duration) ? v.duration : 0)
        const onPlay = () => {
            setPlaying(true)
            onProgress?.(v.currentTime, true)
        }
        const onPause = () => {
            setPlaying(false)
            onProgress?.(v.currentTime, false)
        }
        v.addEventListener('timeupdate', onTime)
        v.addEventListener('loadedmetadata', onMeta)
        v.addEventListener('durationchange', onMeta)
        v.addEventListener('play', onPlay)
        v.addEventListener('pause', onPause)
        return () => {
            v.removeEventListener('timeupdate', onTime)
            v.removeEventListener('loadedmetadata', onMeta)
            v.removeEventListener('durationchange', onMeta)
            v.removeEventListener('play', onPlay)
            v.removeEventListener('pause', onPause)
        }
    }, [src, onProgress])

    // On mount, seek to the handed-off position and resume playback if it was
    // playing. Runs only when the handoff values change (effectively once on mount).
    useEffect(() => {
        const v = ref.current
        if (!v) return
        const apply = () => {
            if (startAt && Math.abs(v.currentTime - startAt) > 0.25) v.currentTime = startAt
            if (startPlaying) void v.play().catch(() => {})
        }
        if (v.readyState >= 1) apply()
        else v.addEventListener('loadedmetadata', apply, { once: true })
    }, [startPlaying, startAt])

    const toggle = () => {
        const v = ref.current
        if (!v) return
        if (v.paused) void v.play()
        else v.pause()
    }

    const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = ref.current
        if (!v) return
        v.currentTime = Number(e.currentTarget.value)
        setCurrent(v.currentTime)
    }

    return { ref, playing, current, duration, toggle, seek }
}

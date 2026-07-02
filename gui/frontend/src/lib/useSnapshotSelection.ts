import { useCallback, useEffect, useRef, useState } from 'react'
import type { StepEnvelope } from './stepStream'

// A step whose captured screenshot is being viewed (flips the right panel from the
// live browser / recording to the SnapshotPanel).
export interface Selected {
    index: number
    step: StepEnvelope
}

export interface SnapshotSelection {
    selected: Selected | null
    select: (index: number, step: StepEnvelope) => void
    clear: () => void
    // Recording playback position, lifted above RecordingPanel so it survives the
    // panel unmounting while a snapshot shows (which would reset the video to 0).
    playback: { time: number; playing: boolean }
    onPlaybackProgress: (time: number, playing: boolean) => void
    // Called by the run stream when a fresh run starts — drops the viewed snapshot
    // and rewinds playback so the new run starts clean.
    reset: () => void
}

// Owns the "which snapshot is being viewed" + recording-playback state that sits
// beside a run but isn't part of the run's own NDJSON-driven state. Clears the
// viewed snapshot when the suite changes (`stepNames`) so a stale selection from
// the previous suite can't linger.
export function useSnapshotSelection(stepNames: string[]): SnapshotSelection {
    const [selected, setSelected] = useState<Selected | null>(null)
    const playback = useRef({ time: 0, playing: false })

    const select = useCallback((index: number, step: StepEnvelope) => {
        setSelected({ index, step })
    }, [])
    const clear = useCallback(() => setSelected(null), [])
    const onPlaybackProgress = useCallback((time: number, playing: boolean) => {
        playback.current = { time, playing }
    }, [])
    const reset = useCallback(() => {
        setSelected(null)
        playback.current = { time: 0, playing: false }
    }, [])

    // Suite switch → drop any viewed snapshot (the run stream clears its own state
    // on the same change). Compared against the previous joined names so an
    // unchanged set is a no-op — the same prev-ref idiom useRunStream uses to reset.
    const stepNamesKey = stepNames.join(' ')
    const prevKey = useRef(stepNamesKey)
    useEffect(() => {
        if (prevKey.current === stepNamesKey) return
        prevKey.current = stepNamesKey
        setSelected(null)
    }, [stepNamesKey])

    return { selected, select, clear, playback: playback.current, onPlaybackProgress, reset }
}

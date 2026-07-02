import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { saveTrace, zipBundle } from '../lib/ipc'
import { VideoPlayer } from './VideoPlayer'

// Replaces the live browser on the right once a run finishes: the recorded
// replay video plus the artifact downloads (standalone trace.zip for
// trace.playwright.dev, and the full bundle zip). The Passed/Failed verdict
// lives separately under the execution log on the left (ResultPanel).
//
// videoUrl and playback are owned by RunScreen (above this panel) so they
// survive flipping to a step snapshot and back — this panel unmounts while the
// snapshot shows, so local state here would reset the video to 0 and re-fetch
// the blob on every flip.
export function RecordingPanel({
    bundleDir,
    suite,
    videoUrl,
    playback,
    onPlaybackProgress,
}: {
    bundleDir: string
    suite: string
    videoUrl: string | null
    playback: { time: number; playing: boolean }
    onPlaybackProgress: (time: number, playing: boolean) => void
}) {
    const [zipStatus, setZipStatus] = useState<string | null>(null)
    const [zipping, setZipping] = useState(false)
    const [traceStatus, setTraceStatus] = useState<string | null>(null)
    const [savingTrace, setSavingTrace] = useState(false)
    const [expanded, setExpanded] = useState(false)

    // Close the expanded overlay on Escape.
    useEffect(() => {
        if (!expanded) return
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false)
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [expanded])

    const downloadAll = async () => {
        setZipping(true)
        setZipStatus(null)
        try {
            const dest = await zipBundle(bundleDir, suite)
            if (dest) setZipStatus(`Saved → ${dest}`)
        } catch (e) {
            setZipStatus(`Download failed: ${String(e)}`)
        } finally {
            setZipping(false)
        }
    }

    const downloadTrace = async () => {
        setSavingTrace(true)
        setTraceStatus(null)
        try {
            const dest = await saveTrace(bundleDir, suite)
            if (dest) setTraceStatus(`Saved → ${dest}`)
        } catch (e) {
            setTraceStatus(`Download failed: ${String(e)}`)
        } finally {
            setSavingTrace(false)
        }
    }

    // Inline player. While expanded, it's unmounted and the body-portaled overlay
    // (below) shows the player instead; the two hand off playback position via
    // `progress`. Falls back to a loading placeholder until the blob is ready.
    const inlineRecording = videoUrl ? (
        expanded ? null : (
            <VideoPlayer
                src={videoUrl}
                startAt={playback.time}
                startPlaying={playback.playing}
                onProgress={onPlaybackProgress}
                expanded={false}
                onToggleExpand={() => setExpanded(true)}
            />
        )
    ) : (
        <div
            style={{
                aspectRatio: '16 / 10',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--paper-sunken)',
                borderRadius: 8,
                color: 'var(--ink-faint)',
                fontStyle: 'italic',
                fontSize: 13,
            }}
        >
            Loading recording…
        </div>
    )

    return (
        <div>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '11px 16px',
                    borderBottom: '1px solid var(--line)',
                    background: 'var(--paper-sunken)',
                }}
            >
                <span
                    className="mono"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        color: 'var(--teal)',
                        letterSpacing: 1,
                    }}
                >
                    ▶ RECORDING
                </span>
            </div>

            <div style={{ padding: 16 }}>
                {inlineRecording}

                <div style={{ marginTop: 16 }}>
                    <div className="kicker" style={{ marginBottom: 6 }}>
                        Artifacts
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <Button
                            onClick={downloadTrace}
                            loading={savingTrace}
                            variant="filled"
                            radius="md"
                            size="sm"
                            style={{ flex: 1 }}
                        >
                            ↓ trace.zip
                        </Button>
                        <Button
                            onClick={downloadAll}
                            loading={zipping}
                            variant="default"
                            radius="md"
                            size="sm"
                            style={{ flex: 1 }}
                        >
                            ↓ All artifacts
                        </Button>
                    </div>
                    <p className="st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                        <span className="mono">trace.zip</span> replays at{' '}
                        <span className="mono">trace.playwright.dev</span> (network + console + DOM)
                        — use it directly, don't re-zip. “All artifacts” bundles the screenshots,
                        video &amp; report.
                    </p>
                    {traceStatus ? (
                        <p className="mono st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                            {traceStatus}
                        </p>
                    ) : null}
                    {zipStatus ? (
                        <p className="mono st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                            {zipStatus}
                        </p>
                    ) : null}
                </div>
            </div>

            <ExpandedRecordingOverlay
                isVisible={expanded && !!videoUrl}
                videoUrl={videoUrl}
                playback={playback}
                onPlaybackProgress={onPlaybackProgress}
                onClose={() => setExpanded(false)}
            />
        </div>
    )
}

// Full-window recording overlay — portaled to <body> so it escapes any
// transformed ancestor (which would make position:fixed resolve against IT, not
// the viewport, breaking the centering + backdrop). Renders null when hidden.
function ExpandedRecordingOverlay({
    isVisible,
    videoUrl,
    playback,
    onPlaybackProgress,
    onClose,
}: {
    isVisible: boolean
    videoUrl: string | null
    playback: { time: number; playing: boolean }
    onPlaybackProgress: (time: number, playing: boolean) => void
    onClose: () => void
}) {
    if (!isVisible || !videoUrl) return null
    return createPortal(
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(8,10,14,0.82)',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
            }}
        >
            {/* Full-screen backdrop button: clicking (or Enter/Space) anywhere
                outside the player collapses it. Rendered as a sibling behind the
                content so the player's own controls aren't nested inside a button. */}
            <button
                type="button"
                aria-label="Collapse the expanded recording"
                onClick={onClose}
                style={{
                    position: 'absolute',
                    inset: 0,
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    background: 'transparent',
                    cursor: 'default',
                }}
            />
            <div style={{ position: 'relative', width: 'min(95vw, 1600px)' }}>
                <VideoPlayer
                    src={videoUrl}
                    maxHeight="82vh"
                    startAt={playback.time}
                    startPlaying={playback.playing}
                    onProgress={onPlaybackProgress}
                    expanded
                    onToggleExpand={onClose}
                />
            </div>
        </div>,
        document.body
    )
}

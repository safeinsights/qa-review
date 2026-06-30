import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@mantine/core'
import { zipBundle, saveTrace, readVideoObjectUrl } from '../lib/ipc'
import { VideoPlayer } from './VideoPlayer'
import type { ResultEnvelope } from '../lib/stepStream'

// The verdict block: a serif PASSED/FAILED headline with a status dot, an amber
// cleanup callout when needed, the recorded replay video, and the artifact
// downloads — the standalone trace.zip (for trace.playwright.dev) plus a
// download-all bundle zip. Editorial styling.
export function ResultPanel({ result }: { result: ResultEnvelope }) {
    const ok = result.ok
    const category = (result.failureCategory as string | undefined) ?? undefined
    const bundleDir = result.bundleDir as string | undefined
    const cleanup = result.cleanup as { ok: boolean; failed: string[] } | undefined
    const [zipStatus, setZipStatus] = useState<string | null>(null)
    const [zipping, setZipping] = useState(false)
    const [traceStatus, setTraceStatus] = useState<string | null>(null)
    const [savingTrace, setSavingTrace] = useState(false)
    const [videoUrl, setVideoUrl] = useState<string | null>(null)
    const [expanded, setExpanded] = useState(false)
    // Playback position shared between the inline and expanded players so switching
    // between them resumes where the other left off. Only ONE is mounted at a time.
    const progress = useRef({ time: 0, playing: false })
    const onProgress = useCallback((time: number, playing: boolean) => {
        progress.current = { time, playing }
    }, [])

    // Close the expanded overlay on Escape.
    useEffect(() => {
        if (!expanded) return
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false)
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [expanded])

    // Load video.webm through Go (webviews block file://) as a blob: URL, and
    // revoke it on unmount / when the bundle changes to avoid leaking memory.
    useEffect(() => {
        if (!bundleDir) return
        let url: string | null = null
        let alive = true
        readVideoObjectUrl(bundleDir)
            .then((u) => {
                if (alive) {
                    url = u
                    setVideoUrl(u)
                } else {
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

    const downloadAll = async () => {
        if (!bundleDir) return
        setZipping(true)
        setZipStatus(null)
        try {
            const dest = await zipBundle(bundleDir)
            if (dest) setZipStatus(`Saved → ${dest}`)
        } catch (e) {
            setZipStatus('Download failed: ' + String(e))
        } finally {
            setZipping(false)
        }
    }

    const downloadTrace = async () => {
        if (!bundleDir) return
        setSavingTrace(true)
        setTraceStatus(null)
        try {
            const dest = await saveTrace(bundleDir)
            if (dest) setTraceStatus(`Saved → ${dest}`)
        } catch (e) {
            setTraceStatus('Download failed: ' + String(e))
        } finally {
            setSavingTrace(false)
        }
    }

    return (
        <div className="fade-up" style={{ marginTop: 18, paddingTop: 16, borderTop: '2px solid var(--line-strong)' }}>
            <div
                style={{
                    fontFamily: '"Fraunces", serif',
                    fontWeight: 600,
                    fontSize: 28,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    color: ok ? 'var(--green)' : 'var(--red)',
                }}
            >
                <span
                    style={{
                        width: 13,
                        height: 13,
                        borderRadius: '50%',
                        background: ok ? 'var(--green)' : 'var(--red)',
                        flex: 'none',
                    }}
                />
                {ok ? 'Passed' : 'Failed'}
                {!ok && category ? (
                    <span className="mono" style={{ fontSize: 13, color: 'var(--ink-dim)', fontFamily: '"IBM Plex Mono", monospace' }}>
                        · {category}
                    </span>
                ) : null}
            </div>

            {cleanup && !cleanup.ok ? (
                <p
                    style={{
                        marginTop: 12,
                        background: 'var(--amber-bg)',
                        borderLeft: '3px solid var(--amber)',
                        padding: '10px 14px',
                        color: 'var(--amber)',
                        fontSize: 14,
                    }}
                >
                    ⚠ Cleanup failed: <span className="mono">{cleanup.failed.join(', ')}</span> — leftover data may need
                    manual removal.
                </p>
            ) : null}

            {bundleDir ? (
                <div style={{ marginTop: 14 }}>
                    <div className="kicker" style={{ marginBottom: 6 }}>
                        Recording
                    </div>
                    {videoUrl ? (
                        // Inline player. While expanded, it's unmounted and the
                        // body-portaled overlay (below) shows the player instead; the
                        // two hand off playback position via `progress`.
                        expanded ? null : (
                            <VideoPlayer
                                src={videoUrl}
                                startAt={progress.current.time}
                                startPlaying={progress.current.playing}
                                onProgress={onProgress}
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
                    )}
                </div>
            ) : null}

            {bundleDir ? (
                <div style={{ marginTop: 16 }}>
                    <div className="kicker" style={{ marginBottom: 6 }}>
                        Artifacts
                    </div>
                    <Button onClick={downloadTrace} loading={savingTrace} variant="filled" radius="md" size="sm" fullWidth>
                        ↓ Download trace.zip
                    </Button>
                    <p className="st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                        Drag it onto <span className="mono">trace.playwright.dev</span> to replay (network + console +
                        DOM). Use this file directly — don't re-zip it.
                    </p>
                    {traceStatus ? (
                        <p className="mono st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                            {traceStatus}
                        </p>
                    ) : null}
                    <Button
                        onClick={downloadAll}
                        loading={zipping}
                        variant="default"
                        radius="md"
                        size="sm"
                        fullWidth
                        style={{ marginTop: 10 }}
                    >
                        ↓ Download all (.zip) — screenshots · video · trace.zip · report
                    </Button>
                    {zipStatus ? (
                        <p className="mono st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                            {zipStatus}
                        </p>
                    ) : null}
                </div>
            ) : null}

            {/* Expanded recording overlay — portaled to <body> so it escapes the
                .fade-up transform on this panel (a transformed ancestor would make
                position:fixed resolve against IT, not the viewport, breaking the
                centering + backdrop). */}
            {expanded && videoUrl
                ? createPortal(
                      <div
                          onClick={() => setExpanded(false)}
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
                          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(95vw, 1600px)' }}>
                              <VideoPlayer
                                  src={videoUrl}
                                  maxHeight="82vh"
                                  startAt={progress.current.time}
                                  startPlaying={progress.current.playing}
                                  onProgress={onProgress}
                                  expanded
                                  onToggleExpand={() => setExpanded(false)}
                              />
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </div>
    )
}

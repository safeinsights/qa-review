import { useEffect, useState } from 'react'
import { Button } from '@mantine/core'
import { zipBundle, readVideoObjectUrl } from '../lib/ipc'
import type { ResultEnvelope } from '../lib/stepStream'

// The verdict block: a serif PASSED/FAILED headline with a status dot, an amber
// cleanup callout when needed, the recorded replay video, and a download-all
// artifacts (zip incl. trace.zip) action. Editorial styling.
export function ResultPanel({ result }: { result: ResultEnvelope }) {
    const ok = result.ok
    const category = (result.failureCategory as string | undefined) ?? undefined
    const bundleDir = result.bundleDir as string | undefined
    const cleanup = result.cleanup as { ok: boolean; failed: string[] } | undefined
    const [zipStatus, setZipStatus] = useState<string | null>(null)
    const [zipping, setZipping] = useState(false)
    const [videoUrl, setVideoUrl] = useState<string | null>(null)

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
                        <video
                            src={videoUrl}
                            controls
                            style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', background: '#000' }}
                        />
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
                    <Button onClick={downloadAll} loading={zipping} variant="default" radius="md" size="sm" fullWidth>
                        ↓ Download all (.zip) — screenshots · video · trace.zip · report
                    </Button>
                    <p className="st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                        trace.zip replays at{' '}
                        <span className="mono">trace.playwright.dev</span> (network + console + DOM).
                    </p>
                    {zipStatus ? (
                        <p className="mono st-dim" style={{ marginTop: 6, fontSize: 11 }}>
                            {zipStatus}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

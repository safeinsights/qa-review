import { useEffect, useState } from 'react'
import { Button } from '@mantine/core'
import { readScreenshot, saveScreenshotAs } from '../lib/ipc'

// Shows a single per-step screenshot in place of the live browser. Loads the PNG
// bytes through the Go backend (file:// is blocked in the webview) and offers a
// download + a way back to the live view.
export function SnapshotPanel({
    bundleDir,
    rel,
    stepName,
    index,
    total,
    onBackToLive,
}: {
    bundleDir: string
    rel: string
    stepName: string
    index: number
    total: number
    onBackToLive: () => void
}) {
    const [src, setSrc] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [saved, setSaved] = useState<string | null>(null)

    useEffect(() => {
        let alive = true
        setSrc(null)
        setError(null)
        setSaved(null)
        readScreenshot(bundleDir, rel)
            .then((dataUri) => alive && setSrc(dataUri))
            .catch((e) => alive && setError(String(e)))
        return () => {
            alive = false
        }
    }, [bundleDir, rel])

    const download = async () => {
        try {
            const path = await saveScreenshotAs(bundleDir, rel)
            if (path) setSaved(path)
        } catch (e) {
            setSaved('Save failed: ' + String(e))
        }
    }

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
                <span className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--amber)', letterSpacing: 1 }}>
                    ◉ SNAPSHOT
                    <span className="st-dim" style={{ letterSpacing: 0 }}>
                        · step {index + 1}/{total}
                    </span>
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="compact-sm" variant="default" onClick={download} disabled={!src}>
                        ↓ Download
                    </Button>
                    <Button size="compact-sm" color="teal" onClick={onBackToLive}>
                        ← Back to live
                    </Button>
                </div>
            </div>

            <div style={{ background: 'var(--paper-sunken)', minHeight: 200 }}>
                {src ? (
                    <img src={src} alt={stepName} style={{ width: '100%', display: 'block' }} />
                ) : error ? (
                    <div style={{ padding: 24, color: 'var(--red)', fontStyle: 'italic' }}>
                        Could not load snapshot: {error}
                    </div>
                ) : (
                    <div style={{ padding: 24, color: 'var(--ink-faint)', fontStyle: 'italic' }}>Loading snapshot…</div>
                )}
            </div>

            <div style={{ padding: '8px 16px', borderTop: '1px solid var(--line)', fontSize: 13 }}>
                <span className="mono st-dim" style={{ marginRight: 8 }}>
                    {String(index + 1).padStart(2, '0')}
                </span>
                {stepName}
                {saved ? (
                    <span className="mono st-dim" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
                        {saved.startsWith('Save failed') ? saved : `saved → ${saved}`}
                    </span>
                ) : null}
            </div>
        </div>
    )
}

import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import { saveScreenshotAs } from '../lib/ipc'
import type { ConsoleLine } from '../lib/screencast'
import { useScreenshot } from '../lib/useScreenshot'
import { ConsoleLog } from './ConsoleLog'
import { UrlBar } from './UrlBar'

// Shows a single per-step screenshot in place of the live browser. Loads the PNG
// bytes through the Go backend (file:// is blocked in the webview) and offers a
// download + a way back to the live view.
export function SnapshotPanel({
    bundleDir,
    rel,
    stepName,
    stepUrl,
    stepConsole,
    suite,
    index,
    total,
    onBack,
    backLabel,
}: {
    bundleDir: string
    rel: string
    stepName: string
    // The page's URL when this step resolved (undefined for older bundles).
    stepUrl?: string
    // Console output captured DURING this step (undefined for older bundles).
    stepConsole?: ConsoleLine[]
    // Suite name — prefixed onto the saved screenshot's filename.
    suite: string
    index: number
    total: number
    onBack: () => void
    // "← Back to live" during a run, "← Back to recording" once it has finished.
    backLabel: string
}) {
    const { src, error } = useScreenshot(bundleDir, rel)
    const [saved, setSaved] = useState<string | null>(null)

    // Clear any prior save note when the screenshot changes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the shown step changes
    useEffect(() => {
        setSaved(null)
    }, [bundleDir, rel])

    const download = async () => {
        try {
            const path = await saveScreenshotAs(bundleDir, rel, suite)
            if (path) setSaved(path)
        } catch (e) {
            setSaved(`Save failed: ${String(e)}`)
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
                <span
                    className="mono"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        color: 'var(--amber)',
                        letterSpacing: 1,
                    }}
                >
                    ◉ SNAPSHOT
                    <span className="st-dim" style={{ letterSpacing: 0 }}>
                        · step {index + 1}/{total}
                    </span>
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="compact-sm" variant="default" onClick={download} disabled={!src}>
                        ↓ Download
                    </Button>
                    <Button size="compact-sm" color="teal" onClick={onBack}>
                        {backLabel}
                    </Button>
                </div>
            </div>

            {/* The page's URL when this step resolved — sits between the header
                controls and the screenshot. */}
            {stepUrl ? (
                <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
                    <UrlBar url={stepUrl} />
                </div>
            ) : null}

            {/* Fixed-height viewport matching the live browser canvas (1280×720,
                16:9) so toggling live ↔ snapshot never resizes the pane. A
                full-page screenshot is taller than this and scrolls vertically
                inside it rather than being cropped. */}
            <div
                style={{
                    background: 'var(--paper-sunken)',
                    aspectRatio: '1280 / 720',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                }}
            >
                <SnapshotBody src={src} error={error} stepName={stepName} />
            </div>

            {/* The console output captured while this step ran. */}
            <ConsoleLog lines={stepConsole ?? []} emptyText="No console output during this step." />

            <div style={{ padding: '8px 16px', borderTop: '1px solid var(--line)', fontSize: 13 }}>
                <div>
                    <span className="mono st-dim" style={{ marginRight: 8 }}>
                        {String(index + 1).padStart(2, '0')}
                    </span>
                    {stepName}
                </div>
                {saved ? (
                    <span
                        className="mono st-dim"
                        style={{ display: 'block', fontSize: 11, marginTop: 4 }}
                    >
                        {saved.startsWith('Save failed') ? saved : `saved → ${saved}`}
                    </span>
                ) : null}
            </div>
        </div>
    )
}

// The screenshot viewport contents: the loaded image, or an error / loading note.
function SnapshotBody({
    src,
    error,
    stepName,
}: {
    src: string | null
    error: string | null
    stepName: string
}) {
    if (src) {
        return <img src={src} alt={stepName} style={{ width: '100%', display: 'block' }} />
    }
    if (error) {
        return (
            <div style={{ padding: 24, color: 'var(--red)', fontStyle: 'italic' }}>
                Could not load snapshot: {error}
            </div>
        )
    }
    return (
        <div style={{ padding: 24, color: 'var(--ink-faint)', fontStyle: 'italic' }}>
            Loading snapshot…
        </div>
    )
}

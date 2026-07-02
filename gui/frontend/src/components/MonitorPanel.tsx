import type { CSSProperties } from 'react'
import type { ConsoleLine } from '../lib/screencast'
import type { ResultEnvelope } from '../lib/stepStream'
import type { Selected } from '../lib/useSnapshotSelection'
import { BrowserPanel } from './BrowserPanel'
import { ConsoleLog } from './ConsoleLog'
import { RecordingPanel } from './RecordingPanel'
import { SnapshotPanel } from './SnapshotPanel'
import { UrlBar } from './UrlBar'

// The right column of a run. Shows exactly one of three views, highest priority
// first:
//   1. snapshot   — a step with a screenshot is selected
//   2. recording  — the run finished (bundleDir present): the replay video + artifacts
//   3. live       — the run is in progress (or idle): the live browser monitor
export function MonitorPanel({
    result,
    bundleDir,
    running,
    port,
    url,
    consoleLines,
    selected,
    stepCount,
    videoUrl,
    playback,
    currentStepName,
    paused,
    onPlaybackProgress,
    onUrl,
    onConsoleLine,
    onClearSelected,
}: {
    result: ResultEnvelope | null
    bundleDir: string | null
    running: boolean
    port: number | null
    url: string | null
    consoleLines: ConsoleLine[]
    selected: Selected | null
    // Distinct executed-step count — the snapshot's "N of total" denominator.
    stepCount: number
    videoUrl: string | null
    playback: { time: number; playing: boolean }
    // The step shown in the live top bar: the step we're paused before, else the
    // most recent streamed step. Null when there's nothing to show.
    currentStepName: string | null
    // Whether the run is paused before currentStepName (shows a ⏸ marker).
    paused: boolean
    onPlaybackProgress: (time: number, playing: boolean) => void
    onUrl: (url: string) => void
    onConsoleLine: (line: ConsoleLine) => void
    onClearSelected: () => void
}) {
    const suite = (result?.suite as string | undefined) ?? ''
    const shot = selected && bundleDir ? selected.step.screenshot : null
    const showSnapshot = selected && bundleDir && shot
    const showRecording = !showSnapshot && bundleDir

    return (
        <section style={styles.card}>
            {showSnapshot ? (
                <SnapshotPanel
                    bundleDir={bundleDir}
                    rel={shot}
                    stepName={selected.step.name}
                    stepUrl={selected.step.url}
                    stepConsole={selected.step.console}
                    suite={suite}
                    index={selected.index}
                    total={stepCount}
                    onBack={onClearSelected}
                    // After a run finishes we return to the recording, not the
                    // (now-gone) live browser.
                    backLabel={bundleDir ? '← Back to recording' : '← Back to live'}
                />
            ) : showRecording ? (
                <RecordingPanel
                    bundleDir={bundleDir}
                    suite={suite}
                    videoUrl={videoUrl}
                    playback={playback}
                    onPlaybackProgress={onPlaybackProgress}
                />
            ) : (
                <LiveBrowser
                    port={port}
                    url={url}
                    running={running}
                    consoleLines={consoleLines}
                    currentStepName={currentStepName}
                    paused={paused}
                    onUrl={onUrl}
                    onConsoleLine={onConsoleLine}
                />
            )}
        </section>
    )
}

// The live-browser monitor: a URL header, the streamed browser view (once its
// screencast port opens), and the page's accumulating console log.
function LiveBrowser({
    port,
    url,
    running,
    consoleLines,
    currentStepName,
    paused,
    onUrl,
    onConsoleLine,
}: {
    port: number | null
    url: string | null
    running: boolean
    consoleLines: ConsoleLine[]
    currentStepName: string | null
    paused: boolean
    onUrl: (url: string) => void
    onConsoleLine: (line: ConsoleLine) => void
}) {
    return (
        <>
            <div style={styles.liveHeader}>
                {/* Pulsing teal status dot — the "live" indicator. */}
                <span className="live-dot" style={{ flex: 'none' }} title="Live browser" />
                {/* Current live URL: selectable + copyable. */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <UrlBar url={url} />
                </div>
                {currentStepName ? (
                    <span className="mono st-dim" style={styles.stepTitle} title={currentStepName}>
                        {paused ? '⏸ ' : ''}
                        {currentStepName}
                    </span>
                ) : null}
            </div>
            {port ? (
                <BrowserPanel port={port} onUrl={onUrl} onConsole={onConsoleLine} />
            ) : (
                <div style={styles.livePlaceholder}>
                    {running ? 'Waiting for the browser to start…' : 'No live session.'}
                </div>
            )}
            {/* The live page's console, accumulating for the whole run. */}
            {port ? (
                <ConsoleLog live lines={consoleLines} emptyText="No console output yet." />
            ) : null}
        </>
    )
}

const styles: Record<string, CSSProperties> = {
    card: {
        background: 'var(--paper-card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: 'var(--shadow-monitor)',
        alignSelf: 'start',
        position: 'sticky',
        top: 16,
    },
    liveHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 16px',
        borderBottom: '1px solid var(--line)',
    },
    stepTitle: {
        flex: 'none',
        fontSize: 12,
        maxWidth: 200,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    livePlaceholder: {
        aspectRatio: '16 / 10',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--paper-sunken)',
        color: 'var(--ink-faint)',
        fontStyle: 'italic',
    },
}

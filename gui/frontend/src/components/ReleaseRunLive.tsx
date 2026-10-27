import { Progress } from '@mantine/core'
import { useViewportSize } from '@mantine/hooks'
import { useCallback, useEffect, useState } from 'react'
import { type RunProgress, releaseRunProgress } from '../lib/ipc'
import type { ConsoleLine } from '../lib/screencast'
import { ConsoleLog } from './ConsoleLog'
import { LiveBrowser } from './LiveBrowser'
import { baselineView, progressView } from './runProgressView'
import { Terminal } from './Terminal'
import type { BaselineState } from './useBaseline'

const POLL_MS = 2_000

// The session writes progress-<env>.json and results-<env>.jsonl as it goes; Go reads
// them. Polled only while the run session is live.
function useRunProgress(tag: string, env: string, active: boolean): RunProgress | null {
    const [progress, setProgress] = useState<RunProgress | null>(null)
    useEffect(() => {
        if (!active) return
        let gone = false
        const poll = () =>
            releaseRunProgress(tag, env)
                .then(p => !gone && setProgress(p))
                .catch(() => {})
        void poll()
        const timer = setInterval(poll, POLL_MS)
        return () => {
            gone = true
            clearInterval(timer)
        }
    }, [tag, env, active])
    return progress
}

// The page console, kept for the whole session like the Validation screen. A new
// session (a new screencast port) starts an empty log.
function useConsoleLines(port: number | null) {
    const [lines, setLines] = useState<ConsoleLine[]>([])
    // biome-ignore lint/correctness/useExhaustiveDependencies: the port is the reset signal
    useEffect(() => setLines([]), [port])
    const add = useCallback((line: ConsoleLine) => setLines(prev => [...prev, line]), [])
    return { lines, add }
}

// Terminal beside the shared browser, as on the Validation screen, with the run's
// progress above the browser. The browser is interactive: a tester can take over a
// step the session is stuck on.
export function ReleaseRunLive({
    tag,
    env,
    sessionLive,
    screencastPort,
    baseline,
}: {
    tag: string
    env: string
    sessionLive: boolean
    screencastPort: number | null
    baseline: BaselineState
}) {
    const { width } = useViewportSize()
    const gridTemplateColumns = width < 1070 ? '1fr' : 'minmax(560px, 1fr) minmax(360px, 1.1fr)'
    const progress = useRunProgress(tag, env, sessionLive)
    const consoleLines = useConsoleLines(screencastPort)
    return (
        <div style={{ display: 'grid', gridTemplateColumns, gap: 16, marginTop: 12 }}>
            <section style={terminalStyle}>
                <Terminal />
            </section>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
                <BaselinePanel baseline={baseline} isVisible={sessionLive} />
                <RunProgressPanel
                    progress={progress}
                    isVisible={sessionLive && baseline.phase !== 'running'}
                />
                <section style={browserStyle}>
                    <BrowserOrWaiting
                        port={screencastPort}
                        consoleLines={consoleLines.lines}
                        onConsoleLine={consoleLines.add}
                    />
                </section>
            </div>
        </div>
    )
}

function RunProgressPanel({
    progress,
    isVisible,
}: {
    progress: RunProgress | null
    isVisible: boolean
}) {
    if (!isVisible || !progress) return null
    const view = progressView(progress)
    return (
        <section style={panelStyle}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{view.headline}</div>
            <Detail text={view.detail} />
            <Progress value={view.percent} size="md" radius="xl" color="teal" mt={10} />
            <div
                className="mono st-dim"
                style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 6 }}
            >
                <span>{view.countsText}</span>
                <span style={{ marginLeft: 'auto' }}>{view.remainingText}</span>
            </div>
        </section>
    )
}

// While the baseline runs in the browser below, the panel follows it; the run's own
// progress takes over when it ends.
function BaselinePanel({ baseline, isVisible }: { baseline: BaselineState; isVisible: boolean }) {
    if (!isVisible || baseline.phase !== 'running') return null
    const view = baselineView(baseline)
    return (
        <section style={panelStyle}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{view.headline}</div>
            <Detail text={view.detail} />
            <Progress value={view.percent} size="md" radius="xl" color="teal" mt={10} />
        </section>
    )
}

function Detail({ text }: { text: string }) {
    if (!text) return null
    return (
        <div className="st-dim" style={{ fontSize: 12, marginTop: 2 }}>
            {text}
        </div>
    )
}

function BrowserOrWaiting({
    port,
    consoleLines,
    onConsoleLine,
}: {
    port: number | null
    consoleLines: ConsoleLine[]
    onConsoleLine: (line: ConsoleLine) => void
}) {
    if (!port) {
        return <div style={waitingStyle}>The browser shows here when the run session starts.</div>
    }
    return (
        <>
            <LiveBrowser port={port} onConsole={onConsoleLine} />
            <ConsoleLog live lines={consoleLines} emptyText="No console output yet." />
        </>
    )
}

const terminalStyle = {
    background: '#0f1419',
    border: '1px solid var(--line)',
    borderRadius: 10,
    overflow: 'hidden',
    minWidth: 0,
    // Fixed, viewport-capped height so the terminal scrolls inside itself.
    height: 'min(72vh, 720px)',
    padding: 8,
} as const

const browserStyle = {
    background: 'var(--paper-card)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    overflow: 'hidden',
    boxShadow: 'var(--shadow-monitor)',
    minWidth: 0,
} as const

const panelStyle = {
    background: 'var(--paper-card)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    padding: '10px 14px',
} as const

const waitingStyle = {
    aspectRatio: '16 / 10',
    display: 'grid',
    placeItems: 'center',
    color: 'var(--ink-faint)',
    fontStyle: 'italic',
    padding: 16,
    textAlign: 'center',
} as const

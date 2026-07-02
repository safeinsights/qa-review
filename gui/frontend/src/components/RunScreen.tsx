import type { ResultEnvelope } from '../lib/stepStream'
import { useReportIssueMirror } from '../lib/useReportIssueMirror'
import { useRunStream } from '../lib/useRunStream'
import { useSnapshotSelection } from '../lib/useSnapshotSelection'
import { useVideoObjectUrl } from '../lib/useVideoObjectUrl'
import { MonitorPanel } from './MonitorPanel'
import { StepsPanel } from './StepsPanel'

// A run is the bundled engine (`qar <args>`, kind 'engine') or an arbitrary
// process (kind 'process'). All command paths live in Go.
export type RunSpec =
    | { kind: 'engine'; args: string[] }
    | { kind: 'process'; program: string; args: string[] }

export function RunScreen({
    spec,
    stepNames,
    pausedSteps,
    onTogglePause,
    onDone,
    onRunningChange,
    onPausedChange,
}: {
    spec: RunSpec | null
    // Static step names for the selected suite — shown before/independent of a run.
    stepNames: string[]
    pausedSteps: Set<string>
    onTogglePause: (name: string) => void
    onDone?: (r: ResultEnvelope) => void
    onRunningChange?: (running: boolean) => void
    onPausedChange?: (paused: boolean) => void
}) {
    // The viewed snapshot + recording playback (state that sits beside a run).
    const snap = useSnapshotSelection(stepNames)

    // The run state machine: steps/result/running/error/port/url/console/pausedAt,
    // plus the setters the live BrowserPanel feeds back. Reports running/paused
    // transitions + the finished result up, and rewinds the snapshot on each start.
    const run = useRunStream(spec, stepNames, {
        onDone,
        onRunningChange,
        onPausedChange,
        onReset: snap.reset,
    })

    // bundleDir (for artifacts) arrives on the result envelope; the video blob is
    // loaded here, not in RecordingPanel, so it isn't re-fetched on snapshot flips.
    const bundleDir = (run.result?.bundleDir as string | undefined) ?? null
    const videoUrl = useVideoObjectUrl(bundleDir)

    useReportIssueMirror(spec, run)

    // Idle before the first run AND with no suite steps to preview: nothing to show.
    const isIdle = !spec && stepNames.length === 0
    if (isIdle) return <IdlePlaceholder />

    // Distinct executed-step count — the snapshot "N of total" denominator + hints.
    const stepCount = new Set(run.steps.map(s => s.name)).size

    return (
        <div style={layout}>
            <StepsPanel
                stepNames={stepNames}
                steps={run.steps}
                stepCount={stepCount}
                result={run.result}
                error={run.error}
                running={run.running}
                bundleDir={bundleDir}
                pausedSteps={pausedSteps}
                pausedAt={run.pausedAt}
                onTogglePause={onTogglePause}
                selectedIndex={snap.selected?.index ?? null}
                onSelect={snap.select}
            />
            <MonitorPanel
                result={run.result}
                bundleDir={bundleDir}
                running={run.running}
                port={run.port}
                url={run.url}
                consoleLines={run.consoleLines}
                selected={snap.selected}
                stepCount={stepCount}
                videoUrl={videoUrl}
                playback={snap.playback}
                onPlaybackProgress={snap.onPlaybackProgress}
                onUrl={run.setUrl}
                onConsoleLine={run.addConsoleLine}
                onClearSelected={snap.clear}
            />
        </div>
    )
}

function IdlePlaceholder() {
    return (
        <div style={idlePlaceholder}>
            Configure a run above and press{' '}
            <span style={{ color: 'var(--teal)', fontStyle: 'normal' }}>▶ Run</span> to begin.
        </div>
    )
}

const layout = {
    display: 'grid',
    gridTemplateColumns: 'minmax(340px, 400px) 1fr',
    gap: 22,
    marginTop: 22,
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
} as const

const idlePlaceholder = {
    marginTop: 24,
    padding: '40px 24px',
    textAlign: 'center',
    color: 'var(--ink-dim)',
    border: '1px dashed var(--line)',
    borderRadius: 10,
    fontStyle: 'italic',
} as const

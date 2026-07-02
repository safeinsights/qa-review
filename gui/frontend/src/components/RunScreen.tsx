import { useState } from 'react'
import type { ResultEnvelope } from '../lib/stepStream'
import { useReportIssueMirror } from '../lib/useReportIssueMirror'
import { useRunStream } from '../lib/useRunStream'
import { useSnapshotSelection } from '../lib/useSnapshotSelection'
import { useVideoObjectUrl } from '../lib/useVideoObjectUrl'
import { CompanionDrawer } from './CompanionDrawer'
import { MonitorPanel } from './MonitorPanel'
import { StepsPanel } from './StepsPanel'

// A run is the bundled engine (`qar <args>`, kind 'engine') or an arbitrary
// process (kind 'process'). All command paths live in Go.
export type RunSpec =
    | { kind: 'engine'; args: string[] }
    | { kind: 'process'; program: string; args: string[] }

// Pull the suite name out of an engine RunSpec's args (`--suite <name>`), for the
// companion when there's no result envelope yet (mid-run / paused).
function deriveSuiteFromSpec(spec: RunSpec | null): string {
    if (spec?.kind !== 'engine') return ''
    const i = spec.args.indexOf('--suite')
    return i >= 0 ? (spec.args[i + 1] ?? '') : ''
}

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
    // Whether the "Ask Claude" companion drawer is open. Lifted here (from the
    // drawer) so the drawer mounts ONCE at this screen's top level, independent of
    // which right-panel view (live/snapshot/recording) is showing.
    const [companionOpen, setCompanionOpen] = useState(false)

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

    // Emphasize the companion toggle when something needs attention: the browser is
    // live (paused / error-held), an error occurred, or the run finished FAILED
    // ("Ask Claude about this failure").
    const emphasizeClaude =
        run.browserLive ||
        (Boolean(run.error) && !run.running) ||
        Boolean(run.result && !run.result.ok)
    // Step title for the live top bar: the step we're paused before, else the most
    // recent streamed step (the one the engine is on), else null.
    const currentStepName =
        run.pausedAt ?? (run.steps.length > 0 ? run.steps[run.steps.length - 1].name : null)
    // The companion needs a suite name; the result carries it once finished, else
    // derive it from the launch args (mid-run / paused).
    const companionSuite = (run.result?.suite as string | undefined) ?? deriveSuiteFromSpec(spec)

    return (
        <>
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
                    errorHeld={run.errorHeld}
                    onTogglePause={onTogglePause}
                    selectedIndex={snap.selected?.index ?? null}
                    onSelect={snap.select}
                    cdpPort={run.cdpPort}
                    emphasizeClaude={emphasizeClaude}
                    onOpenCompanion={() => setCompanionOpen(true)}
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
                    currentStepName={currentStepName}
                    paused={run.pausedAt !== null}
                    onPlaybackProgress={snap.onPlaybackProgress}
                    onUrl={run.setUrl}
                    onConsoleLine={run.addConsoleLine}
                    onClearSelected={snap.clear}
                />
            </div>
            {/* The companion drawer is mounted ONCE at the run-screen top level — NOT
                inside the live-browser top bar — so it (and any in-progress Claude
                chat) survives the right panel flipping between live / snapshot /
                recording. Its PTY teardown-on-unmount fires only when the run screen
                unmounts or a new run starts. */}
            <CompanionDrawer
                cdpPort={run.cdpPort}
                suite={companionSuite}
                browserLive={run.browserLive}
                open={companionOpen}
                onClose={() => setCompanionOpen(false)}
            />
        </>
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

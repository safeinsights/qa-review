import { useCallback, useEffect, useState } from 'react'
import { jumpToStep, resumeRun } from '../lib/ipc'
import { type ResultEnvelope, stepsByIndex } from '../lib/stepStream'
import { useReportIssueMirror } from '../lib/useReportIssueMirror'
import { useRunStream } from '../lib/useRunStream'
import { useSnapshotSelection } from '../lib/useSnapshotSelection'
import { useVideoObjectUrl } from '../lib/useVideoObjectUrl'
import { COMPANION_HEIGHT, CompanionDrawer } from './CompanionDrawer'
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
    onStepFailedChange,
}: {
    spec: RunSpec | null
    // Static step names for the selected suite — shown before/independent of a run.
    stepNames: string[]
    pausedSteps: Set<string>
    onTogglePause: (name: string) => void
    onDone?: (r: ResultEnvelope) => void
    onRunningChange?: (running: boolean) => void
    onPausedChange?: (paused: boolean) => void
    onStepFailedChange?: (stepFailed: boolean) => void
}) {
    // Whether the "Ask Claude" companion drawer is open. Lifted here (from the
    // drawer) so the drawer mounts ONCE at this screen's top level, independent of
    // which right-panel view (live/snapshot/recording) is showing.
    const [companionOpen, setCompanionOpen] = useState(false)
    // The companion drawer's height in px, owned here so the run content can reserve
    // equal bottom padding while it's open — otherwise the fixed-position drawer
    // covers the bottom of the run content with no way to scroll it into view. The
    // drawer's top drag handle writes this back on resize.
    const [companionHeight, setCompanionHeight] = useState(COMPANION_HEIGHT)

    // The viewed snapshot + recording playback (state that sits beside a run).
    const snap = useSnapshotSelection(stepNames)

    // The run state machine: steps/result/running/error/port/url/console/pausedAt,
    // plus the setters the live BrowserPanel feeds back. Reports running/paused
    // transitions + the finished result up, and rewinds the snapshot on each start.
    const run = useRunStream(spec, stepNames, {
        onDone,
        onRunningChange,
        onPausedChange,
        onStepFailedChange,
        onReset: snap.reset,
    })

    // Removing a step's pause marker while the run is HALTED at that very step must
    // also unblock the engine — a bare pause-set only updates the not-yet-reached
    // set, it doesn't release a run already parked on waitForResume. So resume too.
    const togglePause = useCallback(
        (name: string) => {
            onTogglePause(name)
            if (run.pausedAt === name) void resumeRun()
        },
        [onTogglePause, run.pausedAt]
    )

    // A jump the engine hasn't reached yet. The engine honors a jump at its next step
    // boundary, so when one is requested mid-step the target row shows "queued" until
    // a new step event proves the run moved.
    const [jumpQueuedIndex, setJumpQueuedIndex] = useState<number | null>(null)

    // Double-click a step to relocate the run to it. Jumping FORWARD skips steps whose
    // side effects later steps may depend on (a login, a created study id) — the engine
    // can't know which, so confirm rather than let it fail confusingly downstream.
    const jumpTo = useCallback(
        (index: number) => {
            const executed = stepsByIndex(run.steps).length
            const skipped = index - executed
            if (
                skipped > 0 &&
                !window.confirm(
                    `Jump forward to step ${index + 1}, skipping ${skipped} step${
                        skipped === 1 ? '' : 's'
                    }?\n\n` +
                        'Skipped steps will be marked as such and never run. Later steps ' +
                        'may fail if they depend on work the skipped steps do (logging in, ' +
                        'creating a study).'
                )
            ) {
                return
            }
            setJumpQueuedIndex(index)
            void jumpToStep(index)
        },
        [run.steps]
    )

    // Clear the queued marker once the run actually moves: a new step event means the
    // engine reached a boundary and consumed the jump. stepEventCount is the TRIGGER, not
    // an input — the body deliberately doesn't read it, so biome flags it as extraneous.
    // Removing it (biome's suggested fix) would run this once on mount and strand the marker.
    const stepEventCount = run.steps.length
    // biome-ignore lint/correctness/useExhaustiveDependencies(stepEventCount): trigger, not an input
    useEffect(() => {
        setJumpQueuedIndex(null)
    }, [stepEventCount])

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
        Boolean(run.stepFailed) ||
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
            {/* While the companion is open, reserve bottom space equal to its height so
                the fixed-position drawer no longer hides the bottom of the run content
                — the page scrolls it clear. */}
            <div style={companionOpen ? { paddingBottom: COMPANION_HEIGHT } : undefined}>
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
                        onTogglePause={togglePause}
                        selectedIndex={snap.selected?.index ?? null}
                        onSelect={snap.select}
                        cdpPort={run.cdpPort}
                        emphasizeClaude={emphasizeClaude}
                        onOpenCompanion={() => setCompanionOpen(true)}
                        // Jumping only means something while the engine is still
                        // looping — on a finished run there's nothing to relocate.
                        onJumpTo={run.running || run.browserLive ? jumpTo : undefined}
                        jumpQueuedIndex={jumpQueuedIndex}
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
            </div>
            {/* The companion drawer is mounted ONCE at the run-screen top level — NOT
                inside the live-browser top bar — so it (and any in-progress Claude
                chat) survives the right panel flipping between live / snapshot /
                recording. Its PTY teardown-on-unmount fires only when the run screen
                unmounts or a new run starts. */}
            <CompanionDrawer
                cdpPort={run.cdpPort}
                suite={companionSuite}
                open={companionOpen}
                onClose={() => setCompanionOpen(false)}
                height={companionHeight}
                onHeightChange={setCompanionHeight}
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
    height: 'calc(100vh - 32px)',
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

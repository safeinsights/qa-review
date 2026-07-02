import type { CSSProperties } from 'react'
import type { ResultEnvelope, StepEnvelope } from '../lib/stepStream'
import { ResultPanel } from './ResultPanel'
import { StepChecklist } from './StepChecklist'

// The left column of a run: the ordered step checklist, a contextual hint/banner
// beneath it, any launch error, and — once the run finishes — the pass/fail
// verdict. Purely presentational; all state is owned by RunScreen.
export function StepsPanel({
    stepNames,
    steps,
    stepCount,
    result,
    error,
    running,
    bundleDir,
    pausedSteps,
    pausedAt,
    onTogglePause,
    selectedIndex,
    onSelect,
}: {
    stepNames: string[]
    steps: StepEnvelope[]
    // Distinct executed-step count (used for the snapshot hint + snapshot totals).
    stepCount: number
    result: ResultEnvelope | null
    error: string | null
    running: boolean
    bundleDir: string | null
    pausedSteps: Set<string>
    pausedAt: string | null
    onTogglePause: (name: string) => void
    selectedIndex: number | null
    onSelect: (index: number, step: StepEnvelope) => void
}) {
    return (
        <section style={styles.card}>
            <div className="kicker" style={{ marginBottom: 12 }}>
                Steps
            </div>
            <StepChecklist
                stepNames={stepNames}
                steps={steps}
                pausedSteps={pausedSteps}
                pausedAt={pausedAt}
                onTogglePause={onTogglePause}
                selectedIndex={selectedIndex}
                onSelect={onSelect}
            />

            <Hint
                pausedAt={pausedAt}
                running={running}
                hasResult={!!result}
                hasSteps={stepNames.length > 0}
                bundleDir={bundleDir}
                stepCount={stepCount}
            />

            {running && !result && !pausedAt ? (
                <p className="st-dim" style={{ marginTop: 12, fontStyle: 'italic' }}>
                    Running… the live browser appears on the right.
                </p>
            ) : null}

            {error ? <p style={styles.errorBanner}>⚠ {error}</p> : null}

            {result ? <ResultPanel result={result} /> : null}
        </section>
    )
}

// The single contextual line under the checklist. Exactly one of these shows,
// highest priority first: the paused banner, then a pre-run tip, then a
// post-run snapshot tip.
function Hint({
    pausedAt,
    running,
    hasResult,
    hasSteps,
    bundleDir,
    stepCount,
}: {
    pausedAt: string | null
    running: boolean
    hasResult: boolean
    hasSteps: boolean
    bundleDir: string | null
    stepCount: number
}) {
    if (pausedAt) {
        return (
            <p style={styles.pausedBanner}>
                ⏸ Paused before <strong>{pausedAt}</strong> — interact with the browser on the
                right, then press <span style={{ color: 'var(--teal)' }}>Resume</span>.
            </p>
        )
    }
    if (!running && !hasResult && hasSteps) {
        return (
            <p className="st-dim" style={styles.tip}>
                Tip: click a step to pause before it, then press Run.
            </p>
        )
    }
    if (bundleDir && stepCount > 0) {
        return (
            <p className="st-dim" style={styles.tip}>
                Tip: click a step with 📷 to view its snapshot.
            </p>
        )
    }
    return null
}

const styles: Record<string, CSSProperties> = {
    card: {
        background: 'var(--paper-card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '18px 20px',
        boxShadow: 'var(--shadow-card)',
        alignSelf: 'start',
        position: 'sticky',
        top: 16,
    },
    tip: { marginTop: 10, fontSize: 12, fontStyle: 'italic' },
    pausedBanner: {
        marginTop: 12,
        background: 'var(--amber-soft, #fdf3e0)',
        borderLeft: '3px solid var(--amber, #d08a1a)',
        padding: '10px 14px',
        color: 'var(--ink)',
        fontSize: 14,
    },
    errorBanner: {
        marginTop: 12,
        background: '#fbe9e7',
        borderLeft: '3px solid var(--red)',
        padding: '10px 14px',
        color: 'var(--red)',
        fontSize: 14,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
    },
}

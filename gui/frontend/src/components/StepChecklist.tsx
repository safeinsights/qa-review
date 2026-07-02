import { type StepEnvelope, stepsByIndex } from '../lib/stepStream'

// Render the ordered step list. Rows come from the suite's STATIC step names, so
// the list appears before a run — click a not-yet-run row to toggle a "pause
// before this step" marker (⏸, shown on the right). Once a run starts, each row
// overlays its runtime status (✓/✗/▸) and, if it captured one, a 📷 to view the
// snapshot. Rows are positional (by index), so a suite with repeated step names
// (e.g. study-happy-path's account switches) still renders every step.
export function StepChecklist({
    stepNames,
    steps,
    pausedSteps,
    pausedAt,
    onTogglePause,
    selectedIndex,
    onSelect,
}: {
    // Static, ordered step names (from the selected suite). Source of truth for rows.
    stepNames: string[]
    // Runtime step events streamed during a run, for status/screenshot/error.
    steps: StepEnvelope[]
    // Step names the user marked "pause before".
    pausedSteps: Set<string>
    // The step name the run is currently halted before, if any.
    pausedAt: string | null
    onTogglePause: (name: string) => void
    selectedIndex: number | null
    onSelect: (index: number, step: StepEnvelope) => void
}) {
    // One event per executed position, in order (see stepsByIndex). Positional —
    // NOT keyed by name — so a suite with repeated step names (study-happy-path's
    // account switches) doesn't light up every same-named row when one passes.
    const byIndex = stepsByIndex(steps)

    // Prefer the static list, matching runtime events to rows BY POSITION; before a
    // suite is picked (exploratory mode) fall back to the streamed events directly.
    const rows: { name: string; ev?: StepEnvelope }[] =
        stepNames.length > 0
            ? stepNames.map((name, i) => ({ name, ev: byIndex[i] }))
            : byIndex.map(ev => ({ name: ev.name, ev }))

    if (rows.length === 0) return null

    return (
        <div>
            {rows.map((row, i) => {
                const s = row.ev
                const status = s?.status ?? 'pending'
                const hasShot = !!s?.screenshot
                const selected = selectedIndex === i
                const isPaused = pausedSteps.has(row.name)
                const isHaltedHere = pausedAt === row.name
                // A step can be paused-before only while it hasn't run yet.
                const alreadyRan = status === 'passed' || status === 'failed'
                const canToggle = !alreadyRan
                return (
                    <div
                        // Rows are intentionally positional — a suite may repeat a step
                        // name (e.g. study-happy-path's account switches), so the index is
                        // the only stable identity for a row.
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows, see above
                        key={`${row.name}:${i}`}
                        className="fade-up"
                        style={{
                            display: 'flex',
                            alignItems: 'baseline',
                            gap: 12,
                            padding: '7px 10px',
                            marginLeft: -10,
                            marginRight: -10,
                            borderBottom: i < rows.length - 1 ? '1px dotted var(--line)' : 'none',
                            borderLeft: isHaltedHere
                                ? '3px solid var(--amber, #d08a1a)'
                                : selected
                                  ? '3px solid var(--teal)'
                                  : '3px solid transparent',
                            background: isHaltedHere
                                ? 'var(--amber-soft, #fdf3e0)'
                                : selected
                                  ? 'var(--teal-soft)'
                                  : 'transparent',
                            cursor: canToggle ? 'pointer' : 'default',
                            opacity: !s && status === 'pending' ? 0.75 : 1,
                            transition: 'background 0.12s',
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => {
                                if (canToggle) onTogglePause(row.name)
                            }}
                            title={canToggle ? 'Click to pause before this step' : undefined}
                            style={{
                                // Reset the native button chrome so the row looks
                                // identical to the former clickable <div>.
                                appearance: 'none',
                                border: 'none',
                                background: 'transparent',
                                font: 'inherit',
                                textAlign: 'left',
                                padding: 0,
                                margin: 0,
                                color: 'inherit',
                                flex: 1,
                                minWidth: 0,
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 12,
                                cursor: canToggle ? 'pointer' : 'default',
                            }}
                        >
                            <span
                                className="mono"
                                style={{ color: 'var(--ink-faint)', fontSize: 11 }}
                            >
                                {String(i + 1).padStart(2, '0')}
                            </span>
                            <Mark status={status} />
                            <span
                                style={{
                                    flex: 1,
                                    minWidth: 0,
                                    color: status === 'failed' ? 'var(--red)' : 'var(--ink)',
                                }}
                            >
                                {row.name}
                                {s?.error ? (
                                    <span
                                        className="mono st-fail"
                                        style={{
                                            display: 'block',
                                            fontSize: 12,
                                            marginTop: 2,
                                            // Playwright errors contain long unbroken runs (=== separators,
                                            // URLs) that otherwise overflow the fixed-width steps panel.
                                            whiteSpace: 'pre-wrap',
                                            overflowWrap: 'anywhere',
                                            wordBreak: 'break-word',
                                        }}
                                    >
                                        ↳ {s.error}
                                    </span>
                                ) : null}
                            </span>
                        </button>
                        {/* Right slot: a captured snapshot (click to view) takes
                            precedence once a step has run; otherwise a ⏸ marker. */}
                        {hasShot && s ? (
                            <button
                                type="button"
                                title="View snapshot at this step"
                                onClick={e => {
                                    e.stopPropagation()
                                    onSelect(i, s)
                                }}
                                style={{
                                    appearance: 'none',
                                    border: 'none',
                                    background: 'transparent',
                                    padding: 0,
                                    margin: 0,
                                    fontSize: 13,
                                    cursor: 'pointer',
                                    opacity: selected ? 1 : 0.6,
                                }}
                            >
                                📷
                            </button>
                        ) : isPaused ? (
                            <span
                                title={isHaltedHere ? 'Paused here' : 'Will pause before this step'}
                                style={{ fontSize: 13, color: 'var(--amber, #d08a1a)' }}
                            >
                                ⏸
                            </span>
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}

function Mark({ status }: { status: string }) {
    if (status === 'passed')
        return (
            <span className="st-pass mono" style={{ fontWeight: 600 }}>
                ✓
            </span>
        )
    if (status === 'failed')
        return (
            <span className="st-fail mono" style={{ fontWeight: 600 }}>
                ✗
            </span>
        )
    if (status === 'running')
        return (
            <span className="st-warn mono" style={{ fontWeight: 600 }}>
                ▸
            </span>
        )
    // Not yet reached.
    return (
        <span className="mono" style={{ fontWeight: 600, color: 'var(--ink-faint)' }}>
            ○
        </span>
    )
}

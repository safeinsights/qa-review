import { type StepEnvelope, stepDuration, stepsByIndex } from '../lib/stepStream'

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
    onAskClaude,
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
    // Open the Claude companion drawer — offered inline beneath a failed step so the
    // trigger is right at the failure (the header toggle scrolls off on long suites).
    onAskClaude?: () => void
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
            {rows.map((row, i) => (
                <StepRow
                    // Rows are intentionally positional — a suite may repeat a step name
                    // (e.g. study-happy-path's account switches), so the index is the
                    // only stable identity for a row.
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional rows, see above
                    key={`${row.name}:${i}`}
                    name={row.name}
                    ev={row.ev}
                    index={i}
                    isLast={i === rows.length - 1}
                    selected={selectedIndex === i}
                    isPaused={pausedSteps.has(row.name)}
                    isHaltedHere={pausedAt === row.name}
                    onTogglePause={onTogglePause}
                    onSelect={onSelect}
                    onAskClaude={onAskClaude}
                />
            ))}
        </div>
    )
}

// One step row: the pause-toggle button (number + status mark + name/error), the
// step's duration, the right slot (📷 snapshot / ⏸ pause marker), and — on a failed
// step — the inline "Ask Claude" trigger that wraps onto its own line.
function StepRow({
    name,
    ev,
    index,
    isLast,
    selected,
    isPaused,
    isHaltedHere,
    onTogglePause,
    onSelect,
    onAskClaude,
}: {
    name: string
    ev?: StepEnvelope
    index: number
    isLast: boolean
    selected: boolean
    isPaused: boolean
    isHaltedHere: boolean
    onTogglePause: (name: string) => void
    onSelect: (index: number, step: StepEnvelope) => void
    onAskClaude?: () => void
}) {
    const status = ev?.status ?? 'pending'
    const hasShot = !!ev?.screenshot
    // How long the step took, shown once it has completed (see stepDuration).
    const duration = ev ? stepDuration(ev) : null
    // A step can be paused-before only while it hasn't run yet.
    const canToggle = status !== 'passed' && status !== 'failed'
    return (
        <div
            className="fade-up"
            style={{
                display: 'flex',
                alignItems: 'baseline',
                // Let the inline "Ask Claude" link (on a failed step) wrap onto its
                // own full-width line below the row.
                flexWrap: 'wrap',
                gap: 12,
                padding: '7px 10px',
                marginLeft: -10,
                marginRight: -10,
                borderBottom: !isLast ? '1px dotted var(--line)' : 'none',
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
                opacity: !ev && status === 'pending' ? 0.75 : 1,
                transition: 'background 0.12s',
            }}
        >
            <button
                type="button"
                onClick={() => {
                    if (canToggle) onTogglePause(name)
                }}
                title={canToggle ? 'Click to pause before this step' : undefined}
                style={{
                    // Reset the native button chrome so the row looks identical to the
                    // former clickable <div>.
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
                <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
                    {String(index + 1).padStart(2, '0')}
                </span>
                <Mark status={status} />
                <span
                    style={{
                        flex: 1,
                        minWidth: 0,
                        color: status === 'failed' ? 'var(--red)' : 'var(--ink)',
                    }}
                >
                    {name}
                    {ev?.error ? (
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
                            ↳ {ev.error}
                        </span>
                    ) : null}
                </span>
            </button>
            {/* How long the step took — sits between the step name and the right slot
                (📷/⏸), shown only once the step completed. */}
            {duration ? (
                <span
                    className="mono st-dim"
                    title="Step duration"
                    style={{ flex: 'none', fontSize: 11, opacity: 0.7 }}
                >
                    {duration}
                </span>
            ) : null}
            {/* Right slot: a captured snapshot (click to view) takes precedence once a
                step has run; otherwise a ⏸ marker. */}
            {hasShot && ev ? (
                <button
                    type="button"
                    title="View snapshot at this step"
                    onClick={e => {
                        e.stopPropagation()
                        onSelect(index, ev)
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
            {/* Failure-side companion trigger: sits on its own line under a failed
                step (flexBasis 100% + the row's flexWrap), so the "Ask Claude"
                affordance is right at the failure — not only in the Steps header,
                which scrolls off on a long suite. */}
            {status === 'failed' && onAskClaude ? (
                <button
                    type="button"
                    onClick={e => {
                        e.stopPropagation()
                        onAskClaude()
                    }}
                    style={{
                        flexBasis: '100%',
                        appearance: 'none',
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        margin: 0,
                        textAlign: 'left',
                        fontSize: 12,
                        color: 'var(--teal)',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                    }}
                >
                    💬 Ask Claude about this
                </button>
            ) : null}
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

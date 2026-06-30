import type { StepEnvelope } from '../lib/stepStream'

// Render the ordered execution log. Each step is a clickable row: clicking one
// that has a screenshot shows that snapshot in the panel (the parent handles the
// swap). The selected row is highlighted; a 📷 marks steps with a snapshot.
// Steps coalesce by name (a 'running' entry is replaced when it resolves).
export function StepChecklist({
    steps,
    selectedIndex,
    onSelect,
}: {
    steps: StepEnvelope[]
    selectedIndex: number | null
    onSelect: (index: number, step: StepEnvelope) => void
}) {
    const byName = new Map<string, StepEnvelope>()
    for (const s of steps) byName.set(s.name, s)
    const rows = [...byName.values()]

    if (rows.length === 0) {
        // The log only appears once a run has started; the parent already shows a
        // "Running…" line while steps are pending, so render nothing here. (No more
        // "press Run" — that was misleading once a run was underway.)
        return null
    }

    return (
        <div>
            {rows.map((s, i) => {
                const hasShot = !!s.screenshot
                const selected = selectedIndex === i
                return (
                    <div
                        key={s.name}
                        className="fade-up"
                        onClick={() => hasShot && onSelect(i, s)}
                        title={hasShot ? 'View snapshot at this step' : undefined}
                        style={{
                            display: 'flex',
                            alignItems: 'baseline',
                            gap: 12,
                            padding: '7px 10px',
                            marginLeft: -10,
                            marginRight: -10,
                            borderBottom: i < rows.length - 1 ? '1px dotted var(--line)' : 'none',
                            borderLeft: selected ? '3px solid var(--teal)' : '3px solid transparent',
                            background: selected ? 'var(--teal-soft)' : 'transparent',
                            cursor: hasShot ? 'pointer' : 'default',
                            transition: 'background 0.12s',
                        }}
                    >
                        <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
                            {String(i + 1).padStart(2, '0')}
                        </span>
                        <Mark status={s.status} />
                        <span style={{ flex: 1, color: s.status === 'failed' ? 'var(--red)' : 'var(--ink)' }}>
                            {s.name}
                            {s.error ? (
                                <span className="mono st-fail" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                                    ↳ {s.error}
                                </span>
                            ) : null}
                        </span>
                        {hasShot ? (
                            <span title="snapshot available" style={{ fontSize: 13, opacity: selected ? 1 : 0.5 }}>
                                📷
                            </span>
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}

function Mark({ status }: { status: string }) {
    if (status === 'passed') return <span className="st-pass mono" style={{ fontWeight: 600 }}>✓</span>
    if (status === 'failed') return <span className="st-fail mono" style={{ fontWeight: 600 }}>✗</span>
    return <span className="st-warn mono" style={{ fontWeight: 600 }}>▸</span>
}

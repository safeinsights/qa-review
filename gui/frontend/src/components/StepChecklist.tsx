import type { StepEnvelope } from '../lib/stepStream'

// Render the ordered execution log: a two-digit index, a status mark, the step
// name, and any error. Steps coalesce by name (a 'running' entry is replaced when
// its resolved status arrives). Editorial styling: dotted rules, numbered rows.
export function StepChecklist({ steps }: { steps: StepEnvelope[] }) {
    const byName = new Map<string, StepEnvelope>()
    for (const s of steps) byName.set(s.name, s)
    const rows = [...byName.values()]

    if (rows.length === 0) {
        return (
            <p className="st-dim" style={{ margin: '4px 0', fontStyle: 'italic' }}>
                No steps yet — press Run.
            </p>
        )
    }

    return (
        <div>
            {rows.map((s, i) => (
                <div
                    key={s.name}
                    className="fade-up"
                    style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 12,
                        padding: '7px 0',
                        borderBottom: i < rows.length - 1 ? '1px dotted var(--line)' : 'none',
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
                </div>
            ))}
        </div>
    )
}

function Mark({ status }: { status: string }) {
    if (status === 'passed') return <span className="st-pass mono" style={{ fontWeight: 600 }}>✓</span>
    if (status === 'failed') return <span className="st-fail mono" style={{ fontWeight: 600 }}>✗</span>
    // running
    return <span className="st-warn mono" style={{ fontWeight: 600 }}>▸</span>
}

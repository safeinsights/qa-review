import type { StepEnvelope } from '../lib/stepStream'

const MARK: Record<string, string> = { running: '…', passed: '✓', failed: '✗' }

// Render the ordered list of steps. Steps coalesce by name: a 'running' entry is
// replaced when its resolved status arrives (the engine does this server-side,
// but we also de-dupe by name here for the live view).
export function StepChecklist({ steps }: { steps: StepEnvelope[] }) {
    const byName = new Map<string, StepEnvelope>()
    for (const s of steps) byName.set(s.name, s)
    return (
        <ul>
            {[...byName.values()].map((s, i) => (
                <li key={i} className={s.status}>
                    {MARK[s.status] ?? '•'} {s.name}
                    {s.error ? <em> — {s.error}</em> : null}
                </li>
            ))}
        </ul>
    )
}

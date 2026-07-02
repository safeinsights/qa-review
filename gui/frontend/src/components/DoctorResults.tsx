import { Anchor, Loader, Text } from '@mantine/core'
import type { DoctorCheck } from '../lib/ipc'

// Shared rendering for Setup Doctor results — the loading state, an error, and a
// ✓/✗ row per check (with hint + install link). Used by both the manual "Run
// Setup Doctor" button and the first-launch auto-doctor modal so they stay
// identical. `checks === null` before the first run completes.
export function DoctorResults({
    running,
    error,
    checks,
}: {
    running: boolean
    error: string | null
    checks: DoctorCheck[] | null
}) {
    if (running) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                <Loader size="sm" />
                <Text size="sm">Checking prerequisites…</Text>
            </div>
        )
    }
    if (error) {
        return (
            <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                {error}
            </Text>
        )
    }
    if (!checks) return null

    const failing = checks.filter(c => !c.ok).length
    const allOk = failing === 0
    return (
        <div>
            <Text size="sm" mb={12} fw={600} c={allOk ? 'teal' : 'red'}>
                {allOk
                    ? 'All prerequisites look good.'
                    : `${failing} issue${failing === 1 ? '' : 's'} found.`}
            </Text>
            {checks.map(c => (
                <CheckRow key={c.name} check={c} />
            ))}
        </div>
    )
}

export function doctorFailingCount(checks: DoctorCheck[] | null): number {
    return checks?.filter(c => !c.ok).length ?? 0
}

function CheckRow({ check }: { check: DoctorCheck }) {
    return (
        <div
            style={{
                display: 'flex',
                gap: 10,
                padding: '10px 0',
                borderTop: '1px solid var(--line)',
                alignItems: 'flex-start',
            }}
        >
            <span
                aria-hidden
                style={{
                    fontSize: 16,
                    lineHeight: '20px',
                    color: check.ok ? 'var(--green)' : 'var(--red)',
                    flex: 'none',
                }}
            >
                {check.ok ? '✓' : '✗'}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{check.name}</div>
                {check.detail ? (
                    <div className="mono st-dim" style={{ fontSize: 12, wordBreak: 'break-word' }}>
                        {check.detail}
                    </div>
                ) : null}
                {!check.ok && check.hint ? (
                    <div style={{ fontSize: 12, color: 'var(--amber, #b04a3a)', marginTop: 2 }}>
                        → {check.hint}
                    </div>
                ) : null}
                {!check.ok && check.docURL ? (
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                        ↓{' '}
                        <Anchor href={check.docURL} target="_blank" style={{ fontSize: 12 }}>
                            Download &amp; install instructions
                        </Anchor>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

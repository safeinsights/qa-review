import type { ResultEnvelope } from '../lib/stepStream'

// The verdict block: a serif PASSED/FAILED headline with a status dot, an amber
// cleanup callout when needed, and the recorded replay video. Editorial styling.
export function ResultPanel({ result }: { result: ResultEnvelope }) {
    const ok = result.ok
    const category = (result.failureCategory as string | undefined) ?? undefined
    const bundleDir = result.bundleDir as string | undefined
    const cleanup = result.cleanup as { ok: boolean; failed: string[] } | undefined

    return (
        <div className="fade-up" style={{ marginTop: 18, paddingTop: 16, borderTop: '2px solid var(--line-strong)' }}>
            <div
                style={{
                    fontFamily: '"Fraunces", serif',
                    fontWeight: 600,
                    fontSize: 28,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    color: ok ? 'var(--green)' : 'var(--red)',
                }}
            >
                <span
                    style={{
                        width: 13,
                        height: 13,
                        borderRadius: '50%',
                        background: ok ? 'var(--green)' : 'var(--red)',
                        flex: 'none',
                    }}
                />
                {ok ? 'Passed' : 'Failed'}
                {!ok && category ? (
                    <span className="mono" style={{ fontSize: 13, color: 'var(--ink-dim)', fontFamily: '"IBM Plex Mono", monospace' }}>
                        · {category}
                    </span>
                ) : null}
            </div>

            {cleanup && !cleanup.ok ? (
                <p
                    style={{
                        marginTop: 12,
                        background: 'var(--amber-bg)',
                        borderLeft: '3px solid var(--amber)',
                        padding: '10px 14px',
                        color: 'var(--amber)',
                        fontSize: 14,
                    }}
                >
                    ⚠ Cleanup failed: <span className="mono">{cleanup.failed.join(', ')}</span> — leftover data may need
                    manual removal.
                </p>
            ) : null}

            {bundleDir ? (
                <div style={{ marginTop: 14 }}>
                    <div className="kicker" style={{ marginBottom: 6 }}>
                        Recording
                    </div>
                    <video
                        src={`file://${bundleDir}/video.webm`}
                        controls
                        style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', background: '#000' }}
                    />
                </div>
            ) : null}
        </div>
    )
}

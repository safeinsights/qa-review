import type { ResultEnvelope } from '../lib/stepStream'

// Show the final outcome: banner, the recorded video, and cleanup status. Reads
// fields off the result envelope (same shape as the engine's RunResult).
export function ResultPanel({ result }: { result: ResultEnvelope }) {
    const ok = result.ok
    const category = (result.failureCategory as string | undefined) ?? undefined
    const bundleDir = result.bundleDir as string | undefined
    const cleanup = result.cleanup as { ok: boolean; failed: string[] } | undefined
    return (
        <div className="result">
            <h2 className={ok ? 'passed' : 'failed'}>{ok ? 'PASSED' : `FAILED — ${category ?? 'unknown'}`}</h2>
            {cleanup && !cleanup.ok ? (
                <p className="warn">⚠ Cleanup failed: {cleanup.failed.join(', ')} — leftover data may need manual removal.</p>
            ) : null}
            {bundleDir ? (
                <video src={`file://${bundleDir}/video.webm`} controls style={{ maxWidth: '100%' }} />
            ) : null}
        </div>
    )
}

import { useEffect, useRef, useState } from 'react'
import { runProcess, onStdoutLine, onExit } from '../lib/ipc'
import { StreamParser, type StepEnvelope, type ResultEnvelope } from '../lib/stepStream'
import { StepChecklist } from './StepChecklist'
import { ResultPanel } from './ResultPanel'
import { BrowserPanel } from './BrowserPanel'
import { SnapshotPanel } from './SnapshotPanel'

export interface RunSpec {
    program: string
    args: string[]
    cwd: string
}

interface Selected {
    index: number
    step: StepEnvelope
}

export function RunScreen({ spec, onDone }: { spec: RunSpec | null; onDone?: (r: ResultEnvelope) => void }) {
    const [steps, setSteps] = useState<StepEnvelope[]>([])
    const [result, setResult] = useState<ResultEnvelope | null>(null)
    const [running, setRunning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [port, setPort] = useState<number | null>(null)
    const [selected, setSelected] = useState<Selected | null>(null)
    const parser = useRef(new StreamParser())

    // bundleDir is needed to load/zip artifacts; it arrives on the result envelope.
    const bundleDir = (result?.bundleDir as string | undefined) ?? null

    useEffect(() => {
        if (!spec) return
        setSteps([])
        setResult(null)
        setError(null)
        setPort(null)
        setSelected(null)
        setRunning(true)
        parser.current = new StreamParser()

        let unlistenOut: (() => void) | undefined
        let unlistenExit: (() => void) | undefined

        ;(async () => {
            unlistenOut = await onStdoutLine((line) => {
                for (const env of parser.current.push(line + '\n')) {
                    if (env.type === 'step') setSteps((prev) => [...prev, env])
                    else if (env.type === 'screencast') setPort(env.port)
                    else {
                        setResult(env)
                        onDone?.(env)
                    }
                }
            })
            unlistenExit = await onExit(() => setRunning(false))
            try {
                await runProcess(spec.program, spec.args, spec.cwd)
            } catch (e) {
                setError(`Could not start "${spec.program}": ${String(e)}`)
                setRunning(false)
            }
        })()

        return () => {
            unlistenOut?.()
            unlistenExit?.()
        }
    }, [spec])

    // Idle state before the first run.
    if (!spec) {
        return (
            <div
                style={{
                    marginTop: 24,
                    padding: '40px 24px',
                    textAlign: 'center',
                    color: 'var(--ink-dim)',
                    border: '1px dashed var(--line)',
                    borderRadius: 10,
                    fontStyle: 'italic',
                }}
            >
                Configure a run above and press <span style={{ color: 'var(--teal)', fontStyle: 'normal' }}>▶ Run</span> to
                begin.
            </div>
        )
    }

    // A snapshot can be shown once we know the bundleDir (post-result) and the
    // selected step has a screenshot path.
    const showSnapshot = selected && bundleDir && selected.step.screenshot
    const stepCount = new Set(steps.map((s) => s.name)).size

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 400px) 1fr', gap: 22, marginTop: 22 }}>
            {/* Left: execution log + verdict */}
            <section
                style={{
                    background: 'var(--paper-card)',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: '18px 20px',
                    boxShadow: 'var(--shadow-card)',
                    alignSelf: 'start',
                }}
            >
                <div className="kicker" style={{ marginBottom: 12 }}>
                    Execution log
                </div>
                <StepChecklist
                    steps={steps}
                    selectedIndex={selected?.index ?? null}
                    onSelect={(index, step) => setSelected({ index, step })}
                />
                {bundleDir && stepCount > 0 ? (
                    <p className="st-dim" style={{ marginTop: 10, fontSize: 12, fontStyle: 'italic' }}>
                        Tip: click a step with 📷 to view its snapshot.
                    </p>
                ) : null}
                {running && !result ? (
                    <p className="st-dim" style={{ marginTop: 12, fontStyle: 'italic' }}>
                        Running… the live browser appears on the right.
                    </p>
                ) : null}
                {error ? (
                    <p
                        style={{
                            marginTop: 12,
                            background: '#fbe9e7',
                            borderLeft: '3px solid var(--red)',
                            padding: '10px 14px',
                            color: 'var(--red)',
                            fontSize: 14,
                        }}
                    >
                        ⚠ {error}
                    </p>
                ) : null}
                {result ? <ResultPanel result={result} /> : null}
            </section>

            {/* Right: live browser monitor OR step snapshot */}
            <section
                style={{
                    background: 'var(--paper-card)',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    overflow: 'hidden',
                    boxShadow: 'var(--shadow-monitor)',
                    alignSelf: 'start',
                }}
            >
                {showSnapshot ? (
                    <SnapshotPanel
                        bundleDir={bundleDir}
                        rel={selected!.step.screenshot!}
                        stepName={selected!.step.name}
                        index={selected!.index}
                        total={stepCount}
                        onBackToLive={() => setSelected(null)}
                    />
                ) : (
                    <>
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '11px 16px',
                                borderBottom: '1px solid var(--line)',
                            }}
                        >
                            <span
                                className="mono"
                                style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--teal)', letterSpacing: 1 }}
                            >
                                <span className="live-dot" /> LIVE BROWSER
                            </span>
                            {port ? (
                                <span className="mono st-dim" style={{ fontSize: 12 }}>
                                    127.0.0.1:{port}
                                </span>
                            ) : null}
                        </div>
                        {port ? (
                            <BrowserPanel port={port} />
                        ) : (
                            <div
                                style={{
                                    aspectRatio: '16 / 10',
                                    display: 'grid',
                                    placeItems: 'center',
                                    background: 'var(--paper-sunken)',
                                    color: 'var(--ink-faint)',
                                    fontStyle: 'italic',
                                }}
                            >
                                {running ? 'Waiting for the browser to start…' : 'No live session.'}
                            </div>
                        )}
                    </>
                )}
            </section>
        </div>
    )
}

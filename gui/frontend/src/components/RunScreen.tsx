import { useEffect, useRef, useState } from 'react'
import { runProcess, onStdoutLine, onExit } from '../lib/ipc'
import { StreamParser, type StepEnvelope, type ResultEnvelope } from '../lib/stepStream'
import { StepChecklist } from './StepChecklist'
import { ResultPanel } from './ResultPanel'
import { BrowserPanel } from './BrowserPanel'

export interface RunSpec {
    program: string
    args: string[]
    cwd: string
}

export function RunScreen({ spec, onDone }: { spec: RunSpec | null; onDone?: (r: ResultEnvelope) => void }) {
    const [steps, setSteps] = useState<StepEnvelope[]>([])
    const [result, setResult] = useState<ResultEnvelope | null>(null)
    const [running, setRunning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [port, setPort] = useState<number | null>(null)
    const parser = useRef(new StreamParser())

    useEffect(() => {
        if (!spec) return
        setSteps([])
        setResult(null)
        setError(null)
        setPort(null)
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
                // A failed spawn (e.g. the tool isn't on PATH) used to vanish
                // silently — show it so the run never looks dead for no reason.
                setError(`Could not start "${spec.program}": ${String(e)}`)
                setRunning(false)
            }
        })()

        return () => {
            unlistenOut?.()
            unlistenExit?.()
        }
    }, [spec])

    return (
        <div className="run-screen" style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
                <StepChecklist steps={steps} />
                {running ? <p>Running… (the live browser appears on the right)</p> : null}
                {error ? <p style={{ color: '#c5221f' }}>⚠ {error}</p> : null}
            </div>
            <div style={{ flex: 1 }}>
                {port ? <BrowserPanel port={port} /> : null}
                {result ? <ResultPanel result={result} /> : null}
            </div>
        </div>
    )
}

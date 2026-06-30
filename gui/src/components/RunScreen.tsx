import { useEffect, useRef, useState } from 'react'
import { runProcess, onStdoutLine, onExit } from '../lib/ipc'
import { StreamParser, type StepEnvelope, type ResultEnvelope } from '../lib/stepStream'
import { StepChecklist } from './StepChecklist'
import { ResultPanel } from './ResultPanel'

export interface RunSpec {
    program: string
    args: string[]
    cwd: string
}

export function RunScreen({ spec, onDone }: { spec: RunSpec | null; onDone?: (r: ResultEnvelope) => void }) {
    const [steps, setSteps] = useState<StepEnvelope[]>([])
    const [result, setResult] = useState<ResultEnvelope | null>(null)
    const [running, setRunning] = useState(false)
    const parser = useRef(new StreamParser())

    useEffect(() => {
        if (!spec) return
        setSteps([])
        setResult(null)
        setRunning(true)
        parser.current = new StreamParser()

        let unlistenOut: (() => void) | undefined
        let unlistenExit: (() => void) | undefined

        ;(async () => {
            unlistenOut = await onStdoutLine((line) => {
                for (const env of parser.current.push(line + '\n')) {
                    if (env.type === 'step') setSteps((prev) => [...prev, env])
                    else {
                        setResult(env)
                        onDone?.(env)
                    }
                }
            })
            unlistenExit = await onExit(() => setRunning(false))
            await runProcess(spec.program, spec.args, spec.cwd)
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
                {running ? <p>Running… (a browser window will open)</p> : null}
            </div>
            <div style={{ flex: 1 }}>{result ? <ResultPanel result={result} /> : null}</div>
        </div>
    )
}

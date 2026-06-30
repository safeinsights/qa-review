import { useState } from 'react'
import { RunScreen, type RunSpec } from './RunScreen'
import { SaveAsSuite } from './SaveAsSuite'
import type { ResultEnvelope } from '../lib/stepStream'

const REPO_ROOT = '..'
const ROLES = ['admin', 'researcher', 'reviewer'] as const

export function ExploratoryTab() {
    const [env, setEnv] = useState('qa')
    const [pr, setPr] = useState('')
    const [role, setRole] = useState('admin')
    const [instruction, setInstruction] = useState('')
    const [spec, setSpec] = useState<RunSpec | null>(null)
    const [result, setResult] = useState<ResultEnvelope | null>(null)

    const run = () => {
        setResult(null)
        const args = ['-p', '/qa-explore', '--role', role, '--instruction', instruction]
        if (pr) args.push('--pr', pr)
        else args.push('--env', env)
        setSpec({ program: 'claude', args, cwd: REPO_ROOT })
    }

    return (
        <div>
            <div className="controls">
                <label>Env <select value={env} onChange={(e) => setEnv(e.target.value)} disabled={!!pr}>
                    <option>qa</option><option>staging</option>
                </select></label>
                <label>PR # <input value={pr} onChange={(e) => setPr(e.target.value)} size={6} /></label>
                <label>Role <select value={role} onChange={(e) => setRole(e.target.value)}>
                    {ROLES.map((x) => <option key={x}>{x}</option>)}
                </select></label>
            </div>
            <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Describe what to test, e.g. log in as admin and confirm the dashboard shows pending studies"
                rows={3}
                style={{ width: '100%' }}
            />
            <button onClick={run} disabled={!instruction}>▶ Run</button>
            <RunScreen spec={spec} onDone={setResult} />
            {result?.ok ? <SaveAsSuite cwd={REPO_ROOT} result={result} /> : null}
        </div>
    )
}

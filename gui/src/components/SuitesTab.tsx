import { useState } from 'react'
import { RunScreen, type RunSpec } from './RunScreen'

const REPO_ROOT = '..' // gui/ lives in the repo; the engine runs from repo root

const ENVS = ['qa', 'staging'] as const
const ROLES = ['admin', 'researcher', 'reviewer'] as const

export function SuitesTab() {
    const [env, setEnv] = useState<string>('qa')
    const [pr, setPr] = useState<string>('')
    const [role, setRole] = useState<string>('admin')
    const [suite, setSuite] = useState<string>('signin')
    const [spec, setSpec] = useState<RunSpec | null>(null)

    const run = () => {
        const args = ['qatest', 'run', '--json', '--headed', '--role', role, '--suite', suite]
        if (pr) args.push('--pr', pr)
        else args.push('--env', env)
        setSpec({ program: 'pnpm', args, cwd: REPO_ROOT })
    }

    return (
        <div>
            <div className="controls">
                <label>Env <select value={env} onChange={(e) => setEnv(e.target.value)} disabled={!!pr}>
                    {ENVS.map((x) => <option key={x}>{x}</option>)}
                </select></label>
                <label>PR # <input value={pr} onChange={(e) => setPr(e.target.value)} placeholder="(optional)" size={6} /></label>
                <label>Role <select value={role} onChange={(e) => setRole(e.target.value)}>
                    {ROLES.map((x) => <option key={x}>{x}</option>)}
                </select></label>
                <label>Suite <input value={suite} onChange={(e) => setSuite(e.target.value)} /></label>
                <button onClick={run}>▶ Run</button>
            </div>
            <RunScreen spec={spec} />
        </div>
    )
}

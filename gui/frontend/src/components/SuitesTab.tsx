import { useEffect, useState } from 'react'
import { RunScreen, type RunSpec } from './RunScreen'
import { runProcess, onStdoutLine, onExit } from '../lib/ipc'

const REPO_ROOT = '..' // gui/ lives in the repo; the engine runs from repo root

const ENVS = ['qa', 'staging'] as const
const ROLES = ['admin', 'researcher', 'reviewer'] as const

export function SuitesTab() {
    const [env, setEnv] = useState<string>('qa')
    const [pr, setPr] = useState<string>('')
    const [role, setRole] = useState<string>('admin')
    const [suite, setSuite] = useState<string>('signin')
    const [suites, setSuites] = useState<{ name: string; description: string }[]>([])
    const [spec, setSpec] = useState<RunSpec | null>(null)

    // NOTE: this fetch reuses the global stdout-line/proc-exit events, same as a
    // run. It only runs once on mount before any run is started, so it's safe.
    useEffect(() => {
        let buf = ''
        let offOut: (() => void) | undefined
        let offExit: (() => void) | undefined
        ;(async () => {
            offOut = await onStdoutLine((line) => { buf += line + '\n' })
            offExit = await onExit(() => {
                const last = buf.trim().split('\n').pop() ?? '{}'
                try {
                    const parsed = JSON.parse(last)
                    if (parsed.suites) setSuites(parsed.suites)
                } catch { /* ignore */ }
            })
            await runProcess('pnpm', ['qatest', 'list'], REPO_ROOT)
        })()
        return () => { offOut?.(); offExit?.() }
    }, [])

    const run = () => {
        const args = ['qatest', 'run', '--json', '--screencast', '--role', role, '--suite', suite]
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
                <label>Suite <select value={suite} onChange={(e) => setSuite(e.target.value)}>
                    {suites.length === 0 ? <option>signin</option> : suites.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select></label>
                <button onClick={run}>▶ Run</button>
            </div>
            <RunScreen spec={spec} />
        </div>
    )
}

import { useEffect, useMemo, useState } from 'react'
import { RunScreen, type RunSpec } from './RunScreen'
import { RunControls } from './RunControls'
import { runProcess, onStdoutLine, onExit } from '../lib/ipc'

const REPO_ROOT = '..' // gui/ lives in the repo; the engine runs from repo root

interface SuiteInfo {
    name: string
    description: string
    roles: string[]
}

export function SuitesTab() {
    const [env, setEnv] = useState<string>('qa')
    const [pr, setPr] = useState<string>('')
    const [role, setRole] = useState<string>('admin')
    const [suite, setSuite] = useState<string>('signin')
    const [suites, setSuites] = useState<SuiteInfo[]>([])
    const [spec, setSpec] = useState<RunSpec | null>(null)

    // NOTE: this fetch reuses the global stdout-line/proc-exit events, same as a
    // run. It only runs once on mount before any run is started, so it's safe.
    useEffect(() => {
        let buf = ''
        let offOut: (() => void) | undefined
        let offExit: (() => void) | undefined
        ;(async () => {
            offOut = await onStdoutLine((line) => {
                buf += line + '\n'
            })
            offExit = await onExit(() => {
                const last = buf.trim().split('\n').pop() ?? '{}'
                try {
                    const parsed = JSON.parse(last)
                    if (parsed.suites) setSuites(parsed.suites)
                } catch {
                    /* ignore */
                }
            })
            await runProcess('pnpm', ['qar', 'list'], REPO_ROOT)
        })()
        return () => {
            offOut?.()
            offExit?.()
        }
    }, [])

    // The role is determined BY the suite — a suite declares which role(s) it runs
    // as. Showing a free role dropdown was a footgun (e.g. create-study only works
    // as researcher). Constrain role to the selected suite's allowed roles.
    const selectedSuite = useMemo(() => suites.find((s) => s.name === suite), [suites, suite])
    const allowedRoles = selectedSuite?.roles ?? []

    // Keep `role` valid: when the suite changes, snap role to its first allowed
    // role if the current one isn't permitted.
    useEffect(() => {
        if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
            setRole(allowedRoles[0])
        }
    }, [allowedRoles, role])

    const run = () => {
        const args = ['qar', 'run', '--json', '--screencast', '--role', role, '--suite', suite]
        if (pr) args.push('--pr', pr)
        else args.push('--env', env)
        setSpec({ program: 'pnpm', args, cwd: REPO_ROOT })
    }

    return (
        <div>
            <RunControls
                env={env}
                setEnv={setEnv}
                pr={pr}
                setPr={setPr}
                role={role}
                setRole={setRole}
                allowedRoles={allowedRoles}
                suite={suite}
                setSuite={setSuite}
                suites={suites}
                onRun={run}
            />
            <RunScreen spec={spec} />
        </div>
    )
}

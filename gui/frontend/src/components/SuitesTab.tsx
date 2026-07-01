import { useCallback, useEffect, useMemo, useState } from 'react'
import { RunScreen, type RunSpec } from './RunScreen'
import { RunControls } from './RunControls'
import { runEngine, onStdoutLine, onExit, stopRun, setPauses, resumeRun, isRunning as queryIsRunning } from '../lib/ipc'

interface SuiteInfo {
    name: string
    description: string
    roles: string[]
    steps: string[]
}

export function SuitesTab() {
    const [env, setEnv] = useState<string>('qa')
    const [pr, setPr] = useState<string>('')
    const [role, setRole] = useState<string>('admin')
    const [suite, setSuite] = useState<string>('signin')
    const [suites, setSuites] = useState<SuiteInfo[]>([])
    const [spec, setSpec] = useState<RunSpec | null>(null)
    const [running, setRunning] = useState(false)
    // True from the moment Stop is clicked until the run actually exits — keeps the
    // button from looking dead (and from firing repeat SIGTERMs) during teardown.
    const [stopping, setStopping] = useState(false)
    // Step names the user marked "pause before", and whether the run is currently
    // halted at one of them.
    const [pausedSteps, setPausedSteps] = useState<Set<string>>(new Set())
    const [paused, setPaused] = useState(false)

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
            await runEngine(['list'])
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
    const stepNames = useMemo(() => selectedSuite?.steps ?? [], [selectedSuite])

    // Keep `role` valid: when the suite changes, snap role to its first allowed
    // role if the current one isn't permitted.
    useEffect(() => {
        if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
            setRole(allowedRoles[0])
        }
    }, [allowedRoles, role])

    // A pause set is meaningful only for the current suite's steps — clear it when
    // the suite changes so stale names don't linger.
    useEffect(() => {
        setPausedSteps(new Set())
    }, [suite])

    const run = () => {
        // Client-side guard: never start a second run while one is active (Go also
        // rejects it, but this avoids the round-trip and keeps the button honest).
        if (running) return
        const args = ['run', '--json', '--screencast', '--role', role, '--suite', suite]
        if (pr) args.push('--pr', pr)
        else args.push('--env', env)
        if (pausedSteps.size > 0) args.push('--pause-before', [...pausedSteps].join(','))
        // New object identity each run so RunScreen re-fires even for an identical spec.
        setSpec({ kind: 'engine', args })
    }

    const stop = async () => {
        setStopping(true)
        await stopRun()
    }

    // Once the run has genuinely started, `running` becoming false means it exited
    // (or the stop landed) — clear the transient stopping flag either way.
    useEffect(() => {
        if (!running) setStopping(false)
    }, [running])

    // Sync the button to the AUTHORITATIVE engine state on mount: if a tracked run
    // is already active (e.g. the app/tab reloaded while one was live), reflect it
    // so the control shows Stop — not a Run that would just be rejected.
    useEffect(() => {
        let alive = true
        void queryIsRunning().then((active) => {
            if (alive && active) setRunning(true)
        })
        return () => {
            alive = false
        }
    }, [])

    const resume = async () => {
        // Optimistically flip the button back; the engine's next step:running
        // envelope clears the paused banner in RunScreen.
        setPaused(false)
        await resumeRun()
    }

    // Toggle a "pause before" marker. During a run, push the full updated set to
    // the engine live (for steps not yet reached); before a run it's sent as the
    // --pause-before launch arg.
    const onTogglePause = useCallback(
        (name: string) => {
            setPausedSteps((prev) => {
                const next = new Set(prev)
                if (next.has(name)) next.delete(name)
                else next.add(name)
                if (running) void setPauses([...next])
                return next
            })
        },
        [running],
    )

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
                running={running}
                onStop={stop}
                stopping={stopping}
                paused={paused}
                onResume={resume}
            />
            <RunScreen
                spec={spec}
                stepNames={stepNames}
                pausedSteps={pausedSteps}
                onTogglePause={onTogglePause}
                onRunningChange={setRunning}
                onPausedChange={setPaused}
            />
        </div>
    )
}

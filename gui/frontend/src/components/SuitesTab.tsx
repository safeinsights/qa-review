import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    giveUpStep,
    onExit,
    onStdoutLine,
    openSuiteInEditor,
    isRunning as queryIsRunning,
    resumeRun,
    retryStep,
    runEngine,
    setPauses,
    stopRun,
} from '../lib/ipc'
import { RunControls } from './RunControls'
import { RunScreen, type RunSpec } from './RunScreen'

interface SuiteInfo {
    name: string
    description: string
    roles: string[]
    steps: string[]
}

export function SuitesTab({ refreshKey = 0 }: { refreshKey?: number } = {}) {
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
    // A step failed and the browser is held open for an in-process retry — the
    // controls show Retry step / Give up instead of Resume.
    const [stepFailed, setStepFailed] = useState(false)

    // NOTE: this fetch reuses the global stdout-line/proc-exit events, same as a
    // run — so it must NOT fire while a suite is running (it would hijack those
    // events). It runs on mount, and again when refreshKey bumps (after a sync)
    // provided nothing is running; the guard below enforces that. running/stopping
    // are read as guards, not deps — refreshKey is the only intended trigger.
    // biome-ignore lint/correctness/useExhaustiveDependencies: running/stopping guard, not trigger
    useEffect(() => {
        if (running || stopping) return // a run owns the shared events right now
        let buf = ''
        let offOut: (() => void) | undefined
        let offExit: (() => void) | undefined
        ;(async () => {
            offOut = await onStdoutLine(line => {
                buf += `${line}\n`
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
    }, [refreshKey])

    // The role is determined BY the suite — a suite declares which role(s) it runs
    // as. Showing a free role dropdown was a footgun (e.g. create-study only works
    // as researcher). Constrain role to the selected suite's allowed roles.
    const selectedSuite = useMemo(() => suites.find(s => s.name === suite), [suites, suite])
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: fires on suite change; setPausedSteps is stable
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

    // Open the selected suite's source in the user's editor. Fire-and-forget: the
    // editor launches detached, so there's nothing to await in the UI.
    const editSuite = () => {
        void openSuiteInEditor(suite).catch(_e => {})
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
        void queryIsRunning().then(active => {
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

    // Retry a failed step: the engine reloads the (possibly edited) suite and re-runs
    // the step against the live browser. Flip the flag optimistically; the engine's
    // next step:running envelope clears stepFailed via useRunStream.
    const retry = async () => {
        setStepFailed(false)
        await retryStep()
    }

    // Give up on a failed step: the run tears down and finishes FAILED.
    const giveUp = async () => {
        setStepFailed(false)
        await giveUpStep()
    }

    // Toggle a "pause before" marker. During a run, push the full updated set to
    // the engine live (for steps not yet reached); before a run it's sent as the
    // --pause-before launch arg.
    const onTogglePause = useCallback(
        (name: string) => {
            setPausedSteps(prev => {
                const next = new Set(prev)
                if (next.has(name)) next.delete(name)
                else next.add(name)
                if (running) void setPauses([...next])
                return next
            })
        },
        [running]
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
                onEditSuite={editSuite}
                running={running}
                onStop={stop}
                stopping={stopping}
                paused={paused}
                onResume={resume}
                stepFailed={stepFailed}
                onRetryStep={retry}
                onGiveUp={giveUp}
            />
            <RunScreen
                spec={spec}
                stepNames={stepNames}
                pausedSteps={pausedSteps}
                onTogglePause={onTogglePause}
                onRunningChange={setRunning}
                onPausedChange={setPaused}
                onStepFailedChange={setStepFailed}
            />
        </div>
    )
}

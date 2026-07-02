import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { RunSpec } from '../components/RunScreen'
import { isRunInProgressError, onExit, onStdoutLine, runEngine, runProcess } from './ipc'
import type { ConsoleLine } from './screencast'
import { type ResultEnvelope, type StepEnvelope, StreamParser } from './stepStream'

// The entire state of one run, driven by the engine's NDJSON stream. Grouped into
// a single reducer (rather than a dozen useState calls) so the "start a fresh run"
// and "suite changed" resets are one action instead of a duplicated wall of
// setters, and so related transitions (a step arriving clears the paused banner)
// happen atomically.
export interface RunState {
    // Raw append-only step events (each step streams as 'running' then resolves).
    steps: StepEnvelope[]
    result: ResultEnvelope | null
    running: boolean
    error: string | null
    // Screencast port for the live browser (null until the engine opens it).
    port: number | null
    // Current top-frame URL of the live browser (pushed over the screencast).
    url: string | null
    // Live browser console, accumulated across the whole run.
    consoleLines: ConsoleLine[]
    // The step the run is currently halted before (null when not paused).
    pausedAt: string | null
}

const EMPTY: RunState = {
    steps: [],
    result: null,
    running: false,
    error: null,
    port: null,
    url: null,
    consoleLines: [],
    pausedAt: null,
}

type Action =
    | { type: 'reset' } // suite changed: back to a clean slate, still idle
    | { type: 'start' } // a run is launching: clean slate + running
    | { type: 'step'; env: StepEnvelope }
    | { type: 'port'; port: number }
    | { type: 'paused'; name: string }
    | { type: 'result'; env: ResultEnvelope }
    | { type: 'url'; url: string }
    | { type: 'console'; line: ConsoleLine }
    | { type: 'exit' }
    | { type: 'error'; message: string; running: boolean }

function reducer(state: RunState, action: Action): RunState {
    switch (action.type) {
        case 'reset':
            return EMPTY
        case 'start':
            return { ...EMPTY, running: true }
        case 'step':
            // The first 'running' event after a pause means the run resumed —
            // clearing pausedAt here keeps the banner in sync with the stream.
            return {
                ...state,
                steps: [...state.steps, action.env],
                pausedAt: action.env.status === 'running' ? null : state.pausedAt,
            }
        case 'port':
            return { ...state, port: action.port }
        case 'paused':
            return { ...state, pausedAt: action.name }
        case 'result':
            return { ...state, result: action.env }
        case 'url':
            return { ...state, url: action.url }
        case 'console':
            return { ...state, consoleLines: [...state.consoleLines, action.line] }
        case 'exit':
            // A hard stop while paused must return the UI to idle, not stick on Resume.
            return { ...state, running: false, pausedAt: null }
        case 'error':
            return { ...state, error: action.message, running: action.running }
    }
}

// Side-effects the run stream reports up to the parent (which owns the Run/Stop
// button and the "Report Issue" mirror). Held in a ref so the run effect doesn't
// re-subscribe when a parent passes a fresh callback identity each render.
export interface RunStreamCallbacks {
    onDone?: (r: ResultEnvelope) => void
    onRunningChange?: (running: boolean) => void
    onPausedChange?: (paused: boolean) => void
    // Fires with the fresh state each time a new run starts, so the caller can
    // reset sibling state (e.g. selected snapshot, video playback).
    onReset?: () => void
}

// What useRunStream returns: the live RunState plus the two setters the live
// BrowserPanel feeds back (the top-frame URL and each console line — these come
// from the screencast socket in the child, not the NDJSON stream).
export interface RunStream extends RunState {
    setUrl: (url: string) => void
    addConsoleLine: (line: ConsoleLine) => void
}

// Drives one run: subscribes to the engine's stdout/exit stream, launches `spec`,
// and reduces the NDJSON envelopes into RunState. Resets to a clean slate when the
// suite (`stepNames`) changes. Returns the live RunState + the BrowserPanel setters.
export function useRunStream(
    spec: RunSpec | null,
    stepNames: string[],
    callbacks: RunStreamCallbacks
): RunStream {
    const [state, dispatch] = useReducer(reducer, EMPTY)

    // A stable identity for the suite's step set across renders — the reset key.
    const stepNamesKey = stepNames.join(' ')

    // Keep callbacks current without making them effect dependencies.
    const cbRef = useRef(callbacks)
    cbRef.current = callbacks

    // Report running/paused transitions up, deriving them from state so we never
    // drift from what's rendered (the old code fired these imperatively).
    useEffect(() => {
        cbRef.current.onRunningChange?.(state.running)
    }, [state.running])
    useEffect(() => {
        cbRef.current.onPausedChange?.(state.pausedAt !== null)
    }, [state.pausedAt])

    // Switching suites (which changes stepNames) must clear the prior run's output —
    // otherwise the new suite's step list renders against the old run's steps/result
    // and shows a stale "failed" step. Keyed on stepNames ONLY (not `running`), so a
    // run finishing — which flips running→false but leaves the key unchanged — keeps
    // its result on screen.
    const prevKey = useRef(stepNamesKey)
    useEffect(() => {
        if (prevKey.current === stepNamesKey) return
        prevKey.current = stepNamesKey
        dispatch({ type: 'reset' })
    }, [stepNamesKey])

    useEffect(() => {
        if (!spec) return
        dispatch({ type: 'start' })
        cbRef.current.onReset?.()

        const parser = new StreamParser()
        let unlistenOut: (() => void) | undefined
        let unlistenExit: (() => void) | undefined

        void (async () => {
            unlistenOut = await onStdoutLine(line => {
                for (const env of parser.push(`${line}\n`)) {
                    if (env.type === 'step') dispatch({ type: 'step', env })
                    else if (env.type === 'screencast') dispatch({ type: 'port', port: env.port })
                    else if (env.type === 'paused') dispatch({ type: 'paused', name: env.name })
                    else {
                        dispatch({ type: 'result', env })
                        cbRef.current.onDone?.(env)
                    }
                }
            })
            unlistenExit = await onExit(() => dispatch({ type: 'exit' }))
            try {
                if (spec.kind === 'engine') await runEngine(spec.args)
                else await runProcess(spec.program, spec.args, '')
            } catch (e) {
                // A run was rejected because one is already active: the OTHER run is
                // the real one, so stay "running" (the button is a working Stop) and
                // don't clobber its live output. Any other failure means nothing
                // started — surface it and reset to idle.
                if (isRunInProgressError(e)) {
                    dispatch({
                        type: 'error',
                        message: 'A run is already in progress — stop it before starting another.',
                        running: true,
                    })
                } else {
                    const what = spec.kind === 'engine' ? 'qar' : spec.program
                    dispatch({
                        type: 'error',
                        message: `Could not start "${what}": ${String(e)}`,
                        running: false,
                    })
                }
            }
        })()

        return () => {
            unlistenOut?.()
            unlistenExit?.()
        }
    }, [spec])

    // The live BrowserPanel reports the page's URL + console lines over the
    // screencast socket (not the NDJSON stream), so expose stable setters for them.
    const setUrl = useCallback((url: string) => dispatch({ type: 'url', url }), [])
    const addConsoleLine = useCallback(
        (line: ConsoleLine) => dispatch({ type: 'console', line }),
        []
    )

    return { ...state, setUrl, addConsoleLine }
}

export type { ResultEnvelope, StepEnvelope }

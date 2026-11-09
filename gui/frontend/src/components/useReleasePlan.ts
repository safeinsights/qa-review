import { useCallback, useEffect, useRef, useState } from 'react'
import {
    checkPlanLines,
    discardLocalPlan,
    onPlanChanged,
    onReleaseSaved,
    onSessionEnded,
    type PlanChanged,
    type PlanLinesCheck,
    readPlan,
    sendToPty,
    unwatchPlan,
    watchPlan,
    writePlan,
} from '../lib/ipc'
import { decideReload } from './releaseSync'

const AUTOSAVE_MS = 500
const STATUS_STALE_MS = 1000

// Owns the plan text for one tag: loads it, autosaves it, runs plan-lines after
// every write, and applies the sync rule when the Claude session rewrites the
// file. `conflict` means Claude wrote while the user had unsaved keystrokes; the
// UI offers Reload / Keep mine, and autosave stays off until one is chosen.
export function useReleasePlan(tag: string, active: boolean, onStatusStale: () => void) {
    const [text, setTextState] = useState('')
    const [dirty, setDirty] = useState(false)
    const [uploaded, setUploaded] = useState(false)
    const [exists, setExists] = useState(false)
    const [conflict, setConflictState] = useState(false)
    const [error, setError] = useState('')
    const [lineCheck, setLineCheck] = useState<PlanLinesCheck | null>(null)
    const loadedHash = useRef<string | null>(null)
    const lastWrittenHash = useRef<string | null>(null)
    // Mirror state for the event listener, which is subscribed once and must
    // not re-subscribe on every keystroke.
    const dirtyRef = useRef(false)
    const conflictRef = useRef(false)
    const textRef = useRef('')
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Go renames the file before the IPC reply reaches us; a poll tick in that
    // window carries hashes we do not know yet, so it is held until the reply.
    const inFlight = useRef(false)
    const pendingEvent = useRef<PlanChanged | null>(null)
    const queuedText = useRef<string | null>(null)
    const staleCb = useRef(onStatusStale)
    staleCb.current = onStatusStale

    const markDirty = useCallback((value: boolean) => {
        dirtyRef.current = value
        setDirty(value)
    }, [])

    const setConflict = useCallback((value: boolean) => {
        conflictRef.current = value
        setConflictState(value)
    }, [])

    const clearTimer = useCallback(() => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = null
    }, [])

    const scheduleStale = () => {
        if (staleTimer.current) clearTimeout(staleTimer.current)
        staleTimer.current = setTimeout(() => staleCb.current(), STATUS_STALE_MS)
    }

    const recheck = useCallback(async () => {
        try {
            setLineCheck(await checkPlanLines(tag))
        } catch (e) {
            setLineCheck({ ok: false, summary: String(e) })
        }
    }, [tag])

    const load = useCallback(async () => {
        clearTimer()
        try {
            const p = await readPlan(tag)
            loadedHash.current = p.exists ? p.hash : null
            setExists(p.exists)
            textRef.current = p.text
            setTextState(p.text)
            markDirty(false)
            setConflict(false)
            setError('')
            if (p.exists) void recheck()
        } catch (e) {
            setError(String(e))
        }
    }, [tag, recheck, markDirty, setConflict, clearTimer])

    const decide = useCallback(
        ({ hash }: PlanChanged) => {
            const decision = decideReload({
                incomingHash: hash,
                lastWrittenHash: lastWrittenHash.current,
                loadedHash: loadedHash.current,
                dirty: dirtyRef.current,
            })
            if (decision === 'reload') void load()
            if (decision === 'ask') {
                // The pending autosave would overwrite Claude's version before the
                // user chose, making Reload unable to restore it.
                clearTimer()
                setConflict(true)
            }
        },
        [load, setConflict, clearTimer]
    )

    // One write at a time: plan-lines runs inside the window, so a second autosave
    // would otherwise start while the first is open and steal its pending event.
    const write = async (next: string): Promise<void> => {
        if (inFlight.current) {
            queuedText.current = next
            return
        }
        inFlight.current = true
        let ok = false
        try {
            const hash = await writePlan(tag, next)
            lastWrittenHash.current = hash
            loadedHash.current = hash
            ok = true
            setError('')
            await recheck()
            scheduleStale()
        } catch (e) {
            setError(String(e))
        } finally {
            inFlight.current = false
        }
        const queued = queuedText.current
        queuedText.current = null
        if (!ok) {
            // Still unsaved: stay dirty and retry.
            if (!conflictRef.current) arm(textRef.current)
        } else if (queued !== null) {
            await write(queued)
            return
        } else if (textRef.current === next) {
            markDirty(false)
        } else if (!conflictRef.current) {
            arm(textRef.current)
        }
        const pending = pendingEvent.current
        pendingEvent.current = null
        if (pending) decide(pending)
    }

    const arm = (next: string) => {
        clearTimer()
        timer.current = setTimeout(() => void write(next), AUTOSAVE_MS)
    }

    useEffect(() => {
        if (!active || !tag) return
        void load()
        void watchPlan(tag)
        let unChanged: (() => void) | undefined
        let unSaved: (() => void) | undefined
        let unEnded: (() => void) | undefined
        ;(async () => {
            unChanged = await onPlanChanged(ev => {
                if (ev.tag !== tag) return
                if (inFlight.current) {
                    pendingEvent.current = ev
                    return
                }
                decide(ev)
            })
            unSaved = await onReleaseSaved(({ tag: t }) => {
                if (t !== tag) return
                setUploaded(true)
                staleCb.current()
            })
            // Go's teardownSession stops the plan watcher, so re-arm it.
            unEnded = await onSessionEnded(() => void watchPlan(tag))
        })()
        return () => {
            unChanged?.()
            unSaved?.()
            unEnded?.()
            void unwatchPlan()
        }
    }, [active, tag, load, decide])

    const setText = (next: string) => {
        textRef.current = next
        setTextState(next)
        markDirty(true)
        setUploaded(false)
        if (!conflictRef.current) arm(next)
    }

    const keepMine = async () => {
        setConflict(false)
        await write(textRef.current)
    }

    const save = async () => {
        try {
            await sendToPty('save the plan')
            setError('')
        } catch (e) {
            setError(String(e))
        }
    }

    const discard = async () => {
        try {
            await discardLocalPlan(tag)
            await load()
            staleCb.current()
        } catch (e) {
            setError(String(e))
        }
    }

    return {
        text,
        setText,
        dirty,
        uploaded,
        exists,
        conflict,
        error,
        lineCheck,
        reload: load,
        keepMine,
        save,
        discard,
    }
}

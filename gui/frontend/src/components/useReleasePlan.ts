import { useCallback, useEffect, useRef, useState } from 'react'
import {
    checkPlanLines,
    discardLocalPlan,
    onPlanChanged,
    onReleaseSaved,
    onSessionEnded,
    type PlanLinesCheck,
    readPlan,
    sendToPty,
    unwatchPlan,
    watchPlan,
    writePlan,
} from '../lib/ipc'
import { decideReload } from './releaseSync'

const AUTOSAVE_MS = 500

// Owns the plan text for one tag: loads it, autosaves it, runs plan-lines after
// every write, and applies the sync rule when the Claude session rewrites the
// file. `conflict` means Claude wrote while the user had unsaved keystrokes; the
// UI offers Reload / Keep mine.
export function useReleasePlan(tag: string, active: boolean) {
    const [text, setTextState] = useState('')
    const [dirty, setDirty] = useState(false)
    const [uploaded, setUploaded] = useState(false)
    const [conflict, setConflict] = useState(false)
    const [lineCheck, setLineCheck] = useState<PlanLinesCheck | null>(null)
    const loadedHash = useRef<string | null>(null)
    const lastWrittenHash = useRef<string | null>(null)
    // Mirrors `dirty` for the event listener, which is subscribed once and must
    // not re-subscribe on every keystroke.
    const dirtyRef = useRef(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const markDirty = useCallback((value: boolean) => {
        dirtyRef.current = value
        setDirty(value)
    }, [])

    const recheck = useCallback(async () => {
        try {
            setLineCheck(await checkPlanLines(tag))
        } catch (e) {
            setLineCheck({ ok: false, summary: String(e) })
        }
    }, [tag])

    const load = useCallback(async () => {
        const p = await readPlan(tag)
        loadedHash.current = p.exists ? p.hash : null
        setTextState(p.text)
        markDirty(false)
        setConflict(false)
        if (p.exists) void recheck()
    }, [tag, recheck, markDirty])

    useEffect(() => {
        if (!active || !tag) return
        void load()
        void watchPlan(tag)
        let unChanged: (() => void) | undefined
        let unSaved: (() => void) | undefined
        let unEnded: (() => void) | undefined
        ;(async () => {
            unChanged = await onPlanChanged(({ tag: t, hash }) => {
                if (t !== tag) return
                const decision = decideReload({
                    incomingHash: hash,
                    lastWrittenHash: lastWrittenHash.current,
                    loadedHash: loadedHash.current,
                    dirty: dirtyRef.current,
                })
                if (decision === 'reload') void load()
                if (decision === 'ask') setConflict(true)
            })
            unSaved = await onReleaseSaved(({ tag: t }) => {
                if (t === tag) setUploaded(true)
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
    }, [active, tag, load])

    const write = async (next: string) => {
        lastWrittenHash.current = await writePlan(tag, next)
        loadedHash.current = lastWrittenHash.current
        markDirty(false)
        await recheck()
    }

    const setText = (next: string) => {
        setTextState(next)
        markDirty(true)
        setUploaded(false)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => void write(next), AUTOSAVE_MS)
    }

    const keepMine = async () => {
        setConflict(false)
        await write(text)
    }

    const save = async () => {
        await sendToPty('save the plan')
    }

    const discard = async () => {
        await discardLocalPlan(tag)
        await load()
    }

    return {
        text,
        setText,
        dirty,
        uploaded,
        conflict,
        lineCheck,
        reload: load,
        keepMine,
        save,
        discard,
    }
}

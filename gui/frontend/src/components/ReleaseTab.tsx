import { Alert, Button, Group, Modal } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import {
    discardLocalPlan,
    onSessionEnded,
    onSessionReady,
    type ReleaseStatus,
    releaseStatus,
    type SessionKind,
    startReleasePlanSession,
    startReleaseRunSession,
    stopSession,
    stopSessionIfOwner,
} from '../lib/ipc'
import { ReleasePicker } from './ReleasePicker'
import { ReleasePlan } from './ReleasePlan'
import { ReleaseRun } from './ReleaseRun'
import { SessionUnavailable } from './SessionUnavailable'

type Phase = 'pick' | 'plan' | 'run'
const MY_KINDS: SessionKind[] = ['release-plan', 'release-run']

// Owns the tag, the phase, and the shared-session bookkeeping. On opening a tag it
// asks release-status first: an existing plan is downloaded and shown with no
// session; otherwise a plan session starts at once.
function useReleaseSession() {
    const [live, setLive] = useState<SessionKind | null>(null)
    const [starting, setStarting] = useState(false)
    const [ownedByOther, setOwnedByOther] = useState<SessionKind | null>(null)
    const [tag, setTag] = useState('')
    const token = useRef<string | null>(null)

    useEffect(() => {
        let unReady: (() => void) | undefined
        let unEnded: (() => void) | undefined
        ;(async () => {
            unReady = await onSessionReady(({ kind }) => {
                if (!MY_KINDS.includes(kind)) {
                    setOwnedByOther(kind)
                    setLive(null)
                    setStarting(false)
                    return
                }
                setOwnedByOther(null)
                setLive(kind)
                setStarting(false)
            })
            unEnded = await onSessionEnded(() => {
                setOwnedByOther(null)
                setLive(null)
                setStarting(false)
            })
        })()
        return () => {
            unReady?.()
            unEnded?.()
            if (token.current) void stopSessionIfOwner(token.current)
        }
    }, [])

    const start = async (forTag: string, fn: () => Promise<string>) => {
        setTag(forTag)
        setStarting(true)
        try {
            token.current = await fn()
        } catch (e) {
            setStarting(false)
            throw e
        }
    }
    const stop = async () => {
        await stopSession()
        token.current = null
        setLive(null)
        setTag('')
    }
    const takeOver = async () => {
        await stopSession()
        setOwnedByOther(null)
    }
    return { live, tag, starting, ownedByOther, start, stop, takeOver }
}

export function ReleaseTab() {
    const [tag, setTag] = useState('')
    const [phase, setPhase] = useState<Phase>('pick')
    const [status, setStatus] = useState<ReleaseStatus | null>(null)
    const [error, setError] = useState('')
    const [confirmOpen, setConfirmOpen] = useState(false)
    const session = useReleaseSession()

    const refreshStatus = async (t: string) => {
        const s = await releaseStatus(t)
        setStatus(s)
        return s
    }

    const open = async (t: string) => {
        setError('')
        try {
            // The PTY and browser are one shared slot: another tag's session must go.
            if (session.live && session.tag !== t) await session.stop()
            const s = await refreshStatus(t)
            if (!s.exists) throw new Error(`${t} is not a release of management-app`)
            const hasPlan = s.assets.some(a => a.name === 'regression-plan.md')
            if (hasPlan && !s.local.plan) {
                // Pull the saved plan before the editor mounts, so it never opens
                // on an empty buffer; no session yet.
                await discardLocalPlan(t)
                await refreshStatus(t)
            }
            setTag(t)
            setPhase('plan')
            if (!hasPlan && !s.local.plan) {
                await session.start(t, () => startReleasePlanSession(t, true))
            }
        } catch (e) {
            setError(String(e))
        }
    }

    const regenerate = async () => {
        setConfirmOpen(false)
        setError('')
        try {
            if (session.live) await session.stop()
            await session.start(tag, () => startReleasePlanSession(tag, true))
        } catch (e) {
            setError(String(e))
        }
    }

    const startPlanSession = async () => {
        setError('')
        try {
            if (session.live) await session.stop()
            await session.start(tag, () => startReleasePlanSession(tag, false))
        } catch (e) {
            setError(String(e))
        }
    }

    const stop = async () => {
        try {
            await session.stop()
        } catch (e) {
            setError(String(e))
        }
    }

    const startRun = async (env: string) => {
        setError('')
        try {
            if (session.live) await session.stop()
            await session.start(tag, () => startReleaseRunSession(tag, env))
        } catch (e) {
            setError(String(e))
        }
    }

    const back = async () => {
        try {
            await refreshStatus(tag)
            setPhase('plan')
        } catch (e) {
            setError(String(e))
        }
    }

    const refreshCurrent = () => {
        refreshStatus(tag).catch(e => setError(String(e)))
    }

    if (session.ownedByOther) {
        return <SessionUnavailable ownerKind={session.ownedByOther} onTakeOver={session.takeOver} />
    }

    return (
        <div>
            <Header tag={tag} phase={phase} onPick={() => setPhase('pick')} />
            <PhaseView
                phase={phase}
                tag={tag}
                status={status}
                session={session}
                onPick={open}
                onRegenerate={() => setConfirmOpen(true)}
                onStartSession={startPlanSession}
                onStop={stop}
                onStatusStale={refreshCurrent}
                onRun={() => setPhase('run')}
                onStartRun={startRun}
                onBack={back}
            />
            <ErrorAlert message={error} />
            <RegenerateModal
                opened={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                onConfirm={regenerate}
                tag={tag}
            />
        </div>
    )
}

function Header({ tag, phase, onPick }: { tag: string; phase: Phase; onPick: () => void }) {
    if (phase === 'pick') return null
    return (
        <Group mb="sm" gap="sm">
            <span className="mono st-dim" style={{ fontSize: 12 }}>
                {tag} — {phase === 'plan' ? 'plan' : 'run'}
            </span>
            <Button variant="subtle" size="compact-sm" onClick={onPick}>
                change release
            </Button>
        </Group>
    )
}

function PhaseView({
    phase,
    tag,
    status,
    session,
    onPick,
    onRegenerate,
    onStartSession,
    onStop,
    onStatusStale,
    onRun,
    onStartRun,
    onBack,
}: {
    phase: Phase
    tag: string
    status: ReleaseStatus | null
    session: ReturnType<typeof useReleaseSession>
    onPick: (tag: string) => void
    onRegenerate: () => void
    onStartSession: () => void
    onStop: () => void
    onStatusStale: () => void
    onRun: () => void
    onStartRun: (env: string) => void
    onBack: () => void
}) {
    if (phase === 'pick' || !status) return <ReleasePicker onPick={onPick} />
    if (phase === 'plan') {
        return (
            <ReleasePlan
                tag={tag}
                status={status}
                sessionLive={session.live === 'release-plan' && session.tag === tag}
                runLive={session.live === 'release-run' && session.tag === tag}
                starting={session.starting}
                onRegenerate={onRegenerate}
                onStartSession={onStartSession}
                onStatusStale={onStatusStale}
                onRun={onRun}
                onStop={onStop}
            />
        )
    }
    return (
        <ReleaseRun
            status={status}
            sessionLive={session.live === 'release-run' && session.tag === tag}
            onStart={onStartRun}
            onStop={onStop}
            onStatusStale={onStatusStale}
            onBack={onBack}
        />
    )
}

function ErrorAlert({ message }: { message: string }) {
    if (!message) return null
    return (
        <Alert color="red" mt="md" style={{ whiteSpace: 'pre-wrap' }}>
            {message}
        </Alert>
    )
}

function RegenerateModal({
    opened,
    onClose,
    onConfirm,
    tag,
}: {
    opened: boolean
    onClose: () => void
    onConfirm: () => void
    tag: string
}) {
    return (
        <Modal opened={opened} onClose={onClose} title={`Regenerate the plan for ${tag}?`}>
            <p>The current plan.md is overwritten.</p>
            <Group justify="flex-end" gap="sm">
                <Button variant="subtle" onClick={onClose}>
                    Cancel
                </Button>
                <Button color="red" onClick={onConfirm}>
                    Regenerate
                </Button>
            </Group>
        </Modal>
    )
}

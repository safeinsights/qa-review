import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import { commitsBehind, isInDrift, rekey, resetAndSync, sync } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// A skipped sync is only worth acting on if you know what it cost you. "Sync
// skipped" alone reads as dismissable; the commit count is what makes it urgent,
// because a stale clone fails without ever mentioning staleness. 0 means current
// or undeterminable (offline), so the count is simply omitted.
function skippedBannerText(behind: number): string {
    const base = 'Sync skipped — working copy has uncommitted edits or diverged.'
    if (behind <= 0) return base
    const plural = behind === 1 ? '' : 's'
    return `${base} Your test repo is ${behind} commit${plural} behind — until it syncs, stale suites, skills and the qar shim can fail in ways that never mention staleness.`
}

export function SyncButton({
    extraActions,
    onSynced,
}: {
    extraActions?: React.ReactNode
    onSynced?: () => void
} = {}) {
    const [status, setStatus] = useState('')
    const [syncState, setSyncState] = useState('')
    const [drift, setDrift] = useState(false)
    const [behind, setBehind] = useState(0)

    // Only asked for when a sync was skipped: it costs a `git fetch`, and after a
    // successful pull the answer is always 0.
    const measureBehind = async () => {
        try {
            setBehind(await commitsBehind())
        } catch {
            setBehind(0)
        }
    }

    const syncAction = useAsyncAction(async () => {
        setStatus('Syncing…')
        setDrift(false)
        setBehind(0)
        try {
            const result = await sync()
            setSyncState(result)
            if (result === 'synced') {
                setStatus('Up to date — new suites are ready.')
                onSynced?.() // refresh the suite list — a pull may have added/removed suites
                try {
                    setDrift(await isInDrift())
                } catch {
                    setDrift(false)
                }
            } else if (result === 'skipped-dirty') {
                setStatus('Local edits present — sync skipped.')
                await measureBehind()
            } else if (result === 'skipped-diverged') {
                setStatus('Local branch diverged — sync skipped.')
                await measureBehind()
            } else {
                setStatus(result)
            }
        } catch (e) {
            setSyncState('')
            setStatus(`Sync failed: ${String(e)}`)
        }
    })

    // Sync once on startup. `run` is stable, so this fires exactly once.
    const runSync = syncAction.run
    useEffect(() => {
        void runSync()
    }, [runSync])

    const resetAction = useAsyncAction(async () => {
        if (!window.confirm('Discard uncommitted edits (local commits are kept) and sync?')) return
        setStatus('Resetting & syncing…')
        try {
            const result = await resetAndSync()
            setSyncState(result)
            if (result === 'synced') {
                setStatus('Up to date — new suites are ready.')
                setBehind(0)
                onSynced?.() // refresh the suite list after a reset+sync too
                try {
                    setDrift(await isInDrift())
                } catch {
                    setDrift(false)
                }
            } else {
                setStatus(result)
            }
        } catch (e) {
            setStatus(`Reset failed: ${String(e)}`)
        }
    })

    const rekeyAction = useAsyncAction(async () => {
        setStatus('Rekeying…')
        try {
            await rekey()
            setStatus('Rekeyed.')
            setDrift(await isInDrift())
        } catch (e) {
            setStatus(`Rekey failed: ${String(e)}`)
        }
    })

    const busy = syncAction.busy || resetAction.busy || rekeyAction.busy
    const needsReset = syncState === 'skipped-dirty' || syncState === 'skipped-diverged'

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 12,
                }}
            >
                {status ? (
                    <span className="mono st-dim" style={{ fontSize: 12 }}>
                        {status}
                    </span>
                ) : null}
                <Button
                    onClick={() => void syncAction.run()}
                    loading={busy}
                    variant="outline"
                    color="dark"
                    radius="md"
                    size="sm"
                    leftSection={<span aria-hidden>⟲</span>}
                    styles={{ root: { fontFamily: '"IBM Plex Mono", monospace', fontSize: 12 } }}
                >
                    pull latest tests
                </Button>
                {extraActions}
            </div>
            {needsReset ? (
                <Banner
                    text={skippedBannerText(behind)}
                    actionLabel="Reset to clean & sync"
                    onClick={() => void resetAction.run()}
                    busy={busy}
                />
            ) : null}
            {drift ? (
                <Banner
                    text="Secrets out of sync with the keyring."
                    actionLabel="Rekey"
                    onClick={() => void rekeyAction.run()}
                    busy={busy}
                />
            ) : null}
        </div>
    )
}

function Banner({
    text,
    actionLabel,
    onClick,
    busy,
}: {
    text: string
    actionLabel: string
    onClick: () => void
    busy: boolean
}) {
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 12px',
                background: 'var(--paper-card)',
                border: '1px solid var(--line)',
                borderRadius: 8,
            }}
        >
            <span className="mono st-dim" style={{ fontSize: 12 }}>
                {text}
            </span>
            <Button onClick={onClick} loading={busy} variant="light" color="teal" size="xs">
                {actionLabel}
            </Button>
        </div>
    )
}

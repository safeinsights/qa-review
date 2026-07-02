import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import { isInDrift, rekey, resetAndSync, sync } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

export function SyncButton({ extraActions }: { extraActions?: React.ReactNode } = {}) {
    const [status, setStatus] = useState('')
    const [syncState, setSyncState] = useState('')
    const [drift, setDrift] = useState(false)

    const syncAction = useAsyncAction(async () => {
        setStatus('Syncing…')
        setDrift(false)
        try {
            const result = await sync()
            setSyncState(result)
            if (result === 'synced') {
                setStatus('Up to date — new suites are ready.')
                try {
                    setDrift(await isInDrift())
                } catch {
                    setDrift(false)
                }
            } else if (result === 'skipped-dirty') {
                setStatus('Local edits present — sync skipped.')
            } else if (result === 'skipped-diverged') {
                setStatus('Local branch diverged — sync skipped.')
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
                    text="Sync skipped — working copy has uncommitted edits or diverged."
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

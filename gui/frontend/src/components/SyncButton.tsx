import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import { isInDrift, rekey, resetAndSync, shareWork, sync } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

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

    // Shared by sync and reset: both end in the same place, and the banner state is
    // driven entirely by the status string the engine returns.
    const applySyncResult = async (result: string) => {
        setSyncState(result)
        if (result === 'synced') {
            setStatus('Up to date — new suites are ready.')
            onSynced?.() // refresh the suite list — a pull may have added/removed suites
            try {
                setDrift(await isInDrift())
            } catch {
                setDrift(false)
            }
        } else if (result === 'skipped-dirty' || result === 'skipped-diverged') {
            // The banner below states the problem and offers the choice, so a status
            // line here would just say the same thing twice.
            setStatus('')
        } else if (result.startsWith('failed:')) {
            setStatus('')
        } else {
            setStatus(result)
        }
    }

    const syncAction = useAsyncAction(async () => {
        setStatus('Syncing…')
        setDrift(false)
        try {
            await applySyncResult(await sync())
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
            await applySyncResult(await resetAndSync())
        } catch (e) {
            setStatus(`Reset failed: ${String(e)}`)
        }
    })

    // Commits the working copy to a branch and opens a PR instead of discarding it.
    // `share-work` ends on a freshly-synced main, so the suite list is refreshed and
    // drift re-checked exactly as a successful sync would.
    const shareAction = useAsyncAction(async () => {
        const description = window.prompt(
            'Describe these changes (used as the PR title):',
            'QA: local suite edits'
        )
        if (description === null) return
        setStatus('Opening a pull request…')
        try {
            const result = await shareWork(description)
            setSyncState('synced')
            setStatus(result)
            onSynced?.()
            try {
                setDrift(await isInDrift())
            } catch {
                setDrift(false)
            }
        } catch (e) {
            setStatus(`Could not open a PR: ${String(e)}`)
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

    const busy = syncAction.busy || resetAction.busy || shareAction.busy || rekeyAction.busy
    const syncFailure = syncState.startsWith('failed:')
        ? syncState.slice('failed:'.length).trim()
        : ''

    // Uncommitted edits are a fork in the road, not an error: the work is either
    // worth keeping (open a PR) or it isn't (reset). Offering only reset meant the
    // one destructive option was the sole way out of a stuck sync.
    const skipActions: BannerAction[] = [
        { label: 'Open a PR', onClick: () => void shareAction.run() },
        { label: 'Discard & sync', onClick: () => void resetAction.run() },
    ]
    // A diverged branch has local COMMITS, so there is nothing uncommitted for a PR
    // to capture — reset (which keeps commits) is the only action that applies.
    const divergedActions: BannerAction[] = [
        { label: 'Reset to clean & sync', onClick: () => void resetAction.run() },
    ]

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
            <Banner
                isVisible={syncState === 'skipped-dirty'}
                text="You have local edits — open a PR to keep them, or discard them to sync."
                actions={skipActions}
                busy={busy}
            />
            <Banner
                isVisible={syncState === 'skipped-diverged'}
                text="Sync skipped — local branch has diverged from origin."
                actions={divergedActions}
                busy={busy}
            />
            <Banner
                isVisible={syncFailure !== ''}
                text={`Sync failed — ${syncFailure}`}
                busy={busy}
            />
            <Banner
                isVisible={drift}
                text="Secrets out of sync with the keyring."
                actions={[{ label: 'Rekey', onClick: () => void rekeyAction.run() }]}
                busy={busy}
            />
        </div>
    )
}

interface BannerAction {
    label: string
    onClick: () => void
}

// A banner with no actions is informational only — used when the failure is not
// something a button in this app can fix. The first action is the recommended
// one and is rendered as the filled button.
function Banner({
    isVisible,
    text,
    actions = [],
    busy,
}: {
    isVisible: boolean
    text: string
    actions?: BannerAction[]
    busy: boolean
}) {
    if (!isVisible) return null
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
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {actions.map((action, i) => (
                    <Button
                        key={action.label}
                        onClick={action.onClick}
                        loading={busy}
                        variant={i === 0 ? 'filled' : 'subtle'}
                        color="teal"
                        size="xs"
                    >
                        {action.label}
                    </Button>
                ))}
            </div>
        </div>
    )
}

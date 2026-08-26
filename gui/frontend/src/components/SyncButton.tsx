import { Button } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import { commitsBehind, isInDrift, rekey, resetAndSync, shareWork, sync } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// A skipped sync is only worth acting on if you know what it cost you. The
// problem statement alone reads as dismissable; the commit count is what makes it
// urgent, because a stale clone fails without ever mentioning staleness. 0 means
// current or undeterminable (offline), so the count is simply omitted.
//
// The base sentence is a parameter because the two skipped states say different
// things — dirty can offer a PR, diverged cannot — and flattening them into one
// generic line to carry the count would cost more than the count adds.
function skippedBannerText(base: string, behind: number): string {
    if (behind <= 0) return base
    const plural = behind === 1 ? '' : 's'
    return `${base} Your test repo is ${behind} commit${plural} behind — until it syncs, stale suites, skills and the qar shim can fail in ways that never mention staleness.`
}

// Failing to MEASURE the staleness is itself worth saying out loud: 0 renders
// identically to a healthy clone, so a silent fallback hides the very staleness the
// banner exists to surface. Appended to whatever the sync itself had to say, since
// both concern the same click.
function checkFailedNote(status: string): string {
    if (status === '') return 'Could not check how far behind the clone is.'
    return `${status} (could not check how far behind the clone is)`
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
    // Identifies the newest measurement. Because a measurement is fired rather than
    // awaited (below), one still in flight can answer AFTER a later sync has already
    // settled the count; only the newest attempt may write, and bumping this is how
    // every other path cancels one.
    const measureId = useRef(0)

    const settleBehind = (value: number) => {
        measureId.current += 1
        setBehind(value)
    }

    // Only asked for when a sync was SKIPPED: it costs a `git fetch`, and after a
    // successful pull the answer is 0 by definition.
    //
    // Fired, never awaited. Awaiting it inside the sync handler left the button
    // spinning for the whole network round trip — on a blackholed network, the full
    // 20s ceiling of the fetch, with nothing on screen to explain it. The banner this
    // annotates is already rendered by then, so the count just arrives a moment later.
    const measureBehind = () => {
        measureId.current += 1
        const id = measureId.current
        void (async () => {
            try {
                const count = await commitsBehind()
                if (id === measureId.current) setBehind(count)
            } catch {
                // The Go side never returns an error — it answers 0 for offline, no
                // upstream, or unparseable output — so anything landing here is a
                // binding failure, and the user is better off told the check did not
                // run than shown a reassuring zero.
                if (id !== measureId.current) return
                setBehind(0)
                setStatus(checkFailedNote)
            }
        })()
    }

    // Shared by sync and reset: both end in the same place, and the banner state is
    // driven entirely by the status string the engine returns.
    const applySyncResult = async (result: string) => {
        setSyncState(result)
        if (result === 'synced') {
            setStatus('Up to date — new suites are ready.')
            settleBehind(0) // a successful pull makes the count 0 by definition
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
            measureBehind()
        } else if (result.startsWith('failed:')) {
            setStatus('')
        } else {
            setStatus(result)
        }
    }

    const syncAction = useAsyncAction(async () => {
        setStatus('Syncing…')
        setDrift(false)
        settleBehind(0)
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
    const dirtyText = skippedBannerText(
        'You have local edits — open a PR to keep them, or discard them to sync.',
        behind
    )
    const divergedText = skippedBannerText(
        'Sync skipped — local branch has diverged from origin.',
        behind
    )
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
                text={dirtyText}
                actions={skipActions}
                busy={busy}
            />
            <Banner
                isVisible={syncState === 'skipped-diverged'}
                text={divergedText}
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

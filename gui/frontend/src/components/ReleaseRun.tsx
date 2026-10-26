import { Button, Select, Table } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import {
    onReleaseSaved,
    onSessionEnded,
    openExternal,
    RELEASE_ENVS,
    type ReleaseStatus,
} from '../lib/ipc'
import { Terminal } from './Terminal'
import { baselineLabel, useBaseline } from './useBaseline'

// A finished run uploads its results asset; refresh so History shows it. The
// release-saved event comes first (the session is still live), so both refresh.
function useRefreshOnRelease(onStatusStale: () => void) {
    const cb = useRef(onStatusStale)
    cb.current = onStatusStale
    useEffect(() => {
        const unsubs: (() => void)[] = []
        let gone = false
        const keep = (u: () => void) => (gone ? u() : unsubs.push(u))
        onSessionEnded(() => cb.current()).then(keep)
        onReleaseSaved(() => cb.current()).then(keep)
        return () => {
            gone = true
            for (const u of unsubs) u()
        }
    }, [])
}

// Why Start is off, or '' when it is not. A run uploads its results, so it needs the
// push right; and it runs the saved asset, so local edits would go untested.
function startBlockedReason(status: ReleaseStatus): string {
    if (!status.canUpload)
        return 'gh has no push right on management-app — the results cannot be uploaded'
    if (status.local.planDiffers)
        return 'The local plan has edits that are not saved to the release — save or discard them first'
    return ''
}

function useReleaseRun(
    tag: string,
    status: ReleaseStatus,
    sessionLive: boolean,
    onStart: (env: string) => void,
    onStop: () => void,
    onBaselineRunning: (running: boolean) => void
) {
    const [env, setEnv] = useState<string>('staging')
    const [error, setError] = useState('')
    const baseline = useBaseline(tag, onStart)
    const runningCb = useRef(onBaselineRunning)
    runningCb.current = onBaselineRunning
    useEffect(() => runningCb.current(baseline.isRunning), [baseline.isRunning])
    const blocked = startBlockedReason(status)
    const busy = sessionLive || baseline.isRunning
    const start = async () => {
        setError('')
        try {
            await baseline.start(env)
        } catch (e) {
            setError(String(e))
        }
    }
    const stop = () => (baseline.isRunning ? void baseline.stop() : onStop())
    return {
        env,
        setEnv,
        start,
        stop,
        busy,
        blocked,
        baselineText: baselineLabel(baseline.state),
        baselineRunning: baseline.isRunning,
        error,
        results: status.assets.filter(a => a.name.startsWith('regression-results-')),
    }
}

// Pick the env, run the baseline from Go, then start the run session and watch the
// terminal. History lists the results assets already on the release.
export function ReleaseRun({
    tag,
    status,
    sessionLive,
    onStart,
    onStop,
    onBack,
    onStatusStale,
    onBaselineRunning,
}: {
    tag: string
    status: ReleaseStatus
    sessionLive: boolean
    onStart: (env: string) => void
    onStop: () => void
    onBack: () => void
    onStatusStale: () => void
    onBaselineRunning: (running: boolean) => void
}) {
    useRefreshOnRelease(onStatusStale)
    const run = useReleaseRun(tag, status, sessionLive, onStart, onStop, onBaselineRunning)
    return (
        <div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                <Select
                    label="Env"
                    data={[...RELEASE_ENVS]}
                    value={run.env}
                    onChange={v => v && run.setEnv(v)}
                    allowDeselect={false}
                    w={140}
                    disabled={run.busy}
                    comboboxProps={{ withinPortal: true }}
                />
                <Button
                    onClick={run.start}
                    disabled={run.busy || run.blocked !== ''}
                    color="teal"
                    radius="md"
                >
                    Start run
                </Button>
                <Button
                    onClick={run.stop}
                    disabled={!run.busy}
                    variant="outline"
                    color="red"
                    radius="md"
                >
                    Stop
                </Button>
                <Button
                    onClick={onBack}
                    disabled={run.baselineRunning}
                    variant="subtle"
                    radius="md"
                    style={{ marginLeft: 'auto' }}
                >
                    Back to plan
                </Button>
            </div>
            <Note text={run.blocked} />
            <Note text={run.baselineText} />
            <Note text={run.error} danger />
            <section
                style={{
                    background: '#0f1419',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    overflow: 'hidden',
                    height: 'min(55vh, 640px)',
                    padding: 8,
                    marginTop: 12,
                }}
            >
                <Terminal />
            </section>
            <HistoryTable rows={run.results} />
        </div>
    )
}

function Note({ text, danger = false }: { text: string; danger?: boolean }) {
    if (!text) return null
    return (
        <div
            className="mono st-dim"
            style={{
                fontSize: 12,
                marginTop: 8,
                whiteSpace: 'pre-wrap',
                color: danger ? 'var(--danger, #c0392b)' : undefined,
            }}
        >
            {text}
        </div>
    )
}

function HistoryTable({ rows }: { rows: ReleaseStatus['assets'] }) {
    if (!rows.length) return null
    const body = rows.map(a => (
        <Table.Tr key={a.name}>
            <Table.Td>
                <Button variant="subtle" size="compact-sm" onClick={() => openExternal(a.url)}>
                    {a.name}
                </Button>
            </Table.Td>
            <Table.Td>{a.updatedAt}</Table.Td>
        </Table.Tr>
    ))
    return (
        <Table mt="md" withTableBorder>
            <Table.Thead>
                <Table.Tr>
                    <Table.Th>Results</Table.Th>
                    <Table.Th>Updated</Table.Th>
                </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{body}</Table.Tbody>
        </Table>
    )
}

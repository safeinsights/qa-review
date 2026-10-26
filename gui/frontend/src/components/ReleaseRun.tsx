import { Button, Select, Table } from '@mantine/core'
import { useState } from 'react'
import { openExternal, RELEASE_ENVS, type ReleaseStatus } from '../lib/ipc'
import { Terminal } from './Terminal'

// Pick the env, start the run session, watch the terminal. History lists the
// results assets already on the release.
export function ReleaseRun({
    status,
    sessionLive,
    onStart,
    onStop,
    onBack,
}: {
    status: ReleaseStatus
    sessionLive: boolean
    onStart: (env: string) => void
    onStop: () => void
    onBack: () => void
}) {
    const [env, setEnv] = useState<string>('staging')
    const results = status.assets.filter(a => a.name.startsWith('regression-results-'))
    return (
        <div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                <Select
                    label="Env"
                    data={[...RELEASE_ENVS]}
                    value={env}
                    onChange={v => v && setEnv(v)}
                    allowDeselect={false}
                    w={140}
                    disabled={sessionLive}
                    comboboxProps={{ withinPortal: true }}
                />
                <Button
                    onClick={() => onStart(env)}
                    disabled={sessionLive}
                    color="teal"
                    radius="md"
                >
                    Start run
                </Button>
                <Button
                    onClick={onStop}
                    disabled={!sessionLive}
                    variant="outline"
                    color="red"
                    radius="md"
                >
                    Stop session
                </Button>
                <Button
                    onClick={onBack}
                    variant="subtle"
                    radius="md"
                    style={{ marginLeft: 'auto' }}
                >
                    Back to plan
                </Button>
            </div>
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
            <HistoryTable rows={results} />
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

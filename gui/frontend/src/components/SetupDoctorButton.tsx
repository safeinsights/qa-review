import { useState } from 'react'
import { Button, Modal, Text, Loader, Anchor } from '@mantine/core'
import { runDoctor, type DoctorCheck } from '../lib/ipc'

// "Run Setup Doctor": checks + validates every prerequisite app/state (required
// CLIs and versions, gh auth, Chrome, the cloned repo, the keyring identity) and
// shows a modal with a ✓/✗ beside each, plus any error and a remediation hint.
export function SetupDoctorButton() {
    const [opened, setOpened] = useState(false)
    const [checks, setChecks] = useState<DoctorCheck[] | null>(null)
    const [running, setRunning] = useState(false)
    const [error, setError] = useState('')

    const run = async () => {
        setOpened(true)
        setRunning(true)
        setError('')
        setChecks(null)
        try {
            setChecks(await runDoctor())
        } catch (e) {
            setError(String(e))
        } finally {
            setRunning(false)
        }
    }

    const failing = checks?.filter((c) => !c.ok).length ?? 0
    const allOk = checks !== null && failing === 0

    return (
        <>
            <Button onClick={run} variant="light" color="teal" size="sm">
                Run Setup Doctor
            </Button>

            <Modal opened={opened} onClose={() => setOpened(false)} title="Setup Doctor" centered size="lg">
                {running ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                        <Loader size="sm" />
                        <Text size="sm">Checking prerequisites…</Text>
                    </div>
                ) : error ? (
                    <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                        {error}
                    </Text>
                ) : checks ? (
                    <div>
                        <Text size="sm" mb={12} fw={600} c={allOk ? 'teal' : 'red'}>
                            {allOk ? 'All prerequisites look good.' : `${failing} issue${failing === 1 ? '' : 's'} found.`}
                        </Text>
                        {checks.map((c) => (
                            <CheckRow key={c.name} check={c} />
                        ))}
                        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
                            <Button onClick={run} size="xs" variant="default">
                                Re-run
                            </Button>
                            <Button onClick={() => setOpened(false)} size="xs" variant="default">
                                Close
                            </Button>
                        </div>
                    </div>
                ) : null}
            </Modal>
        </>
    )
}

function CheckRow({ check }: { check: DoctorCheck }) {
    return (
        <div
            style={{
                display: 'flex',
                gap: 10,
                padding: '10px 0',
                borderTop: '1px solid var(--line)',
                alignItems: 'flex-start',
            }}
        >
            <span
                aria-hidden
                style={{ fontSize: 16, lineHeight: '20px', color: check.ok ? 'var(--green)' : 'var(--red)', flex: 'none' }}
            >
                {check.ok ? '✓' : '✗'}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{check.name}</div>
                {check.detail ? (
                    <div className="mono st-dim" style={{ fontSize: 12, wordBreak: 'break-word' }}>
                        {check.detail}
                    </div>
                ) : null}
                {!check.ok && check.hint ? (
                    <div style={{ fontSize: 12, color: 'var(--amber, #b04a3a)', marginTop: 2 }}>→ {check.hint}</div>
                ) : null}
                {!check.ok && check.docURL ? (
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                        ↓{' '}
                        <Anchor href={check.docURL} target="_blank" style={{ fontSize: 12 }}>
                            Download &amp; install instructions
                        </Anchor>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

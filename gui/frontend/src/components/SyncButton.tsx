import { useState } from 'react'
import { Button } from '@mantine/core'
import { gitPull } from '../lib/ipc'

export function SyncButton({ cwd }: { cwd: string }) {
    const [status, setStatus] = useState('')
    const [busy, setBusy] = useState(false)

    const pull = async () => {
        setBusy(true)
        setStatus('Pulling…')
        try {
            await gitPull(cwd)
            setStatus('Up to date — restart to load new suites.')
        } catch (e) {
            setStatus('Pull failed: ' + String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {status ? (
                <span className="mono st-dim" style={{ fontSize: 12 }}>
                    {status}
                </span>
            ) : null}
            <Button
                onClick={pull}
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
        </div>
    )
}

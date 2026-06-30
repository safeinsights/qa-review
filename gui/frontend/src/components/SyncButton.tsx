import { useState } from 'react'
import { gitPull } from '../lib/ipc'

export function SyncButton({ cwd }: { cwd: string }) {
    const [status, setStatus] = useState('')
    const pull = async () => {
        setStatus('Pulling…')
        try {
            await gitPull(cwd)
            setStatus('Up to date — restart to load new suites.')
        } catch (e) {
            setStatus('Pull failed: ' + String(e))
        }
    }
    return (
        <span>
            <button onClick={pull}>⟲ Pull latest tests</button> {status}
        </span>
    )
}

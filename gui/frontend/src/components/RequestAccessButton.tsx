import { useEffect } from 'react'
import { checkKeyringAccess, type KeyringAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'
import { AccessRequestStatus } from './AccessRequestStatus'

// The Settings-tab surface for the same access state the first-launch gate shows.
export function RequestAccessButton() {
    const { run, busy, result } = useAsyncAction<[], KeyringAccess>(() => checkKeyringAccess())

    useEffect(() => {
        void run()
    }, [run])

    return <AccessRequestStatus access={result} checking={busy} onRetry={() => void run()} />
}

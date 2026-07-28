import { Modal, Text } from '@mantine/core'
import { useEffect } from 'react'
import { checkKeyringAccess, type KeyringAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'
import { AccessRequestStatus } from './AccessRequestStatus'

// Hard gate on encryption access: before showing the app, pull the latest keyring
// + secrets and confirm the local identity is a recipient (can decrypt shared
// secrets). Without it, every run fails with "Missing required secret". If the
// user isn't a recipient we walk them through `request-access` and give a Retry
// that re-pulls to detect when a teammate's rekey PR has merged.
export function KeyringAccessGate({ children }: { children: React.ReactNode }) {
    const check = useAsyncAction<[], KeyringAccess>(() => checkKeyringAccess())
    const { run: runCheck, busy: checking, error: checkError, result: access } = check

    useEffect(() => {
        void runCheck()
    }, [runCheck])

    // First check in flight — render nothing (matches SetupGate's ready===null).
    if (access === null && checking) return null

    if (access?.isRecipient) return <>{children}</>

    return (
        <RequestAccessGateModal
            access={access}
            checking={checking}
            checkError={checkError}
            onRetry={() => void runCheck()}
        />
    )
}

function RequestAccessGateModal({
    access,
    checking,
    checkError,
    onRetry,
}: {
    access: KeyringAccess | null
    checking: boolean
    checkError: string | null
    onRetry: () => void
}) {
    return (
        <Modal
            opened
            onClose={() => {}}
            withCloseButton={false}
            closeOnClickOutside={false}
            closeOnEscape={false}
            title="Encryption access required"
            centered
            size="lg"
        >
            <AccessRequestStatus access={access} checking={checking} onRetry={onRetry} />
            {checkError ? (
                <Text size="xs" c="red" mt={10}>
                    {checkError}
                </Text>
            ) : null}
        </Modal>
    )
}

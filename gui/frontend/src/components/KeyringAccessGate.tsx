import { Alert, Button, Group, Loader, Modal, Text, TextInput } from '@mantine/core'
import { useEffect, useState } from 'react'
import { checkKeyringAccess, type KeyringAccess, requestAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

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
    const [name, setName] = useState('')
    const request = useAsyncAction(async () => {
        const out = await requestAccess(name.trim())
        return out || 'Access requested — a teammate will review, rekey, and merge your PR.'
    })

    const submit = () => {
        if (!name.trim()) return
        void request.run()
    }

    const requested = request.result !== null
    const note = access?.note

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
            <Text size="sm" mb={12}>
                The runner decrypts shared account passwords and MFA codes with your personal key.
                Your key{' '}
                {access?.hasIdentity ? "isn't in the team keyring yet" : "hasn't been created yet"},
                so requesting access will {access?.hasIdentity ? '' : 'generate your key and '}open
                a pull request for a teammate to approve.
            </Text>

            {note ? (
                <Text size="xs" mb={8} className="mono st-dim">
                    {note}
                </Text>
            ) : null}

            {!requested ? (
                <>
                    <Group align="flex-end">
                        <TextInput
                            label="Your name"
                            placeholder="Ada Lovelace"
                            value={name}
                            onChange={e => setName(e.currentTarget.value)}
                            style={{ flex: 1 }}
                        />
                        <Button onClick={submit} loading={request.busy} color="teal">
                            Request access
                        </Button>
                    </Group>
                    {request.error ? (
                        <Alert color="red" mt="sm">
                            {request.error}
                        </Alert>
                    ) : null}
                </>
            ) : (
                <>
                    <Alert color="teal" mb="sm">
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                            {request.result}
                        </Text>
                    </Alert>
                    <Text size="sm" mb={8}>
                        Once a teammate has merged your access PR, retry to pull the updated keyring
                        and continue.
                    </Text>
                </>
            )}

            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Button
                    onClick={onRetry}
                    loading={checking}
                    variant={requested ? 'filled' : 'default'}
                    color="teal"
                >
                    {checking ? 'Checking…' : 'Retry — I have access'}
                </Button>
                {checking ? <Loader size="xs" /> : null}
                {checkError ? (
                    <Text size="xs" c="red" style={{ flex: 1 }}>
                        {checkError}
                    </Text>
                ) : null}
            </div>
        </Modal>
    )
}

import { Button, Group, Text, TextInput } from '@mantine/core'
import { useState } from 'react'
import { requestAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

export function RequestAccessButton() {
    const [name, setName] = useState('')
    const { run, busy, error, result } = useAsyncAction(async () => {
        const out = await requestAccess(name.trim())
        return out || 'Access requested — a teammate will approve & rekey.'
    })

    const submit = () => {
        if (!name.trim()) return
        void run()
    }

    const msg = error ? `Request failed: ${error}` : result

    return (
        <div>
            <Text size="sm" mb={6}>
                You don’t have an identity yet. Request access to decrypt shared secrets.
            </Text>
            <Group>
                <TextInput
                    placeholder="Your name"
                    value={name}
                    onChange={e => setName(e.currentTarget.value)}
                />
                <Button onClick={submit} loading={busy} color="teal">
                    Request access
                </Button>
            </Group>
            {msg ? (
                <Text size="xs" mt={6} className="mono st-dim">
                    {msg}
                </Text>
            ) : null}
        </div>
    )
}

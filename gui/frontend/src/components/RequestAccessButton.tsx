import { useState } from 'react'
import { Button, TextInput, Group, Text } from '@mantine/core'
import { requestAccess } from '../lib/ipc'

export function RequestAccessButton() {
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState('')

    const submit = async () => {
        if (!name.trim()) return
        setBusy(true)
        setMsg('')
        try {
            const out = await requestAccess(name.trim())
            setMsg(out || 'Access requested — a teammate will approve & rekey.')
        } catch (e) {
            setMsg('Request failed: ' + String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div>
            <Text size="sm" mb={6}>
                You don’t have an identity yet. Request access to decrypt shared secrets.
            </Text>
            <Group>
                <TextInput
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.currentTarget.value)}
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

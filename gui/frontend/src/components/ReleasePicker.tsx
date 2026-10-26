import { Alert, Button, Select, TextInput } from '@mantine/core'
import { useEffect, useState } from 'react'
import { listReleases } from '../lib/ipc'

// Pick a release: the newest tags from gh, or a typed tag.
export function ReleasePicker({ onPick }: { onPick: (tag: string) => void }) {
    const [tags, setTags] = useState<string[]>([])
    const [typed, setTyped] = useState('')
    const [error, setError] = useState('')

    useEffect(() => {
        listReleases()
            .then(setTags)
            .catch(e => setError(String(e)))
    }, [])

    const tag = typed.trim()
    return (
        <div
            style={{
                background: 'var(--paper-card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '16px 18px',
            }}
        >
            <div className="kicker" style={{ marginBottom: 8 }}>
                Regression plan for a management-app release
            </div>
            <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Select
                    label="Release"
                    data={tags}
                    value={tags.includes(tag) ? tag : null}
                    onChange={v => v && setTyped(v)}
                    placeholder="newest first"
                    searchable
                    w={220}
                    comboboxProps={{ withinPortal: true }}
                />
                <TextInput
                    label="or type a tag"
                    value={typed}
                    onChange={e => setTyped(e.currentTarget.value)}
                    placeholder="v1.6.9"
                    w={160}
                />
                <Button onClick={() => onPick(tag)} disabled={!tag} color="teal" radius="md">
                    Open
                </Button>
            </div>
            {error ? (
                <Alert color="red" mt="md" style={{ whiteSpace: 'pre-wrap' }}>
                    {error}
                </Alert>
            ) : null}
        </div>
    )
}

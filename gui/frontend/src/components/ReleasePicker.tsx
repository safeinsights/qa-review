import { Alert, Button, Select } from '@mantine/core'
import { useEffect, useState } from 'react'
import { listReleases } from '../lib/ipc'

// Pick a release from the ones gh lists. There is no typed-tag input: a tag with no
// GitHub release has nowhere to hold the plan and results assets.
export function ReleasePicker({ onPick }: { onPick: (tag: string) => void }) {
    const [tags, setTags] = useState<string[]>([])
    const [tag, setTag] = useState('')
    const [error, setError] = useState('')

    useEffect(() => {
        listReleases()
            .then(setTags)
            .catch(e => setError(String(e)))
    }, [])

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
                    value={tag || null}
                    onChange={v => setTag(v ?? '')}
                    placeholder="newest first"
                    searchable
                    w={220}
                    comboboxProps={{ withinPortal: true }}
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

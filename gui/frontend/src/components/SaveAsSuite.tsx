import { useState } from 'react'
import { TextInput, Button } from '@mantine/core'
import { promoteSuite } from '../lib/ipc'
import type { ResultEnvelope } from '../lib/stepStream'

// After a green exploratory run, let the tester name + promote it into a suite
// PR. The skill is expected to have written the action trace to
// <bundleDir>/trace.json. Editorial styling, framed as a "keep this run" action.
export function SaveAsSuite({ cwd, result }: { cwd: string; result: ResultEnvelope }) {
    const [name, setName] = useState('')
    const [status, setStatus] = useState('')
    const [busy, setBusy] = useState(false)
    const bundleDir = result.bundleDir as string | undefined

    const promote = async () => {
        if (!bundleDir) {
            setStatus('No bundle dir on result.')
            return
        }
        setBusy(true)
        setStatus('Generating suite + opening PR…')
        try {
            const pr = await promoteSuite(cwd, name, `${bundleDir}/trace.json`)
            setStatus('PR opened: ' + pr)
        } catch (e) {
            setStatus('Promote failed: ' + String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div
            className="fade-up"
            style={{
                marginTop: 18,
                background: 'var(--teal-soft)',
                border: '1px solid var(--teal)',
                borderRadius: 10,
                padding: '16px 18px',
            }}
        >
            <div style={{ fontFamily: '"Fraunces", serif', fontWeight: 600, fontSize: 17, color: 'var(--teal-deep)' }}>
                Keep this run as a suite
            </div>
            <p style={{ margin: '4px 0 12px', color: 'var(--ink-dim)', fontSize: 14 }}>
                Generates a Playwright suite from this run and opens a pull request for review.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <TextInput
                    value={name}
                    onChange={(e) => setName(e.currentTarget.value)}
                    placeholder="suite-name (kebab-case)"
                    w={260}
                />
                <Button onClick={promote} disabled={!name.trim()} loading={busy} color="teal" radius="md">
                    Save as suite → PR
                </Button>
            </div>
            {status ? (
                <div className="mono st-dim" style={{ marginTop: 10, fontSize: 12 }}>
                    {status}
                </div>
            ) : null}
        </div>
    )
}

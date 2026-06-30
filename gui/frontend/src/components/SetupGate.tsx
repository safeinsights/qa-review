import { useEffect, useState } from 'react'
import { Alert, Button, Group, Text } from '@mantine/core'
import { isRepoReady, preflight, setup, chooseDirectory, defaultRepoDir } from '../lib/ipc'

// Gates the app on first launch: (1) a blocking banner if required tools
// (git/gh/claude/Chrome) are missing, and (2) a one-time consent + clone of the
// qa-review repo. Renders children once the repo is ready.
export function SetupGate({ children }: { children: React.ReactNode }) {
    const [ready, setReady] = useState<boolean | null>(null)
    const [missing, setMissing] = useState<string[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [log, setLog] = useState('')
    const [dir, setDir] = useState('')

    const refresh = async () => {
        try {
            // Go returns []string; guard against a null marshal just in case.
            setMissing((await preflight()) ?? [])
            setReady(await isRepoReady())
            setDir(await defaultRepoDir())
        } catch (e) {
            setError(String(e))
            setReady(false)
        }
    }

    useEffect(() => {
        void refresh()
    }, [])

    const choose = async () => {
        try {
            const picked = await chooseDirectory()
            if (picked) setDir(picked)
        } catch (e) {
            setError(String(e))
        }
    }

    const runSetup = async () => {
        setBusy(true)
        setError('')
        try {
            setLog(await setup(dir))
            setReady(await isRepoReady())
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    if (ready === null) return null // brief: preflight/ready check in flight

    const toolBanner =
        missing.length > 0 ? (
            <Alert color="red" title="Missing required tools" mb="md">
                Install and relaunch: <strong>{missing.join(', ')}</strong>. The QA Runner uses your
                machine's Google Chrome, git, gh, and claude.
            </Alert>
        ) : null

    if (!ready) {
        return (
            <div style={{ maxWidth: 620, margin: '60px auto', padding: '0 24px' }}>
                <h1 style={{ fontFamily: '"Fraunces", serif', fontWeight: 600, fontSize: 24 }}>
                    Set up the QA Runner
                </h1>
                {toolBanner}
                <p style={{ color: 'var(--ink-dim)' }}>
                    First, we'll clone the SafeInsights test repository to your machine so the runner has
                    the suites, environments, and shared secrets. This uses your GitHub access (gh).
                </p>
                <Text size="sm" mb={4} className="kicker">
                    Location
                </Text>
                <Group mb="md" gap="sm" align="center">
                    <Text size="sm" className="mono st-dim" style={{ wordBreak: 'break-all', flex: 1 }}>
                        {dir || '…'}
                    </Text>
                    <Button variant="default" size="xs" onClick={choose} disabled={busy}>
                        Choose folder…
                    </Button>
                </Group>
                {error ? (
                    <Alert color="red" mb="md">
                        {error}
                    </Alert>
                ) : null}
                <Button onClick={runSetup} loading={busy} color="teal" disabled={missing.length > 0 || !dir}>
                    Set up tests
                </Button>
                {log ? (
                    <pre className="mono st-dim" style={{ fontSize: 12, marginTop: 14, whiteSpace: 'pre-wrap' }}>
                        {log}
                    </pre>
                ) : null}
            </div>
        )
    }

    return (
        <>
            {toolBanner}
            {children}
        </>
    )
}

import { Alert, Button, Select, TextInput } from '@mantine/core'
import { useViewportSize } from '@mantine/hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    onSessionEnded,
    onSessionLog,
    onSessionReady,
    startValidationSession,
    stopSession,
    stopSessionIfOwner,
} from '../lib/ipc'
import type { ConsoleLine } from '../lib/screencast'
import { BrowserPanel } from './BrowserPanel'
import { ConsoleLog } from './ConsoleLog'
import { Terminal } from './Terminal'
import { VerdictPanel } from './VerdictPanel'

const ENVS = ['qa', 'staging']
const ROLES = ['admin', 'researcher', 'reviewer']

// "Validate a Jira ticket": Claude drives the shared logged-out browser (via the
// chrome-devtools MCP) to check a ticket's acceptance criteria, then posts the
// verdict + screenshots to Jira. The user watches the live browser + console and can
// drive it too. NO Playwright spec / engine run — pure MCP-driven validation.
export function ValidationTab() {
    const [env, setEnv] = useState('qa')
    const [pr, setPr] = useState('')
    const [role, setRole] = useState('admin')
    const [jiraCard, setJiraCard] = useState('')
    const card = parseJiraCard(jiraCard)

    const [active, setActive] = useState(false)
    const [starting, setStarting] = useState(false)
    const [screencastPort, setScreencastPort] = useState<number | null>(null)
    const [error, setError] = useState('')
    // Live page console, accumulated for the whole session (like the Suites screen).
    const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([])
    const addConsoleLine = useCallback((line: ConsoleLine) => {
        setConsoleLines(prev => [...prev, line])
    }, [])
    const logBuf = useRef('')
    const sessionToken = useRef<string | null>(null)

    // Session events. Mounted once; listeners persist across the tab's life.
    useEffect(() => {
        let unReady: (() => void) | undefined
        let unEnded: (() => void) | undefined
        let unLog: (() => void) | undefined
        ;(async () => {
            unReady = await onSessionReady(port => {
                setScreencastPort(port)
                setStarting(false)
                setActive(true)
            })
            unEnded = await onSessionEnded(() => {
                setActive(false)
                setScreencastPort(null)
                setStarting(false)
            })
            unLog = await onSessionLog(line => {
                logBuf.current += `${line}\n`
            })
        })()
        return () => {
            unReady?.()
            unEnded?.()
            unLog?.()
            if (sessionToken.current) void stopSessionIfOwner(sessionToken.current)
        }
    }, [])

    const start = async () => {
        setError('')
        setStarting(true)
        setActive(true)
        setConsoleLines([])
        try {
            sessionToken.current = await startValidationSession(env, pr, card)
        } catch (e) {
            setError(String(e) + (logBuf.current ? `\n${logBuf.current}` : ''))
            setActive(false)
            setStarting(false)
        }
    }

    const stop = async () => {
        await stopSession()
        sessionToken.current = null
        setActive(false)
        setScreencastPort(null)
        setConsoleLines([])
    }

    if (!active) {
        return (
            <SessionSetup
                env={env}
                setEnv={setEnv}
                pr={pr}
                setPr={setPr}
                role={role}
                setRole={setRole}
                jiraCard={jiraCard}
                setJiraCard={setJiraCard}
                start={start}
                error={error}
            />
        )
    }

    return (
        <LiveSession
            card={card}
            starting={starting}
            screencastPort={screencastPort}
            consoleLines={consoleLines}
            onConsoleLine={addConsoleLine}
            stop={stop}
        />
    )
}

// Accept either a bare Jira key (OTTER-123) or a full URL
// (e.g. https://openstax.atlassian.net/browse/OTTER-123?focused=…) and return the key.
function parseJiraCard(input: string): string {
    const m = input.match(/[A-Z][A-Z0-9]+-\d+/i)
    return m ? m[0].toUpperCase() : input.trim()
}

// The setup form: pick env/PR/role, enter the Jira card, then start the session.
function SessionSetup({
    env,
    setEnv,
    pr,
    setPr,
    role,
    setRole,
    jiraCard,
    setJiraCard,
    start,
    error,
}: {
    env: string
    setEnv: (v: string) => void
    pr: string
    setPr: (v: string) => void
    role: string
    setRole: (v: string) => void
    jiraCard: string
    setJiraCard: (v: string) => void
    start: () => void
    error: string
}) {
    return (
        <div>
            <div
                style={{
                    background: 'var(--paper-card)',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: '16px 18px',
                    boxShadow: 'var(--shadow-card)',
                }}
            >
                <div className="kicker" style={{ marginBottom: 8 }}>
                    Validate a Jira ticket — Claude drives the browser, then reports back
                </div>
                <div
                    style={{
                        display: 'flex',
                        gap: 18,
                        alignItems: 'flex-end',
                        flexWrap: 'wrap',
                    }}
                >
                    <Field label="Env">
                        <Select
                            data={ENVS}
                            value={env}
                            onChange={v => v && setEnv(v)}
                            disabled={!!pr}
                            allowDeselect={false}
                            w={110}
                            comboboxProps={{ withinPortal: true }}
                        />
                    </Field>
                    <Field label="PR #">
                        <TextInput
                            value={pr}
                            onChange={e => setPr(e.currentTarget.value)}
                            placeholder="optional"
                            w={90}
                        />
                    </Field>
                    <Field label="Role">
                        <Select
                            data={ROLES}
                            value={role}
                            onChange={v => v && setRole(v)}
                            allowDeselect={false}
                            w={110}
                            comboboxProps={{ withinPortal: true }}
                        />
                    </Field>
                    <Field label="Jira card">
                        <TextInput
                            value={jiraCard}
                            onChange={e => setJiraCard(e.currentTarget.value)}
                            placeholder="OTTER-123 or a Jira URL"
                            w={220}
                        />
                    </Field>
                    <Button
                        onClick={start}
                        disabled={!jiraCard.trim()}
                        color="teal"
                        radius="md"
                        size="md"
                        style={{
                            marginLeft: 'auto',
                            boxShadow: '0 6px 18px rgba(12,107,94,0.22)',
                        }}
                        leftSection={<span aria-hidden>▶</span>}
                    >
                        Start validation
                    </Button>
                </div>
            </div>
            {error ? (
                <Alert color="red" mt="md" style={{ whiteSpace: 'pre-wrap' }}>
                    {error}
                </Alert>
            ) : null}
        </div>
    )
}

// The live split-view: Claude terminal beside the shared browser + console.
function LiveSession({
    card,
    starting,
    screencastPort,
    consoleLines,
    onConsoleLine,
    stop,
}: {
    card: string
    starting: boolean
    screencastPort: number | null
    consoleLines: ConsoleLine[]
    onConsoleLine: (line: ConsoleLine) => void
    stop: () => void
}) {
    const { width } = useViewportSize()
    const gridTemplateColumns = width < 1070 ? '1fr' : 'minmax(650px, 1.1fr) minmax(360px, 1fr)'

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <span className="mono st-dim" style={{ fontSize: 12 }}>
                    {starting
                        ? 'Starting browser + Claude…'
                        : 'Session live — Claude is validating in the browser.'}
                </span>
                <VerdictPanel card={card} />
                <Button
                    onClick={stop}
                    variant="outline"
                    color="red"
                    size="sm"
                    style={{ marginLeft: 'auto' }}
                >
                    Stop session
                </Button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns, gap: 16 }}>
                <section
                    style={{
                        background: '#0f1419',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        overflow: 'hidden',
                        minWidth: 650,
                        // Fixed, viewport-capped height so the terminal scrolls
                        // internally instead of growing the grid row without bound.
                        height: 'min(72vh, 720px)',
                        padding: 8,
                    }}
                >
                    <Terminal />
                </section>
                <section
                    style={{
                        background: 'var(--paper-card)',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        overflow: 'hidden',
                        boxShadow: 'var(--shadow-monitor)',
                        alignSelf: 'start',
                        minWidth: 0,
                    }}
                >
                    {screencastPort ? (
                        <>
                            <BrowserPanel port={screencastPort} onConsole={onConsoleLine} />
                            <ConsoleLog
                                live
                                lines={consoleLines}
                                emptyText="No console output yet."
                            />
                        </>
                    ) : (
                        <div
                            style={{
                                aspectRatio: '16 / 10',
                                display: 'grid',
                                placeItems: 'center',
                                color: 'var(--ink-faint)',
                                fontStyle: 'italic',
                            }}
                        >
                            Waiting for the browser…
                        </div>
                    )}
                </section>
            </div>
        </div>
    )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kicker">{label}</span>
            {children}
        </div>
    )
}

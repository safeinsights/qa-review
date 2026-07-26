import { Alert, Button, Select, Textarea, TextInput } from '@mantine/core'
import { useViewportSize } from '@mantine/hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    onSessionEnded,
    onSessionLog,
    onSessionReady,
    type SessionKind,
    startValidationSession,
    stopSession,
    stopSessionIfOwner,
} from '../lib/ipc'
import type { ConsoleLine } from '../lib/screencast'
import { ConsoleLog } from './ConsoleLog'
import { LiveBrowser } from './LiveBrowser'
import { SessionUnavailable } from './SessionUnavailable'
import { Terminal } from './Terminal'
import { VerdictPanel } from './VerdictPanel'

// This tab owns "validation" sessions; a session-ready of any other kind means the
// other tab (or the run companion) holds the single shared PTY + browser.
const MY_KIND: SessionKind = 'validation'

const ENVS = ['qa', 'staging', 'production']
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
    const [instructions, setInstructions] = useState('')
    const card = parseJiraCard(jiraCard)

    const [active, setActive] = useState(false)
    const [starting, setStarting] = useState(false)
    const [screencastPort, setScreencastPort] = useState<number | null>(null)
    // Set when the OTHER tab owns the shared session; the setup form is replaced by
    // an "unavailable, take over?" banner while this holds a kind.
    const [ownedByOther, setOwnedByOther] = useState<SessionKind | null>(null)
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
            unReady = await onSessionReady(({ kind, screencastPort: port }) => {
                if (kind !== MY_KIND) {
                    // The other tab (or the run companion) took the shared session.
                    setOwnedByOther(kind)
                    setActive(false)
                    setStarting(false)
                    setScreencastPort(null)
                    return
                }
                setOwnedByOther(null)
                setScreencastPort(port)
                setStarting(false)
                setActive(true)
            })
            unEnded = await onSessionEnded(() => {
                setOwnedByOther(null)
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
            sessionToken.current = await startValidationSession(env, pr, card, instructions)
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

    // Stop the other tab's session (freeing the single shared slot) and drop back to
    // our setup form so the user can start a validation session here.
    const takeOver = async () => {
        await stopSession()
        setOwnedByOther(null)
    }

    if (ownedByOther) {
        return <SessionUnavailable ownerKind={ownedByOther} onTakeOver={takeOver} />
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
                instructions={instructions}
                setInstructions={setInstructions}
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

// The setup form: pick env/PR/role, enter the Jira card + optional instructions,
// then start the session.
function SessionSetup({
    env,
    setEnv,
    pr,
    setPr,
    role,
    setRole,
    jiraCard,
    setJiraCard,
    instructions,
    setInstructions,
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
    instructions: string
    setInstructions: (v: string) => void
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
                    <Field label="Jira card" grow>
                        <TextInput
                            value={jiraCard}
                            onChange={e => setJiraCard(e.currentTarget.value)}
                            placeholder="OTTER-123 or a full Jira URL"
                            style={{ flex: 1 }}
                            miw={340}
                        />
                    </Field>
                </div>
                <Textarea
                    label="Additional instructions"
                    description="Optional — appended to Claude's starting prompt as a final paragraph."
                    value={instructions}
                    onChange={e => setInstructions(e.currentTarget.value)}
                    placeholder="e.g. focus on the mobile layout; the feature flag is enabled for the researcher account"
                    autosize
                    minRows={2}
                    maxRows={6}
                    mt="md"
                />
                <div style={{ display: 'flex', marginTop: 16 }}>
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
                            <LiveBrowser port={screencastPort} onConsole={onConsoleLine} />
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

function Field({
    label,
    grow,
    children,
}: {
    label: string
    grow?: boolean
    children: React.ReactNode
}) {
    return (
        <div
            style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: grow ? 1 : undefined }}
        >
            <span className="kicker">{label}</span>
            {children}
        </div>
    )
}

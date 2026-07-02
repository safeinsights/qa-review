import { Alert, Button, Select, Textarea, TextInput } from '@mantine/core'
import { useViewportSize } from '@mantine/hooks'
import { useEffect, useRef, useState } from 'react'
import {
    onSessionEnded,
    onSessionLog,
    onSessionReady,
    startAuthoringSession,
    stopSession,
    stopSessionIfOwner,
} from '../lib/ipc'
import { BrowserPanel } from './BrowserPanel'
import { SaveSuitePanel } from './SaveSuitePanel'
import { Terminal } from './Terminal'

const ENVS = ['qa', 'staging']
const ROLES = ['admin', 'researcher', 'reviewer']

// "Author a Suite": the user describes a test, then drives claude in an embedded
// terminal while watching the (shared, claude-driven) browser, until claude has
// written a passing src/suites/<name>.ts — then opens a PR.
export function ExploratoryTab() {
    const [env, setEnv] = useState('qa')
    const [pr, setPr] = useState('')
    const [role, setRole] = useState('admin')
    const [instruction, setInstruction] = useState('')

    const [active, setActive] = useState(false)
    const [starting, setStarting] = useState(false)
    const [screencastPort, setScreencastPort] = useState<number | null>(null)
    const [error, setError] = useState('')
    const logBuf = useRef('')
    // On unmount we only tear down if we still own the active session (the run
    // companion may have since taken over the shared PTY slot).
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
                // Our session's browser is genuinely up → we ARE active. Setting this
                // here (not only in start()) self-heals the case where our own
                // startAuthoringSession evicted a prior session: Go broadcasts
                // `session-ended` for that eviction, which our own onSessionEnded
                // handler would otherwise use to flip us to active=false mid-start.
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
            // Tearing down the tab stops any live session — but ONLY if we still own
            // it, so a stale unmount can't kill the run companion's session running
            // in the other tab.
            if (sessionToken.current) void stopSessionIfOwner(sessionToken.current)
        }
    }, [])

    const start = async () => {
        setError('')
        setStarting(true)
        setActive(true)
        try {
            sessionToken.current = await startAuthoringSession(env, pr, role, instruction)
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
                instruction={instruction}
                setInstruction={setInstruction}
                start={start}
                error={error}
            />
        )
    }

    return (
        <LiveSession
            env={env}
            pr={pr}
            role={role}
            starting={starting}
            screencastPort={screencastPort}
            stop={stop}
        />
    )
}

// The setup form: describe the test, pick env/PR/role, then start the session.
function SessionSetup({
    env,
    setEnv,
    pr,
    setPr,
    role,
    setRole,
    instruction,
    setInstruction,
    start,
    error,
}: {
    env: string
    setEnv: (v: string) => void
    pr: string
    setPr: (v: string) => void
    role: string
    setRole: (v: string) => void
    instruction: string
    setInstruction: (v: string) => void
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
                    Describe the test — then drive Claude to build it
                </div>
                <Textarea
                    value={instruction}
                    onChange={e => setInstruction(e.currentTarget.value)}
                    placeholder="e.g. log in as a researcher and create a study, then verify it appears in the list"
                    autosize
                    minRows={2}
                    maxRows={5}
                    styles={{ input: { fontFamily: '"Newsreader", serif', fontSize: 15 } }}
                />
                <div
                    style={{
                        display: 'flex',
                        gap: 18,
                        alignItems: 'flex-end',
                        flexWrap: 'wrap',
                        marginTop: 14,
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
                            w={150}
                            comboboxProps={{ withinPortal: true }}
                        />
                    </Field>
                    <Button
                        onClick={start}
                        disabled={!instruction.trim()}
                        color="teal"
                        radius="md"
                        size="md"
                        style={{
                            marginLeft: 'auto',
                            boxShadow: '0 6px 18px rgba(12,107,94,0.22)',
                        }}
                        leftSection={<span aria-hidden>▶</span>}
                    >
                        Start session
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

// The live split-view: Claude terminal beside the shared browser (stacked when narrow).
function LiveSession({
    env,
    pr,
    role,
    starting,
    screencastPort,
    stop,
}: {
    env: string
    pr: string
    role: string
    starting: boolean
    screencastPort: number | null
    stop: () => void
}) {
    const { width } = useViewportSize() // re-renders on resize → responsive split
    // Terminal needs >=650px; the browser flexes. Below ~1070px there isn't room
    // for both side by side, so stack them (terminal on top).
    const gridTemplateColumns = width < 1070 ? '1fr' : 'minmax(650px, 1.1fr) minmax(360px, 1fr)'

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <span className="mono st-dim" style={{ fontSize: 12 }}>
                    {starting
                        ? 'Starting browser + Claude…'
                        : 'Session live — drive Claude in the terminal.'}
                </span>
                <SaveSuitePanel env={env} pr={pr} role={role} />
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
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns,
                    gap: 16,
                }}
            >
                <section
                    style={{
                        background: '#0f1419',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        overflow: 'hidden',
                        minWidth: 650,
                        minHeight: 460,
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
                        <BrowserPanel port={screencastPort} />
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

import { Alert, Button, Select, Textarea, TextInput } from '@mantine/core'
import { useViewportSize } from '@mantine/hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    checkPrCI,
    ENVS,
    onSessionEnded,
    onSessionLog,
    onSessionReady,
    type PrCIStatus,
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
import { ciBlocks, isPrNumber, parseJiraCard, parsePrNumber } from './validationInputs'

// This tab owns "validation" sessions; a session-ready of any other kind means the
// other tab (or the run companion) holds the single shared PTY + browser.
const MY_KIND: SessionKind = 'validation'

// Debounce for the CI probe: each one shells out to `gh`, so we wait for the PR
// input to settle rather than firing per keystroke.
const CI_PROBE_DEBOUNCE_MS = 400

// Reads the PR's continuous-integration/* checks whenever the PR number settles,
// so the tester is warned that the preview deployment is mid-build BEFORE pressing
// Start (Go re-checks and is the real gate). Returns null while there's no PR to
// check or a probe is in flight for a changed number — callers treat null as "no
// verdict yet", which never blocks.
function usePrCIStatus(prNumber: string): { status: PrCIStatus | null; checking: boolean } {
    const [status, setStatus] = useState<PrCIStatus | null>(null)
    const [checking, setChecking] = useState(false)

    useEffect(() => {
        if (!/^\d+$/.test(prNumber)) {
            setStatus(null)
            setChecking(false)
            return
        }
        // Ignore a resolved probe whose PR is no longer the one in the box —
        // `gh` calls can return out of order and a stale verdict would gate the
        // Start button on the wrong PR.
        let current = true
        setChecking(true)
        const timer = setTimeout(async () => {
            try {
                const result = await checkPrCI(prNumber)
                if (current) setStatus(result)
            } catch (e) {
                // A probe failure is not evidence the deployment is stale, so it
                // must not block: report it as "unknown", which never gates.
                if (current) setStatus({ state: 'unknown', warning: String(e), checks: null })
            } finally {
                if (current) setChecking(false)
            }
        }, CI_PROBE_DEBOUNCE_MS)

        return () => {
            current = false
            clearTimeout(timer)
        }
    }, [prNumber])

    return { status, checking }
}

// The colour + heading for each blocking CI state. "unknown" and "ok" never reach
// here — the alert only renders when ciBlocks() is true.
const CI_ALERT: Record<string, { color: string; title: string }> = {
    pending: { color: 'yellow', title: 'CI is still running on this PR' },
    failed: { color: 'red', title: 'CI failed on this PR' },
    none: { color: 'yellow', title: 'CI has not reported on this PR yet' },
}

// "Validate a Jira ticket": Claude drives the shared logged-out browser (via the
// chrome-devtools MCP) to check a ticket's acceptance criteria, then posts the
// verdict + screenshots to Jira. The user watches the live browser + console and can
// drive it too. NO Playwright spec / engine run — pure MCP-driven validation.
export function ValidationTab() {
    const [env, setEnv] = useState('qa')
    const [pr, setPr] = useState('')
    const [jiraCard, setJiraCard] = useState('')
    const [instructions, setInstructions] = useState('')
    // The card the LIVE session is about. Usually what was typed, but with a PR and
    // no card Go infers the key from the PR and returns it — the Verdict button and
    // the verdict-posted match both key off this, not off the raw input.
    const [activeCard, setActiveCard] = useState('')
    const card = parseJiraCard(jiraCard)
    // Both inputs accept a pasted URL; everything downstream gets the parsed value.
    const prNumber = parsePrNumber(pr)
    // A PR overrides the env, so the Env selector locks — but only once the input is
    // a real number, not on a half-typed URL or a typo.
    const hasPr = isPrNumber(pr)
    // Validating by PR alone is allowed; the ticket is then inferred from the PR.
    const canStart = !!(card || prNumber)
    // A PR whose deployment checks aren't green means the preview URL isn't a build
    // of the code under review. Warn, and make starting anyway a deliberate act.
    const { status: ciStatus, checking: ciChecking } = usePrCIStatus(prNumber)
    const ciBlocked = ciBlocks(ciStatus?.state)

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

    // `force` comes from the "Start anyway" button, shown only once a blocking CI
    // status has been surfaced — so bypassing the gate is always a read-then-choose.
    const start = async (force = false) => {
        setError('')
        setStarting(true)
        setActive(true)
        setConsoleLines([])
        setActiveCard(card)
        try {
            const started = await startValidationSession(env, prNumber, card, instructions, force)
            sessionToken.current = started.token
            setActiveCard(started.jiraCard)
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
                hasPr={hasPr}
                jiraCard={jiraCard}
                setJiraCard={setJiraCard}
                instructions={instructions}
                setInstructions={setInstructions}
                start={start}
                canStart={canStart}
                ciStatus={ciStatus}
                ciBlocked={ciBlocked}
                ciChecking={ciChecking}
                error={error}
            />
        )
    }

    return (
        <LiveSession
            card={activeCard}
            starting={starting}
            screencastPort={screencastPort}
            consoleLines={consoleLines}
            onConsoleLine={addConsoleLine}
            stop={stop}
        />
    )
}

// The setup form: pick the env, then give a Jira card and/or a PR number (either
// alone is enough) plus optional instructions, and start the session. There is no
// role picker — the role is inferred from the ticket by the qa-validate skill.
function SessionSetup({
    env,
    setEnv,
    pr,
    setPr,
    hasPr,
    jiraCard,
    setJiraCard,
    instructions,
    setInstructions,
    start,
    canStart,
    ciStatus,
    ciBlocked,
    ciChecking,
    error,
}: {
    env: string
    setEnv: (v: string) => void
    pr: string
    setPr: (v: string) => void
    hasPr: boolean
    jiraCard: string
    setJiraCard: (v: string) => void
    instructions: string
    setInstructions: (v: string) => void
    start: (force?: boolean) => void
    canStart: boolean
    ciStatus: PrCIStatus | null
    ciBlocked: boolean
    ciChecking: boolean
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
                    <Field label={hasPr ? 'Env (from PR)' : 'Env'}>
                        <Select
                            data={ENVS}
                            value={env}
                            onChange={v => v && setEnv(v)}
                            disabled={hasPr}
                            allowDeselect={false}
                            w={110}
                            comboboxProps={{ withinPortal: true }}
                        />
                    </Field>
                    <Field label="Jira card" grow>
                        <TextInput
                            value={jiraCard}
                            onChange={e => setJiraCard(e.currentTarget.value)}
                            placeholder="OTTER-123 or a Jira URL"
                            style={{ flex: 1 }}
                            miw={240}
                        />
                    </Field>
                    <Field label="PR" grow>
                        <TextInput
                            value={pr}
                            onChange={e => setPr(e.currentTarget.value)}
                            placeholder="839 or a GitHub PR URL"
                            style={{ flex: 1 }}
                            miw={240}
                        />
                    </Field>
                </div>
                <div className="st-dim" style={{ fontSize: 12, marginTop: 8 }}>
                    Give a Jira card, a PR, or both — either accepts a pasted URL. With only a PR,
                    the ticket is inferred from its title, branch, or description. A PR runs against
                    its own preview deployment, so it overrides the env.
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
                <CIWarning status={ciStatus} isVisible={ciBlocked} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                    {ciChecking ? (
                        <span className="st-dim" style={{ fontSize: 12 }}>
                            Checking CI…
                        </span>
                    ) : null}
                    <Button
                        onClick={() => start(ciBlocked)}
                        disabled={!canStart || ciChecking}
                        color={ciBlocked ? 'orange' : 'teal'}
                        variant={ciBlocked ? 'outline' : 'filled'}
                        radius="md"
                        size="md"
                        style={{
                            marginLeft: 'auto',
                            boxShadow: ciBlocked ? undefined : '0 6px 18px rgba(12,107,94,0.22)',
                        }}
                        leftSection={<span aria-hidden>▶</span>}
                    >
                        {ciBlocked ? 'Start anyway' : 'Start validation'}
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

// The "CI isn't green" banner. A PR preview (prN.qa.safeinsights.org) is built by
// the Jenkins continuous-integration/* checks, so until they finish green the URL
// serves the previous commit or nothing at all — and a pass recorded against that
// is a validation of the wrong code.
function CIWarning({ status, isVisible }: { status: PrCIStatus | null; isVisible: boolean }) {
    if (!isVisible || !status) return null
    const alert = CI_ALERT[status.state]
    if (!alert) return null

    return (
        <Alert color={alert.color} title={alert.title} mt="md">
            {status.warning}
            {status.checks?.length ? (
                <div className="mono st-dim" style={{ fontSize: 11, marginTop: 6 }}>
                    {status.checks.join(', ')}
                </div>
            ) : null}
        </Alert>
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

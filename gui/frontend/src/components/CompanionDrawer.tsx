import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer } from '@mantine/core'
import { Terminal } from './Terminal'
import { startRunCompanion, stopSessionIfOwner } from '../lib/ipc'

// The "Ask Claude" run companion drawer. A bottom Mantine Drawer that slides up
// over the run screen, NON-MODAL so the user keeps interacting with the run (click
// steps, watch the live browser) while Claude is open. Lazily spawns the companion
// PTY on first open only, attached to the run's CDP port. `idle` = the engine isn't
// mid-step (paused, errored, or finished) — only then can Claude drive the browser.
//
// The `open` state is LIFTED to RunScreen (props `open`/`onClose`) and this drawer
// is mounted ONCE at RunScreen's top level — NOT inside the live-browser top bar —
// so it survives the right panel flipping between live / snapshot / recording. Its
// PTY teardown-on-unmount therefore only fires when the run screen itself unmounts
// (or a new run starts), never when the browser view flips.
export function CompanionDrawer({
    cdpPort,
    suite,
    idle,
    open,
    onClose,
}: {
    cdpPort: number | null
    suite: string
    idle: boolean
    open: boolean
    onClose: () => void
}) {
    // xterm measures its container, so mount <Terminal> only after the slide-in
    // transition finishes (drawer at its final height) — otherwise it fits to the
    // mid-animation box. Toggled by Mantine's onEnterTransitionEnd / onExitTransitionEnd.
    const [entered, setEntered] = useState(false)
    const [spawnError, setSpawnError] = useState<string | null>(null)
    const spawned = useRef(false)
    // The token for our companion session, captured from startRunCompanion. Teardown
    // is token-scoped so a stale unmount can't kill an authoring session that has
    // since taken over the shared PTY slot.
    const sessionToken = useRef<string | null>(null)

    // Lazy spawn on first open. Surface a spawn failure inline (Go returns an
    // error on failure — do NOT silently discard the promise).
    useEffect(() => {
        if (open && !spawned.current && cdpPort) {
            spawned.current = true
            setSpawnError(null)
            startRunCompanion(cdpPort, suite)
                .then((token) => {
                    sessionToken.current = token
                })
                .catch((e) => {
                    setSpawnError(String((e as { message?: string })?.message ?? e))
                    spawned.current = false // allow a retry on reopen
                })
        }
    }, [open, cdpPort, suite])

    // Tear down the PTY when the run screen goes away / a new run starts (unmount).
    // Closing the drawer (not unmounting) keeps the PTY alive so reopening resumes.
    // Token-scoped so a stale unmount doesn't kill the authoring session.
    useEffect(() => {
        return () => {
            if (spawned.current && sessionToken.current) void stopSessionIfOwner(sessionToken.current)
        }
    }, [])

    return (
        <Drawer
            opened={open}
            onClose={onClose}
            position="bottom"
            size="55%"
            withOverlay={false}
            closeOnClickOutside={false}
            trapFocus={false}
            lockScroll={false}
            title={
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className="kicker">Claude — run companion</span>
                    <span className="mono st-dim" style={{ fontSize: 12 }}>
                        {idle
                            ? 'run is idle — Claude can drive the browser'
                            : 'read-only while a step is running — pause or stop to let Claude drive'}
                    </span>
                </div>
            }
            transitionProps={{ transition: 'slide-up', duration: 200 }}
            onEnterTransitionEnd={() => setEntered(true)}
            onExitTransitionEnd={() => setEntered(false)}
            keepMounted={false}
            styles={{ body: { height: 'calc(100% - 60px)', background: '#0f1419', padding: 8 } }}
        >
            {spawnError ? (
                <Alert color="red" mb="sm">
                    {spawnError}
                </Alert>
            ) : null}
            {entered ? (
                <div style={{ width: '100%', height: '100%' }}>
                    <Terminal />
                </div>
            ) : null}
        </Drawer>
    )
}

// The lightweight "Ask Claude" toggle button. It does NOT own the drawer — it just
// asks RunScreen to open it. Rendered in an always-present spot (the Steps header)
// so the companion is reachable in every run state, including a finished/failed run.
export function CompanionToggle({
    onOpen,
    emphasize,
    disabled,
}: {
    onOpen: () => void
    emphasize: boolean
    disabled: boolean
}) {
    return (
        <Button
            variant={emphasize ? 'filled' : 'light'}
            color="teal"
            size="xs"
            disabled={disabled}
            onClick={onOpen}
            style={emphasize ? { boxShadow: '0 6px 18px rgba(12,107,94,0.28)' } : undefined}
        >
            {emphasize ? '💬 Ask Claude about this' : 'Ask Claude'}
        </Button>
    )
}

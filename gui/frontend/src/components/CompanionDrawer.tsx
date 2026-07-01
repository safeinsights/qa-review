import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer } from '@mantine/core'
import { Terminal } from './Terminal'
import { startRunCompanion, stopSession } from '../lib/ipc'

// The "Ask Claude" run companion. A bottom Mantine Drawer that slides up over the
// run screen, NON-MODAL so the user keeps interacting with the run (click steps,
// watch the live browser) while Claude is open. Lazily spawns the companion PTY on
// first open only, attached to the run's CDP port. `idle` = the engine isn't
// mid-step (paused, errored, or finished) — only then can Claude drive the browser.
export function CompanionDrawer({
    cdpPort,
    suite,
    idle,
    emphasize,
}: {
    cdpPort: number | null
    suite: string
    idle: boolean
    emphasize: boolean
}) {
    const [open, setOpen] = useState(false)
    // xterm measures its container, so mount <Terminal> only after the slide-in
    // transition finishes (drawer at its final height) — otherwise it fits to the
    // mid-animation box. Toggled by Mantine's onEnterTransitionEnd / onExitTransitionEnd.
    const [entered, setEntered] = useState(false)
    const [spawnError, setSpawnError] = useState<string | null>(null)
    const spawned = useRef(false)

    // Lazy spawn on first open. Surface a spawn failure inline (Go returns an
    // error on failure — do NOT silently discard the promise).
    useEffect(() => {
        if (open && !spawned.current && cdpPort) {
            spawned.current = true
            setSpawnError(null)
            startRunCompanion(cdpPort, suite).catch((e) => {
                setSpawnError(String(e))
                spawned.current = false // allow a retry on reopen
            })
        }
    }, [open, cdpPort, suite])

    // Tear down the PTY when the run screen goes away / a new run starts (unmount).
    // Closing the drawer (not unmounting) keeps the PTY alive so reopening resumes.
    useEffect(() => {
        return () => {
            if (spawned.current) void stopSession()
        }
    }, [])

    return (
        <>
            <Button
                variant={emphasize ? 'filled' : 'light'}
                color="teal"
                size="xs"
                disabled={!cdpPort}
                onClick={() => setOpen(true)}
                style={emphasize ? { boxShadow: '0 6px 18px rgba(12,107,94,0.28)' } : undefined}
            >
                {emphasize ? '💬 Ask Claude about this' : 'Ask Claude'}
            </Button>
            <Drawer
                opened={open}
                onClose={() => setOpen(false)}
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
        </>
    )
}

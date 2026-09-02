import { Alert, Button, Drawer } from '@mantine/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { startRunCompanion, stopSessionIfOwner } from '../lib/ipc'
import { companionPortAction } from './companionLifecycle'
import { Terminal } from './Terminal'

// Companion drawer height in px. COMPANION_HEIGHT is the default the drawer opens
// at AND the fixed bottom padding the run screen reserves so the drawer never hides
// the bottom of the run content. The min keeps the terminal usable; the max leaves
// the run's top bar (and the resize handle) reachable.
export const COMPANION_HEIGHT = 360
export const COMPANION_MIN_HEIGHT = 180
export function companionMaxHeight(): number {
    return Math.max(COMPANION_MIN_HEIGHT, window.innerHeight - 120)
}
// The grab strip at the top of the drawer the user drags to resize.
const RESIZE_HANDLE_HEIGHT = 10

// The "Ask Claude" run companion drawer. A bottom Mantine Drawer that slides up
// over the run screen, NON-MODAL so the user keeps interacting with the run (click
// steps, watch the live browser) while Claude is open. Lazily spawns the companion
// PTY on first open only, attached to the run's CDP port.
//
// The `open` state is LIFTED to RunScreen (props `open`/`onClose`) and this drawer
// is mounted ONCE at RunScreen's top level — NOT inside the live-browser top bar —
// so it survives the right panel flipping between live / snapshot / recording. Its
// PTY teardown-on-unmount therefore only fires when the run screen itself unmounts
// (or a new run starts), never when the browser view flips.
export function CompanionDrawer({
    cdpPort,
    suite,
    open,
    onClose,
    height,
    onHeightChange,
    onAliveChange,
}: {
    cdpPort: number | null
    suite: string
    open: boolean
    onClose: () => void
    // Drawer height in px, owned by RunScreen so the run content can reserve equal
    // bottom padding (scroll clears the drawer). Dragging the top handle updates it.
    height: number
    onHeightChange: (h: number) => void
    // Reports whether a companion PTY currently exists, so the "Ask Claude" toggle
    // can stay enabled after a run stops (the session outlives its browser).
    onAliveChange?: (alive: boolean) => void
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

    // Whether the live PTY is attached to a browser that no longer exists (the run
    // was stopped). The conversation stays usable — that's the point — but the
    // browser-driving MCP tools in it are dead, so say so rather than let the user
    // ask for a snapshot and get a confusing failure from inside Claude.
    const [browserGone, setBrowserGone] = useState(false)

    // `spawned` stays a REF because it is the synchronous double-spawn guard: it must
    // be readable and settable between renders, before startRunCompanion resolves.
    // markSpawned mirrors it outward for the parts that render off it (the "Ask
    // Claude" toggle stays enabled once a session exists, even with no cdpPort).
    const markSpawned = useCallback(
        (alive: boolean) => {
            spawned.current = alive
            onAliveChange?.(alive)
        },
        [onAliveChange]
    )

    // Reset spawn state so the NEXT open spawns a fresh companion. Called when the
    // PTY dies (Claude quit / evicted) — there is no session left to reuse.
    const resetSpawn = useCallback(() => {
        markSpawned(false)
        sessionToken.current = null
        setBrowserGone(false)
    }, [markSpawned])

    // The run's CDP port identifies THIS run's browser. What to do when it changes
    // is NOT uniform, so the decision lives in companionPortAction:
    //
    //   stop (port -> null)  keep the PTY. Its browser tools are dead, but the
    //                        conversation is the valuable part and the user's next
    //                        question ("why did step 12 fail") is answerable from
    //                        the on-disk bundle. Killing it here is what made the
    //                        run-stop-start cycle lose context.
    //   new run (new port)   reap and respawn against the new port. Keeping it is
    //                        unsafe, not just useless: the old port is ephemeral and
    //                        can be reused, so the companion could silently drive
    //                        the wrong browser.
    const prevCdpPort = useRef<number | null>(cdpPort)
    useEffect(() => {
        const prev = prevCdpPort.current
        if (prev === cdpPort) return
        prevCdpPort.current = cdpPort
        const action = companionPortAction(prev, cdpPort, spawned.current)
        if (action === 'keep-stale') {
            setBrowserGone(true)
            return
        }
        if (action === 'respawn') {
            // Reap explicitly. The Go side would evict this PTY anyway when the new
            // companion starts, but doing it here keeps the drawer's own state and
            // the PTY slot in agreement even if the user never reopens.
            if (sessionToken.current) void stopSessionIfOwner(sessionToken.current)
            resetSpawn()
        }
    }, [cdpPort, resetSpawn])

    // Lazy spawn on first open. Surface a spawn failure inline (Go returns an
    // error on failure — do NOT silently discard the promise).
    //
    // The `spawned` flag is claimed BEFORE the await and released only on failure,
    // so a re-render (or a second "Ask Claude" press) while the promise is in flight
    // cannot start a second companion — Go would reject that with "a session is
    // already running" (pty.go's single-slot guard) and the user would see a stray
    // error over a perfectly healthy session.
    useEffect(() => {
        if (open && !spawned.current && cdpPort) {
            markSpawned(true)
            setSpawnError(null)
            setBrowserGone(false)
            startRunCompanion(cdpPort, suite)
                .then(token => {
                    sessionToken.current = token
                })
                .catch(e => {
                    setSpawnError(String((e as { message?: string })?.message ?? e))
                    markSpawned(false) // allow a retry on reopen
                })
        }
    }, [open, cdpPort, suite, markSpawned])

    // Tear down the PTY when the run screen goes away / a new run starts (unmount).
    // Closing the drawer (not unmounting) keeps the PTY alive so reopening resumes.
    // Token-scoped so a stale unmount doesn't kill the authoring session.
    useEffect(() => {
        return () => {
            if (spawned.current && sessionToken.current)
                void stopSessionIfOwner(sessionToken.current)
        }
    }, [])

    // Drag the top handle to resize: height grows as the pointer moves UP (toward
    // the top of the screen), so track the pointer's distance from the viewport
    // bottom. Pointer capture keeps the drag alive even over the embedded terminal.
    const onHandlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault()
            // Capture keeps the drag alive as the pointer moves over the terminal; a
            // failure to capture must not abort the resize (listeners still attach).
            try {
                e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
                /* ignore — capture is a nicety, the window listeners drive the resize */
            }
            const max = companionMaxHeight()
            const onMove = (ev: PointerEvent) => {
                const next = window.innerHeight - ev.clientY
                onHeightChange(Math.min(max, Math.max(COMPANION_MIN_HEIGHT, next)))
            }
            const onUp = () => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
            }
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
        },
        [onHeightChange]
    )

    return (
        <Drawer
            opened={open}
            onClose={onClose}
            position="bottom"
            size={`${height}px`}
            withOverlay={false}
            closeOnClickOutside={false}
            // Esc must reach the embedded claude terminal (its onData forwards it to
            // the PTY) — don't let the Drawer swallow it to close. Users close the
            // companion with the × in the terminal's top-right corner instead.
            closeOnEscape={false}
            trapFocus={false}
            lockScroll={false}
            // No header/title bar — it wasted vertical space. The drag handle and the
            // close × live inside the body (top strip / top-right) instead.
            withCloseButton={false}
            transitionProps={{ transition: 'slide-up', duration: 200 }}
            onEnterTransitionEnd={() => setEntered(true)}
            onExitTransitionEnd={() => setEntered(false)}
            keepMounted={false}
            styles={{
                // Body fills the whole drawer (no header). The drag strip is pinned to
                // its top edge, so reserve equal top padding for it.
                body: {
                    position: 'relative',
                    height: '100%',
                    background: '#0f1419',
                    padding: 8,
                    paddingTop: 8 + RESIZE_HANDLE_HEIGHT,
                },
            }}
        >
            {/* Drag strip pinned to the drawer's very top edge — drag up/down to
                resize. Fixed inside the drawer so it stays put as the body scrolls. */}
            <div
                onPointerDown={onHandlePointerDown}
                title="Drag to resize"
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: RESIZE_HANDLE_HEIGHT,
                    cursor: 'ns-resize',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    touchAction: 'none',
                    zIndex: 2,
                }}
            >
                <div
                    style={{
                        width: 44,
                        height: 4,
                        borderRadius: 2,
                        background: 'rgba(255,255,255,0.28)',
                    }}
                />
            </div>
            {/* Close × in the terminal's top-right corner (replaces the removed header
                button). Above the drag strip's z-index so it stays clickable. */}
            <button
                type="button"
                onClick={onClose}
                title="Close companion"
                aria-label="Close companion"
                style={{
                    position: 'absolute',
                    top: RESIZE_HANDLE_HEIGHT - 2,
                    right: 10,
                    zIndex: 3,
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    color: 'rgba(255,255,255,0.55)',
                    fontSize: 18,
                    lineHeight: 1,
                    cursor: 'pointer',
                    padding: 4,
                }}
            >
                ✕
            </button>
            {spawnError ? (
                <Alert color="red" mb="sm">
                    {spawnError}
                </Alert>
            ) : null}
            {browserGone && !spawnError ? (
                <Alert color="yellow" mb="sm">
                    The run stopped, so this companion can no longer drive the browser. The
                    conversation is intact — ask about the finished run. Starting a new run gives
                    you a fresh companion attached to its browser.
                </Alert>
            ) : null}
            {entered ? (
                <div style={{ width: '100%', height: '100%' }}>
                    {/* On PTY exit (Claude quit, or the session was evicted by the
                        other tab), drop our spawn state so reopening respawns a fresh
                        companion instead of showing a dead terminal. */}
                    <Terminal onExit={resetSpawn} />
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

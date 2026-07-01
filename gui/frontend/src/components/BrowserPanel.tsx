import { useEffect, useRef } from 'react'
import { connectScreencast, type InputEvent, type MouseButton, type ConsoleLine } from '../lib/screencast'

const BUTTON: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' }

// Live browser view: paints screencast frames (ImageBitmaps) into a canvas and
// (when interactive) forwards mouse/keyboard back to the real Chromium.
// Coordinates are mapped from the canvas's displayed size to the frame's device
// pixels. ONE WebSocket per mount, shared by frames + input.
export function BrowserPanel({
    port,
    interactive = true,
    onUrl,
    onConsole,
}: {
    port: number
    interactive?: boolean
    onUrl?: (url: string) => void
    onConsole?: (line: ConsoleLine) => void
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const frameSize = useRef({ w: 1280, h: 720 })
    const clientRef = useRef<ReturnType<typeof connectScreencast> | null>(null)
    // Held in refs so a changing callback doesn't tear down the socket.
    const onUrlRef = useRef(onUrl)
    onUrlRef.current = onUrl
    const onConsoleRef = useRef(onConsole)
    onConsoleRef.current = onConsole

    useEffect(() => {
        const client = connectScreencast(port)
        clientRef.current = client
        const canvas = canvasRef.current!
        const ctx = canvas.getContext('2d')!

        client.onFrame((bitmap) => {
            frameSize.current = { w: bitmap.width, h: bitmap.height }
            if (canvas.width !== bitmap.width) canvas.width = bitmap.width
            if (canvas.height !== bitmap.height) canvas.height = bitmap.height
            ctx.drawImage(bitmap, 0, 0)
            bitmap.close() // free the decoded frame promptly
        })

        // Surface the live page's URL (on connect + each navigation) to the parent.
        client.onUrl((url) => onUrlRef.current?.(url))

        // Surface each live console line to the parent (accumulated in RunScreen).
        client.onConsole((line) => onConsoleRef.current?.(line))

        // Mirror the real page's cursor onto the canvas (engine samples it on
        // move). Non-interactive views never send moves, so this stays quiet.
        if (interactive) client.onCursor((value) => (canvas.style.cursor = value))

        // Clipboard sync (page→GUI): when the user copies in the live page, the
        // engine sends the copied text here — mirror it into the OS clipboard.
        if (interactive) client.onClipboard((value) => void navigator.clipboard.writeText(value).catch(() => {}))

        return () => {
            client.close()
            clientRef.current = null
        }
    }, [port, interactive])

    // Wheel must be a non-passive native listener so preventDefault() actually
    // stops the surrounding GUI pane from scrolling — React's onWheel is passive.
    useEffect(() => {
        if (!interactive) return
        const canvas = canvasRef.current!
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const { x, y } = toFrameCoords(e)
            clientRef.current?.send({ kind: 'mouse', action: 'wheel', x, y, button: 'none', deltaX: e.deltaX, deltaY: e.deltaY })
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
    }, [interactive])

    // Map a DOM event on the (CSS-scaled) canvas to frame device-pixel coords.
    const toFrameCoords = (e: { clientX: number; clientY: number }) => {
        const canvas = canvasRef.current!
        const rect = canvas.getBoundingClientRect()
        const x = ((e.clientX - rect.left) / rect.width) * frameSize.current.w
        const y = ((e.clientY - rect.top) / rect.height) * frameSize.current.h
        return { x: Math.round(x), y: Math.round(y) }
    }

    const handlers = interactive
        ? {
              onMouseDown: (e: React.MouseEvent) => emitMouse('down', e),
              onMouseUp: (e: React.MouseEvent) => emitMouse('up', e),
              onMouseMove: (e: React.MouseEvent) => emitMouse('move', e),
              onKeyDown: (e: React.KeyboardEvent) => emitKey('down', e),
              onKeyUp: (e: React.KeyboardEvent) => emitKey('up', e),
              tabIndex: 0, // make the canvas focusable for keyboard events
          }
        : {}

    function emitMouse(action: 'down' | 'up' | 'move', e: React.MouseEvent) {
        const { x, y } = toFrameCoords(e)
        const ev: InputEvent = { kind: 'mouse', action, x, y, button: BUTTON[e.button] ?? 'left' }
        clientRef.current?.send(ev)
    }
    function emitKey(action: 'down' | 'up', e: React.KeyboardEvent) {
        // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. Forwarded so
        // shortcuts (Cmd/Ctrl+A, +C, …) reach the page as real modified keys.
        const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

        // Clipboard shortcuts get special handling on key-down: a synthetic
        // Cmd/Ctrl+V dispatched via CDP doesn't actually paste, and a page copy
        // never reaches the OS clipboard on its own. Intercept them to bridge
        // the two clipboards explicitly. (mod = Cmd on mac, Ctrl elsewhere.)
        const mod = e.metaKey || e.ctrlKey
        if (mod && !e.shiftKey && !e.altKey) {
            const key = e.key.toLowerCase()
            if (key === 'v') {
                // Paste (GUI→page): read the OS clipboard and inject it into the
                // page. A synthetic Cmd/Ctrl+V dispatched via CDP doesn't paste,
                // so don't forward the raw keystroke — insertText does the paste.
                if (action === 'down') {
                    e.preventDefault()
                    void navigator.clipboard
                        .readText()
                        .then((value) => value && clientRef.current?.send({ kind: 'clipboard-write', value }))
                        .catch(() => {})
                }
                return
            }
            if (key === 'c' || key === 'x') {
                // Copy/cut (page→GUI): forward the keystroke (with the modifier)
                // so the page performs its native copy/cut, then pull the result
                // back to the OS clipboard. The delay lets the selection settle.
                clientRef.current?.send({ kind: 'key', action, key: e.key, code: e.code, modifiers })
                if (action === 'down') setTimeout(() => clientRef.current?.send({ kind: 'clipboard-read' }), 60)
                return
            }
        }
        const text = action === 'down' && e.key.length === 1 ? e.key : undefined
        clientRef.current?.send({ kind: 'key', action, key: e.key, code: e.code, text, modifiers })
    }

    // Initial cursor: 'default' for interactive views (the engine overrides it
    // live via onCursor); non-interactive views get a plain arrow, no forwarding.
    return <canvas ref={canvasRef} {...handlers} style={{ width: '100%', display: 'block', outline: 'none', cursor: 'default' }} />
}

import { useEffect, useRef } from 'react'
import { connectScreencast, type InputEvent, type MouseButton } from '../lib/screencast'

const BUTTON: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' }

// Live browser view: paints screencast frames (ImageBitmaps) into a canvas and
// (when interactive) forwards mouse/keyboard back to the real Chromium.
// Coordinates are mapped from the canvas's displayed size to the frame's device
// pixels. ONE WebSocket per mount, shared by frames + input.
export function BrowserPanel({ port, interactive = true }: { port: number; interactive?: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const frameSize = useRef({ w: 1280, h: 720 })
    const clientRef = useRef<ReturnType<typeof connectScreencast> | null>(null)

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

        return () => {
            client.close()
            clientRef.current = null
        }
    }, [port])

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
              onWheel: (e: React.WheelEvent) => emitWheel(e),
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
    function emitWheel(e: React.WheelEvent) {
        const { x, y } = toFrameCoords(e)
        clientRef.current?.send({ kind: 'mouse', action: 'wheel', x, y, button: 'none', deltaX: e.deltaX, deltaY: e.deltaY })
    }
    function emitKey(action: 'down' | 'up', e: React.KeyboardEvent) {
        const text = action === 'down' && e.key.length === 1 ? e.key : undefined
        clientRef.current?.send({ kind: 'key', action, key: e.key, code: e.code, text })
    }

    return <canvas ref={canvasRef} {...handlers} style={{ width: '100%', border: '1px solid #ccc', outline: 'none' }} />
}

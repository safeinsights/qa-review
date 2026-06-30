// ws client for the live browser view. Frames arrive as BINARY messages (raw
// JPEG bytes); input goes out as JSON text. Input-event shapes mirror the
// engine's screencast-codec (kept in sync by hand — small + stable).
export type MouseButton = 'left' | 'right' | 'middle' | 'none'
export type InputEvent =
    | { kind: 'mouse'; action: 'down' | 'up' | 'move' | 'wheel'; x: number; y: number; button: MouseButton; deltaX?: number; deltaY?: number }
    | { kind: 'key'; action: 'down' | 'up'; key: string; code: string; text?: string }

export interface ScreencastClient {
    // Called with each decoded frame as an ImageBitmap (ready to drawImage).
    onFrame(cb: (bitmap: ImageBitmap) => void): void
    send(ev: InputEvent): void
    close(): void
}

export function connectScreencast(port: number): ScreencastClient {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.binaryType = 'arraybuffer'
    let frameCb: ((b: ImageBitmap) => void) | null = null
    ws.onmessage = async (e) => {
        if (!(e.data instanceof ArrayBuffer) || !frameCb) return
        try {
            // createImageBitmap decodes the JPEG off the main thread; far cheaper
            // than a base64 data-URI <img> per frame.
            const bitmap = await createImageBitmap(new Blob([e.data], { type: 'image/jpeg' }))
            frameCb(bitmap)
        } catch {
            /* drop undecodable frame */
        }
    }
    return {
        onFrame(cb) {
            frameCb = cb
        },
        send(ev) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev))
        },
        close() {
            ws.close()
        },
    }
}

// ws client for the live browser view. Frames arrive as BINARY messages (raw
// JPEG bytes); input goes out as JSON text. Input-event shapes mirror the
// engine's screencast-codec (kept in sync by hand — small + stable).
// One captured browser-console line (mirrors the engine's ConsoleLine in
// src/engine/screencast-codec.ts — kept in sync by hand).
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
export interface ConsoleLine {
    level: ConsoleLevel
    text: string
    at: number
    url?: string
}

export type MouseButton = 'left' | 'right' | 'middle' | 'none'
export type InputEvent =
    | {
          kind: 'mouse'
          action: 'down' | 'up' | 'move' | 'wheel'
          x: number
          y: number
          button: MouseButton
          deltaX?: number
          deltaY?: number
      }
    // `modifiers` is the CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).
    | {
          kind: 'key'
          action: 'down' | 'up'
          key: string
          code: string
          text?: string
          modifiers?: number
      }
    // Clipboard sync (GUI→page): the user pasted `value` into the live page.
    | { kind: 'clipboard-write'; value: string }
    // Clipboard sync (page→GUI): ask the engine for the page's current copy.
    | { kind: 'clipboard-read' }

export interface ScreencastClient {
    // Called with each decoded frame as an ImageBitmap (ready to drawImage).
    onFrame(cb: (bitmap: ImageBitmap) => void): void
    // Called with the CSS cursor value the real page shows under the pointer
    // (engine samples it on mouse-move — no native CDP cursor event exists).
    onCursor(cb: (value: string) => void): void
    // Called with the page's top-frame URL: once on connect, then on every
    // main-frame navigation.
    onUrl(cb: (value: string) => void): void
    // Called with text the remote page copied (reply to a 'clipboard-read'
    // send), so the caller can mirror it into the OS clipboard.
    onClipboard(cb: (value: string) => void): void
    // Called with each live console line the page emits (console.* + page errors).
    onConsole(cb: (line: ConsoleLine) => void): void
    send(ev: InputEvent): void
    close(): void
}

export function connectScreencast(port: number): ScreencastClient {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.binaryType = 'arraybuffer'
    let frameCb: ((b: ImageBitmap) => void) | null = null
    let cursorCb: ((value: string) => void) | null = null
    let urlCb: ((value: string) => void) | null = null
    let clipboardCb: ((value: string) => void) | null = null
    let consoleCb: ((line: ConsoleLine) => void) | null = null
    ws.onmessage = async e => {
        // Text messages are control JSON (cursor / url / clipboard / console
        // updates); binary messages are JPEG frames.
        if (typeof e.data === 'string') {
            try {
                const msg = JSON.parse(e.data)
                if (msg?.type === 'cursor' && typeof msg.value === 'string') cursorCb?.(msg.value)
                else if (msg?.type === 'url' && typeof msg.value === 'string') urlCb?.(msg.value)
                else if (msg?.type === 'clipboard' && typeof msg.value === 'string')
                    clipboardCb?.(msg.value)
                else if (msg?.type === 'console' && msg.line && typeof msg.line.text === 'string')
                    consoleCb?.(msg.line as ConsoleLine)
            } catch {
                /* ignore malformed control message */
            }
            return
        }
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
        onCursor(cb) {
            cursorCb = cb
        },
        onUrl(cb) {
            urlCb = cb
        },
        onClipboard(cb) {
            clipboardCb = cb
        },
        onConsole(cb) {
            consoleCb = cb
        },
        send(ev) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev))
        },
        close() {
            ws.close()
        },
    }
}

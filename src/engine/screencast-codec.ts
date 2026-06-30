// Pure transforms for the live-view screencast. Frames travel as BINARY ws
// messages (raw JPEG bytes), so the only frame-side transform is decoding CDP's
// base64 into a Buffer. Input travels as JSON text → parsed + mapped to CDP
// Input.dispatch* params. No I/O, so unit-testable.

// Shape of the metadata CDP attaches to each screencastFrame (kept for the
// server's coordinate/sizing needs; not part of the binary frame payload).
export interface CdpFrameMeta {
    offsetTop: number
    pageScaleFactor: number
    deviceWidth: number
    deviceHeight: number
}

// Decode CDP's base64 screencast data into the raw JPEG bytes we send as a
// binary ws message (the webview decodes them with createImageBitmap).
export function frameBytes(base64Data: string): Buffer {
    return Buffer.from(base64Data, 'base64')
}

export type MouseButton = 'left' | 'right' | 'middle' | 'none'

export type InputEvent =
    | { kind: 'mouse'; action: 'down' | 'up' | 'move' | 'wheel'; x: number; y: number; button: MouseButton; deltaX?: number; deltaY?: number }
    | { kind: 'key'; action: 'down' | 'up'; key: string; code: string; text?: string }

// Parse an inbound JSON input message from the webview; null if malformed or not
// a recognized input kind (so the server can ignore junk safely).
export function parseInput(raw: string): InputEvent | null {
    let obj: unknown
    try {
        obj = JSON.parse(raw)
    } catch {
        return null
    }
    if (obj && typeof obj === 'object') {
        const kind = (obj as { kind?: unknown }).kind
        if (kind === 'mouse' || kind === 'key') return obj as InputEvent
    }
    return null
}

export interface CdpMouseParams {
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
    x: number
    y: number
    button: MouseButton
    buttons: number
    clickCount: number
    deltaX?: number
    deltaY?: number
}

const MOUSE_TYPE = {
    down: 'mousePressed',
    up: 'mouseReleased',
    move: 'mouseMoved',
    wheel: 'mouseWheel',
} as const

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4, none: 0 }

export function toCdpMouse(ev: Extract<InputEvent, { kind: 'mouse' }>): CdpMouseParams {
    const pressed = ev.action === 'down'
    const params: CdpMouseParams = {
        type: MOUSE_TYPE[ev.action],
        x: ev.x,
        y: ev.y,
        button: ev.button,
        buttons: pressed ? BUTTON_MASK[ev.button] : 0,
        clickCount: ev.action === 'down' || ev.action === 'up' ? 1 : 0,
    }
    if (ev.action === 'wheel') {
        params.deltaX = ev.deltaX ?? 0
        params.deltaY = ev.deltaY ?? 0
    }
    return params
}

export interface CdpKeyParams {
    type: 'keyDown' | 'keyUp'
    key: string
    code: string
    text?: string
}

export function toCdpKey(ev: Extract<InputEvent, { kind: 'key' }>): CdpKeyParams {
    const params: CdpKeyParams = {
        type: ev.action === 'down' ? 'keyDown' : 'keyUp',
        key: ev.key,
        code: ev.code,
    }
    if (ev.action === 'down' && ev.text) params.text = ev.text
    return params
}

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

// Outbound engine→webview message carrying the CSS cursor the real page shows
// under the pointer (there's no native CDP cursor event, so the engine samples
// getComputedStyle().cursor on mouse-move). Sent as JSON text; frames stay
// binary. The webview applies `value` to the canvas's CSS cursor.
export interface CursorMessage {
    type: 'cursor'
    value: string
}

// Serialize a cursor update for the ws text channel. Blank/whitespace values
// fall back to 'default' so the canvas always has a valid CSS cursor.
export function cursorMessage(value: string): string {
    const v = value.trim()
    return JSON.stringify({ type: 'cursor', value: v || 'default' } satisfies CursorMessage)
}

// Outbound engine→webview message carrying the current top-frame URL of the
// live page. Sent on connect and on every main-frame navigation so the live
// view can display where the browser is. Same JSON text channel as cursor.
export interface UrlMessage {
    type: 'url'
    value: string
}

// Serialize a URL update for the ws text channel.
export function urlMessage(value: string): string {
    return JSON.stringify({ type: 'url', value } satisfies UrlMessage)
}

// Outbound engine→webview message carrying text the remote page copied, so the
// webview can mirror it into the OS clipboard (clipboard sync, page→GUI). Sent
// in reply to a 'clipboard-read' request. Same JSON text channel as cursor/url.
export interface ClipboardMessage {
    type: 'clipboard'
    value: string
}

// Serialize a clipboard update for the ws text channel.
export function clipboardMessage(value: string): string {
    return JSON.stringify({ type: 'clipboard', value } satisfies ClipboardMessage)
}

// One captured browser-console entry — a console.* call or an uncaught page
// error. Shared shape used both for the live stream (ConsoleMessage below) and
// for per-step capture in the run bundle (StepEvent.console). Kept in sync with
// the frontend copy in gui/frontend/src/lib/screencast.ts by hand.
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
export interface ConsoleLine {
    level: ConsoleLevel
    text: string
    at: number // epoch ms
    url?: string // source location, best-effort
}

// Collapse Playwright's console message types (log|info|warning|error|debug|
// trace|dir|table|…) into our five levels. Unknown types fall back to 'log'.
export function mapConsoleLevel(type: string): ConsoleLevel {
    switch (type) {
        case 'error':
        case 'warn':
        case 'info':
        case 'debug':
        case 'log':
            return type
        case 'warning':
            return 'warn'
        case 'trace':
            return 'debug'
        default:
            return 'log'
    }
}

// Outbound engine→webview message carrying one live console line, so the webview
// can show the page's console beneath the live browser. Same JSON text channel
// as cursor/url/clipboard.
export interface ConsoleMessage {
    type: 'console'
    line: ConsoleLine
}

// Serialize a console line for the ws text channel.
export function consoleMessage(line: ConsoleLine): string {
    return JSON.stringify({ type: 'console', line } satisfies ConsoleMessage)
}

export type MouseButton = 'left' | 'right' | 'middle' | 'none'

export type InputEvent =
    | { kind: 'mouse'; action: 'down' | 'up' | 'move' | 'wheel'; x: number; y: number; button: MouseButton; deltaX?: number; deltaY?: number }
    // `modifiers` is the CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8) so
    // shortcuts (Cmd/Ctrl+A, +C, …) reach the page as real modified keystrokes.
    | { kind: 'key'; action: 'down' | 'up'; key: string; code: string; text?: string; modifiers?: number }
    // Clipboard sync (GUI→page): the webview pasted `value` into the page.
    | { kind: 'clipboard-write'; value: string }
    // Clipboard sync (page→GUI): the webview asks for the page's current copy
    // (selection / clipboard); the engine replies with a ClipboardMessage.
    | { kind: 'clipboard-read' }

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
        if (kind === 'mouse' || kind === 'key' || kind === 'clipboard-read') return obj as InputEvent
        if (kind === 'clipboard-write' && typeof (obj as { value?: unknown }).value === 'string') return obj as InputEvent
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
    modifiers?: number
}

export function toCdpKey(ev: Extract<InputEvent, { kind: 'key' }>): CdpKeyParams {
    const params: CdpKeyParams = {
        type: ev.action === 'down' ? 'keyDown' : 'keyUp',
        key: ev.key,
        code: ev.code,
    }
    if (ev.modifiers) params.modifiers = ev.modifiers
    // A modified key (e.g. Cmd+C) is a shortcut, not text — only emit `text`
    // when no non-shift modifier is held, so shortcuts don't insert characters.
    const nonShift = (ev.modifiers ?? 0) & ~8 // strip Shift (8)
    if (ev.action === 'down' && ev.text && !nonShift) params.text = ev.text
    return params
}

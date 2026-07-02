import type { Frame, Page, ConsoleMessage as PwConsoleMessage } from '@playwright/test'
import { type WebSocket, WebSocketServer } from 'ws'
import {
    type CdpFrameMeta,
    type ConsoleLine,
    clipboardMessage,
    consoleMessage,
    cursorMessage,
    frameBytes,
    mapConsoleLevel,
    parseInput,
    toCdpKey,
    toCdpMouse,
    urlMessage,
} from '@/engine/screencast-codec'

// Minimal typed escape hatch for raw CDP methods/events that Playwright's
// CDPSession typing doesn't surface (Page.screencastFrame/Ack, Page.start/
// stopScreencast, and the Runtime.evaluate result shape). We narrow the event
// payload inside each handler rather than typing `args` loosely.
type RawCdp = {
    on(event: string, cb: (...args: unknown[]) => void): void
    send(method: string, params?: object): Promise<{ result?: { value?: unknown } }>
}

// The Page.screencastFrame event payload we care about.
type ScreencastFrame = { data: string; metadata: CdpFrameMeta; sessionId: number }

// Hosts a localhost WebSocket that streams live JPEG frames from `page` (via CDP
// Page.startScreencast) to a connected webview, and replays input events the
// webview sends back (via CDP Input.dispatch*). Dedicated transport so frames
// never touch the NDJSON stdout stream or the Go event bus.
export class ScreencastServer {
    private wss: WebSocketServer
    readonly port: number
    private clients = new Set<WebSocket>()
    // Full console history since the server started — buffered so a webview that
    // connects AFTER the page loaded (the common case: connect happens post-login)
    // still gets the early lines (e.g. the on-load Clerk warning), replayed on
    // connect. Capped so a chatty page can't grow it unbounded.
    private consoleHistory: ConsoleLine[] = []
    private static CONSOLE_HISTORY_CAP = 1000

    private constructor(wss: WebSocketServer, port: number) {
        this.wss = wss
        this.port = port
    }

    // Start on an ephemeral port (0 = OS-assigned). Returns once listening.
    static async start(page: Page): Promise<ScreencastServer> {
        const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
        await new Promise<void>(resolve => wss.once('listening', () => resolve()))
        const addr = wss.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        const server = new ScreencastServer(wss, port)
        server.wireConsole(page)
        server.wire(page)
        return server
    }

    // Attach the page console listeners ONCE, at start() time (i.e. as soon as the
    // page exists), rather than per-connection — so lines emitted before any
    // webview connects are captured into history and replayed on connect. Live
    // lines broadcast to every currently-connected client.
    private wireConsole(page: Page) {
        const record = (line: ConsoleLine) => {
            this.consoleHistory.push(line)
            if (this.consoleHistory.length > ScreencastServer.CONSOLE_HISTORY_CAP)
                this.consoleHistory.shift()
            const msg = consoleMessage(line)
            for (const c of this.clients) if (c.readyState === c.OPEN) c.send(msg)
        }
        page.on('console', (msg: PwConsoleMessage) =>
            record({
                level: mapConsoleLevel(msg.type()),
                text: msg.text(),
                at: Date.now(),
                url: msg.location()?.url,
            })
        )
        page.on('pageerror', (err: Error) =>
            record({ level: 'error', text: String(err?.stack || err), at: Date.now() })
        )
    }

    private wire(page: Page) {
        this.wss.on('connection', async (socket: WebSocket) => {
            this.clients.add(socket)
            socket.on('close', () => this.clients.delete(socket))

            // Push the top-frame URL so the live view shows where the browser
            // is: once on connect, then on every main-frame navigation.
            const sendUrl = () => {
                if (socket.readyState === socket.OPEN) socket.send(urlMessage(page.url()))
            }
            sendUrl()
            const onNav = (frame: Frame) => {
                if (frame === page.mainFrame()) sendUrl()
            }
            page.on('framenavigated', onNav)
            socket.on('close', () => page.off('framenavigated', onNav))

            // Replay the console history captured since the page loaded, so a
            // webview that connects after load still sees the early lines. Live
            // lines arrive via wireConsole()'s broadcast (attached at start()).
            for (const line of this.consoleHistory) {
                if (socket.readyState === socket.OPEN) socket.send(consoleMessage(line))
            }

            const cdp = await page.context().newCDPSession(page)
            const raw = cdp as unknown as RawCdp

            // Frame device-pixels ÷ pageScaleFactor = CSS px. CDP screencast
            // coords (and the ones the webview sends) are device pixels; the DOM
            // hit-test below wants CSS px. Kept fresh from each frame's metadata.
            let pageScaleFactor = 1

            raw.on('Page.screencastFrame', (...args: unknown[]) => {
                const frame = args[0] as ScreencastFrame
                void (async () => {
                    if (frame.metadata?.pageScaleFactor)
                        pageScaleFactor = frame.metadata.pageScaleFactor
                    if (socket.readyState === socket.OPEN) {
                        // Send raw JPEG bytes as a BINARY ws message (no base64/JSON).
                        socket.send(frameBytes(frame.data))
                    }
                    // Ack so Chromium keeps sending (backpressure control).
                    await raw
                        .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
                        .catch(() => {})
                })()
            })

            await raw
                .send('Page.startScreencast', {
                    format: 'jpeg',
                    quality: 70,
                    maxWidth: 1280,
                    maxHeight: 720,
                    everyNthFrame: 1,
                })
                .catch(() => {})

            // CDP has no cursor-changed event, so we sample the CSS cursor under
            // the pointer via getComputedStyle on each mouse-move and push it to
            // the webview only when it changes. single-flight guards against a
            // fast move stream (moves aren't throttled) piling up evaluates.
            let lastCursor = ''
            let sampling = false
            const sampleCursor = async (x: number, y: number) => {
                if (sampling) return
                sampling = true
                try {
                    const cssX = x / pageScaleFactor
                    const cssY = y / pageScaleFactor
                    const res = await raw.send('Runtime.evaluate', {
                        expression: `(() => { const el = document.elementFromPoint(${cssX}, ${cssY}); return el ? getComputedStyle(el).cursor : 'default'; })()`,
                        returnByValue: true,
                    })
                    const value = res.result?.value
                    if (
                        typeof value === 'string' &&
                        value !== lastCursor &&
                        socket.readyState === socket.OPEN
                    ) {
                        lastCursor = value
                        socket.send(cursorMessage(value))
                    }
                } catch {
                    // cursor sampling is best-effort; never crash the run
                } finally {
                    sampling = false
                }
            }

            // Read whatever the remote page has "copied" — the live selection if
            // there is one, else the page's async clipboard — so the webview can
            // mirror it into the OS clipboard. Selection is the reliable signal
            // (a programmatic copy with no selection can't always be observed).
            const readPageClipboard = async (): Promise<string> => {
                const sel = await page
                    .evaluate(() => window.getSelection?.()?.toString() ?? '')
                    .catch(() => '')
                if (sel) return sel
                return page
                    .evaluate(() => navigator.clipboard.readText().catch(() => ''))
                    .catch(() => '')
            }

            socket.on('message', async raw => {
                // Input arrives as JSON text; ignore the binary frames we sent.
                const ev = parseInput(raw.toString())
                if (!ev) return
                try {
                    if (ev.kind === 'mouse') {
                        await cdp.send('Input.dispatchMouseEvent', toCdpMouse(ev))
                        if (ev.action === 'move') void sampleCursor(ev.x, ev.y)
                    } else if (ev.kind === 'key') {
                        await cdp.send('Input.dispatchKeyEvent', toCdpKey(ev))
                    } else if (ev.kind === 'clipboard-write') {
                        // GUI→page paste: type the pasted text into the focused
                        // element (CDP insertText composes it as real input).
                        await cdp.send('Input.insertText', { text: ev.value })
                    } else if (ev.kind === 'clipboard-read') {
                        // page→GUI copy: reply with the page's current copy so the
                        // webview writes it to the OS clipboard.
                        const value = await readPageClipboard()
                        if (value && socket.readyState === socket.OPEN)
                            socket.send(clipboardMessage(value))
                    }
                } catch {
                    // input replay best-effort; never crash the run
                }
            })

            socket.on('close', async () => {
                await raw.send('Page.stopScreencast').catch(() => {})
                await cdp.detach().catch(() => {})
            })
        })
    }

    // Keep the server open after the run so the GUI panel finishes showing the
    // live view. Resolves when: no client ever connects (short wait), the
    // connected client(s) disconnect, or `graceMs` elapses — whichever first.
    async waitForClientThenClose(graceMs: number): Promise<void> {
        // Give a late-connecting client a moment to attach first.
        await new Promise(r => setTimeout(r, 1000))
        if (this.clients.size === 0) return // nobody watching → don't hold the run open

        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, graceMs)
            const check = () => {
                if (this.clients.size === 0) {
                    clearTimeout(timer)
                    resolve()
                }
            }
            for (const c of this.clients) c.on('close', check)
        })
    }

    async close(): Promise<void> {
        await new Promise<void>(resolve => this.wss.close(() => resolve()))
    }
}

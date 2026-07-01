import { WebSocketServer, type WebSocket } from 'ws'
import type { Page, Frame } from '@playwright/test'
import { frameBytes, parseInput, toCdpMouse, toCdpKey, cursorMessage, urlMessage, clipboardMessage, type CdpFrameMeta } from '@/engine/screencast-codec'

// Hosts a localhost WebSocket that streams live JPEG frames from `page` (via CDP
// Page.startScreencast) to a connected webview, and replays input events the
// webview sends back (via CDP Input.dispatch*). Dedicated transport so frames
// never touch the NDJSON stdout stream or the Go event bus.
export class ScreencastServer {
    private wss: WebSocketServer
    readonly port: number
    private clients = new Set<WebSocket>()

    private constructor(wss: WebSocketServer, port: number) {
        this.wss = wss
        this.port = port
    }

    // Start on an ephemeral port (0 = OS-assigned). Returns once listening.
    static async start(page: Page): Promise<ScreencastServer> {
        const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
        await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
        const addr = wss.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        const server = new ScreencastServer(wss, port)
        server.wire(page)
        return server
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

            const cdp = await page.context().newCDPSession(page)

            // Frame device-pixels ÷ pageScaleFactor = CSS px. CDP screencast
            // coords (and the ones the webview sends) are device pixels; the DOM
            // hit-test below wants CSS px. Kept fresh from each frame's metadata.
            let pageScaleFactor = 1

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(cdp as any).on('Page.screencastFrame', async (frame: { data: string; metadata: CdpFrameMeta; sessionId: number }) => {
                if (frame.metadata?.pageScaleFactor) pageScaleFactor = frame.metadata.pageScaleFactor
                if (socket.readyState === socket.OPEN) {
                    // Send raw JPEG bytes as a BINARY ws message (no base64/JSON).
                    socket.send(frameBytes(frame.data))
                }
                // Ack so Chromium keeps sending (backpressure control).
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (cdp as any).send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
            })

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (cdp as any)
                .send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 })
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
                    const res = await cdp.send('Runtime.evaluate', {
                        expression: `(() => { const el = document.elementFromPoint(${cssX}, ${cssY}); return el ? getComputedStyle(el).cursor : 'default'; })()`,
                        returnByValue: true,
                    })
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const value = (res as any)?.result?.value
                    if (typeof value === 'string' && value !== lastCursor && socket.readyState === socket.OPEN) {
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
                const sel = await page.evaluate(() => (window.getSelection?.()?.toString() ?? '')).catch(() => '')
                if (sel) return sel
                return page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '')
            }

            socket.on('message', async (raw) => {
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
                        if (value && socket.readyState === socket.OPEN) socket.send(clipboardMessage(value))
                    }
                } catch {
                    // input replay best-effort; never crash the run
                }
            })

            socket.on('close', async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (cdp as any).send('Page.stopScreencast').catch(() => {})
                await cdp.detach().catch(() => {})
            })
        })
    }

    // Keep the server open after the run so the GUI panel finishes showing the
    // live view. Resolves when: no client ever connects (short wait), the
    // connected client(s) disconnect, or `graceMs` elapses — whichever first.
    async waitForClientThenClose(graceMs: number): Promise<void> {
        // Give a late-connecting client a moment to attach first.
        await new Promise((r) => setTimeout(r, 1000))
        if (this.clients.size === 0) return // nobody watching → don't hold the run open

        await new Promise<void>((resolve) => {
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
        await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    }
}

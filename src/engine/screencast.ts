import { WebSocketServer, type WebSocket } from 'ws'
import type { Page } from '@playwright/test'
import { frameBytes, parseInput, toCdpMouse, toCdpKey, type CdpFrameMeta } from '@/engine/screencast-codec'

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
            const cdp = await page.context().newCDPSession(page)

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(cdp as any).on('Page.screencastFrame', async (frame: { data: string; metadata: CdpFrameMeta; sessionId: number }) => {
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

            socket.on('message', async (raw) => {
                // Input arrives as JSON text; ignore the binary frames we sent.
                const ev = parseInput(raw.toString())
                if (!ev) return
                try {
                    if (ev.kind === 'mouse') {
                        await cdp.send('Input.dispatchMouseEvent', toCdpMouse(ev))
                    } else if (ev.kind === 'key') {
                        await cdp.send('Input.dispatchKeyEvent', toCdpKey(ev))
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

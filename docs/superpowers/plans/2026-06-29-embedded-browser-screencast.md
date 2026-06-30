# Embedded Live Browser (CDP Screencast) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the live Playwright-driven Chromium *embedded inside the QA Runner GUI window* (a panel), instead of as a separate OS window — interactive (the tester can click/type into it) — while keeping the Wails (Go) + Playwright (Node) stack.

**Architecture:** During a run, the Node engine attaches a CDP session to the Playwright page and calls `Page.startScreencast`, receiving base64 JPEG frames. The run process hosts a **local WebSocket server** dedicated to the live view. Frames are sent as **binary WebSocket messages** (raw JPEG bytes — no base64/JSON wrapper) for minimal per-frame CPU and ~33% less data; input events flow back as small **JSON text** messages on the same socket (they need ordering/structure, and are tiny). The React panel connects to that WebSocket directly (bypassing the Go event bus, which is unsuited to high-frequency frames), decodes each binary frame via `createImageBitmap` and paints it into a `<canvas>`, and forwards mouse/keyboard events. The existing NDJSON step/result stream over stdout is unchanged.

**Tech Stack:** Playwright CDP (`newCDPSession` + `Page.startScreencast`/`Input.dispatch*`), a tiny Node `ws` WebSocket server in the run process, React `<canvas>` + pointer/keyboard handlers, the existing TS engine + Wails GUI.

---

## Why a dedicated WebSocket (not the existing stdout/Go event path)

The research (`docs/superpowers/specs`-adjacent: the deep-research report) flagged transport as the latency risk. Frames are ~50–100KB at 10–30fps. The current live data path is: CLI stdout (NDJSON) → Go `bufio.Scanner` → Wails `EventsEmit` → webview. That path is fine for small step events but would bottleneck on binary frames and pollute the line-oriented NDJSON contract. A direct **localhost WebSocket from the run process to the webview** keeps frames off both stdout and the Go bus, gives binary frames + low latency, and provides a back-channel for input events. The step/result NDJSON stays exactly as-is.

This is opt-in: only when the run is launched with `--screencast`, so curated CLI runs and tests are unaffected.

## Scope

Adds an embedded live-view mode. Does NOT remove the separate-window headed mode (it stays as a fallback / for non-GUI CLI use). Explicitly unchanged: the engine's suites/auth/cleanup/recorder, the NDJSON step contract, the Go backend's `RunProcess`/`GitPull`/`PromoteSuite`.

Reference: the deep-research findings (CDP screencast is the verified path; Playwright exposes `newCDPSession` + `Page.startScreencast` + `Input.dispatch*`; same Chromium stays Playwright-driven while screencasting).

This plan ends with a **latency spike checkpoint (Task 4)**: if interactive latency is unacceptable, the fallback is monitor-only (frames without input forwarding), decided there before building the full input layer.

## File Structure

```
qatest/
  src/
    engine/
      screencast.ts          NEW: ScreencastServer — CDP startScreencast → ws frames; ws input → CDP Input.dispatch*
      run-headed.ts          MODIFY: accept an optional onPage hook (so the CLI can attach screencast to the live page)
    cli/
      commands/run.ts        MODIFY: --screencast flag → start ScreencastServer for the run, print its ws port as an NDJSON {type:'screencast',port} line
    engine/types.ts          MODIFY: add ScreencastEnvelope {type:'screencast', port:number} to the stream union (so the GUI learns the port)
  tests/
    engine/screencast.test.ts  NEW: unit-test frame encoding + input-event → CDP-params mapping (pure helpers)
  gui/
    frontend/src/
      lib/screencast.ts      NEW: connectScreencast(port) — ws client, decode frames, encode input events
      components/
        BrowserPanel.tsx     NEW: <canvas> that renders frames + captures mouse/keyboard, forwards via screencast client
        RunScreen.tsx        MODIFY: when a screencast envelope arrives, show BrowserPanel in the right pane (replacing the static ResultPanel area during the run)
        SuitesTab.tsx        MODIFY: add --screencast to the run args; default ON
```

---

## Task 1: Pure screencast helpers (frame + input mapping) — TDD

**Files:**
- Create: `src/engine/screencast-codec.ts`
- Test: `tests/engine/screencast.test.ts`

**Context:** Before any I/O, build and unit-test the two pure transforms the screencast needs: (a) wrap a CDP `screencastFrame` payload into the message we send over the wire, and (b) map a browser input event (from the canvas) into CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent` params. Keeping these pure makes the risky coordinate/enum mapping testable without a browser or socket.

- [ ] **Step 1: Write the failing test** — create `tests/engine/screencast.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { frameBytes, parseInput, toCdpMouse, toCdpKey, type InputEvent } from '@/engine/screencast-codec'

describe('screencast-codec', () => {
    it('decodes a CDP base64 frame into the raw JPEG bytes to send as a binary message', () => {
        const original = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]) // JPEG-ish bytes
        const base64 = original.toString('base64')
        const bytes = frameBytes(base64)
        expect(Buffer.isBuffer(bytes)).toBe(true)
        expect(bytes.equals(original)).toBe(true)
    })

    it('parses an inbound JSON input message, rejecting malformed text', () => {
        const ev = parseInput('{"kind":"mouse","action":"down","x":1,"y":2,"button":"left"}')
        expect(ev).toEqual({ kind: 'mouse', action: 'down', x: 1, y: 2, button: 'left' })
        expect(parseInput('not json')).toBeNull()
        expect(parseInput('{"kind":"bogus"}')).toBeNull()
    })

    it('maps a mousedown input event to CDP dispatchMouseEvent params', () => {
        const ev: InputEvent = { kind: 'mouse', action: 'down', x: 100, y: 50, button: 'left' }
        expect(toCdpMouse(ev)).toEqual({
            type: 'mousePressed',
            x: 100,
            y: 50,
            button: 'left',
            buttons: 1,
            clickCount: 1,
        })
    })

    it('maps a mouseup and a mousemove correctly', () => {
        expect(toCdpMouse({ kind: 'mouse', action: 'up', x: 1, y: 2, button: 'left' }).type).toBe('mouseReleased')
        const move = toCdpMouse({ kind: 'mouse', action: 'move', x: 3, y: 4, button: 'none' })
        expect(move.type).toBe('mouseMoved')
        expect(move.button).toBe('none')
        expect(move.clickCount).toBe(0)
    })

    it('maps a wheel event with deltas', () => {
        const w = toCdpMouse({ kind: 'mouse', action: 'wheel', x: 5, y: 6, button: 'none', deltaX: 0, deltaY: 120 })
        expect(w.type).toBe('mouseWheel')
        expect(w.deltaY).toBe(120)
    })

    it('maps a keydown input event to CDP dispatchKeyEvent params', () => {
        const ev: InputEvent = { kind: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a' }
        const out = toCdpKey(ev)
        expect(out.type).toBe('keyDown')
        expect(out.key).toBe('a')
        expect(out.code).toBe('KeyA')
        expect(out.text).toBe('a')
    })

    it('maps a keyup with no text', () => {
        const out = toCdpKey({ kind: 'key', action: 'up', key: 'Enter', code: 'Enter' })
        expect(out.type).toBe('keyUp')
        expect(out.text).toBeUndefined()
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nas/code/si/qatest && pnpm test tests/engine/screencast.test.ts`
Expected: FAIL — cannot find module `@/engine/screencast-codec`.

- [ ] **Step 3: Write the implementation** — create `src/engine/screencast-codec.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/engine/screencast.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/screencast-codec.ts tests/engine/screencast.test.ts && git commit -m "feat: pure screencast codec (CDP frame + input mapping)"
```

---

## Task 2: ScreencastServer — CDP screencast ↔ WebSocket

**Files:**
- Create: `src/engine/screencast.ts`
- Test: none (I/O glue over a real Playwright page + ws; validated in the Task 4 spike)

**Context:** Wraps a Playwright `Page` in a screencast session. Opens a localhost WebSocket server on an ephemeral port. On client connect: attach a CDP session, `Page.startScreencast` (jpeg, capped fps via quality + maxWidth/Height), send each frame as a **binary** ws message of raw JPEG bytes (`frameBytes`), and ack each frame (`Page.screencastFrameAck`) for backpressure. Inbound (text) ws messages are parsed via `parseInput` → replayed via CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`. Uses the pure codec from Task 1.

- [ ] **Step 1: Add `ws` dependency**

Run: `cd /Users/nas/code/si/qatest && pnpm add ws && pnpm add -D @types/ws`
Expected: installs.

- [ ] **Step 2: Write the implementation** — create `src/engine/screencast.ts`:

```typescript
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
            const cdp = await page.context().newCDPSession(page)

            cdp.on('Page.screencastFrame', async (frame: { data: string; metadata: CdpFrameMeta; sessionId: number }) => {
                if (socket.readyState === socket.OPEN) {
                    // Send raw JPEG bytes as a BINARY ws message (no base64/JSON).
                    socket.send(frameBytes(frame.data))
                }
                // Ack so Chromium keeps sending (backpressure control).
                await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
            })

            await cdp
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
                await cdp.send('Page.stopScreencast').catch(() => {})
                await cdp.detach().catch(() => {})
            })
        })
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: exit 0. (If `@playwright/test`'s `CDPSession` typing complains about the event payload shape, type the frame handler param as shown — `{ data, metadata, sessionId }` — which matches the CDP `Page.screencastFrame` event.)

- [ ] **Step 4: Run full unit suite (screencast.ts has no unit test but must not break typecheck/build)**

Run: `pnpm test`
Expected: all pass (Task 1's 6 tests included).

- [ ] **Step 5: Commit**

```bash
git add src/engine/screencast.ts package.json pnpm-lock.yaml && git commit -m "feat: ScreencastServer (CDP screencast <-> websocket + input replay)"
```

---

## Task 3: Wire `--screencast` into the run path

**Files:**
- Modify: `src/engine/types.ts` (add the screencast stream envelope)
- Modify: `src/engine/run-headed.ts` (expose the live page via an `onPage` hook)
- Modify: `src/cli/commands/run.ts` (`--screencast` flag → start server, emit port)
- Modify: `src/cli/step-stream.ts` (serialize the screencast envelope)
- Modify: `bin/otto.ts` (add `screencast` to BOOLEANS)

**Context:** When `--screencast` is set, the run starts a `ScreencastServer` for the live page and emits one NDJSON line `{"type":"screencast","port":<n>}` so the GUI learns where to connect. The page is reached via a new `onPage` hook on the deps (the engine creates the page; the CLI needs a handle to it to attach the screencast). Headed mode is NOT required for screencast — screencast works on a headless page too (the frames ARE the view), so `--screencast` implies we can keep the browser headless (no separate window at all).

- [ ] **Step 1: Add the screencast envelope to types** — in `src/engine/types.ts`, after the `StepEvent` interface add:

```typescript
// Emitted once at run start when --screencast is active, telling the GUI which
// localhost WebSocket port to connect to for the live browser view.
export interface ScreencastInfo {
    port: number
}
```

- [ ] **Step 2: Add an `onPage` hook to RunDeps** — in `src/engine/run.ts`, add to the `RunDeps` interface (after `onStep`):

```typescript
    // Called once with the live Playwright page just after it's created, so a
    // caller (the CLI --screencast mode) can attach a screencast to it.
    onPage?: (page: import('@playwright/test').Page) => void | Promise<void>
```

And in `runEngine`, immediately after the page is obtained inside the run (the `handle = await deps.openBrowser(...)` path gives `handle.page`), call the hook. Locate where `handle` is set and add, right after the login cookie is set (after the `;(cleanup as ...).cookieHeader = cookieHeader` line):

```typescript
        await deps.onPage?.(handle.page)
```

(Placing it after login means the page has navigated to a real authenticated screen before the screencast attaches — the first frames show something meaningful.)

- [ ] **Step 3: Make `defaultDeps` and `headedDeps` forward `onPage`** — they already spread/return a deps object. In `defaultDeps()` (src/engine/run.ts), `onPage` is not set by default (undefined) — fine. In `headedDeps()` (src/engine/run-headed.ts), it spreads `...base`; ensure the caller can set `onPage` by NOT hardcoding it (it's already absent, so a caller overriding deps can add it). No code change needed beyond confirming `onPage` is part of `RunDeps` (Step 2) and thus assignable.

- [ ] **Step 4: Serialize the screencast envelope** — in `src/cli/step-stream.ts`, add:

```typescript
import type { StepEvent, RunResult, ScreencastInfo } from '@/engine/types'

// ... keep existing stepLine/resultLine/parseLine ...

export function screencastLine(info: ScreencastInfo): string {
    return JSON.stringify({ type: 'screencast', ...info }) + '\n'
}
```

And extend `parseLine`'s accepted types to include `'screencast'`:

```typescript
        if (t === 'step' || t === 'result' || t === 'screencast') return obj as Envelope
```

Add `ScreencastEnvelope` to the `Envelope` union near the top:

```typescript
export type ScreencastEnvelope = { type: 'screencast' } & ScreencastInfo
export type Envelope = StepEnvelope | ResultEnvelope | ScreencastEnvelope
```

- [ ] **Step 5: Wire `--screencast` in run.ts** — modify `src/cli/commands/run.ts`:

```typescript
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { runEngine, defaultDeps } from '@/engine/run'
import { headedDeps } from '@/engine/run-headed'
import { stepLine, resultLine, screencastLine } from '@/cli/step-stream'
import { ScreencastServer } from '@/engine/screencast'
import type { Role, StepEvent } from '@/engine/types'
import type { Page } from '@playwright/test'

export async function runCommand(opts: Record<string, string>): Promise<void> {
    const role = (opts.role ?? 'admin') as Role
    const suite = opts.suite ?? 'signin'
    const json = opts.json === 'true'
    const headed = opts.headed === 'true'
    const screencast = opts.screencast === 'true'

    const envConfig = opts.pr ? resolvePrEnv(Number(opts.pr)) : resolveEnv(opts.env ?? 'qa')

    const onStep = json ? (e: StepEvent) => process.stdout.write(stepLine(e)) : undefined

    let server: ScreencastServer | undefined
    const onPage = screencast
        ? async (page: Page) => {
              server = await ScreencastServer.start(page)
              process.stdout.write(screencastLine({ port: server.port }))
          }
        : undefined

    // Screencast IS the view, so it doesn't need a headed window. Use headed only
    // if explicitly asked AND not screencasting.
    const base = headed && !screencast ? headedDeps(onStep) : { ...defaultDeps(), onStep }
    const deps = { ...base, onPage }

    try {
        const result = await runEngine({ suite, env: envConfig.name, role, envConfig }, deps)
        if (json) {
            process.stdout.write(resultLine(result))
        } else {
            for (const s of result.steps) {
                const mark = s.status === 'passed' ? 'PASS' : s.status === 'failed' ? 'FAIL' : '...'
                console.log(mark, s.name, s.error ? `:: ${s.error}` : '')
            }
            console.log(`\nok: ${result.ok} | category: ${result.failureCategory ?? '-'}`)
            console.log(`cleanup ok: ${result.cleanup.ok}`)
            if (!result.cleanup.ok && result.cleanup.statuses) {
                console.log(`cleanup statuses: ${JSON.stringify(result.cleanup.statuses)}`)
            }
            console.log(`report: ${result.bundleDir}/report.html`)
        }
        if (!result.ok) process.exitCode = 1
    } finally {
        await server?.close()
    }
}
```

- [ ] **Step 6: Add `screencast` to BOOLEANS** — in `bin/otto.ts`:

```typescript
const BOOLEANS = ['json', 'headed', 'screencast']
```

- [ ] **Step 7: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all tests pass. (If `parseLine` tests in `tests/cli/step-stream.test.ts` assert exact envelope handling, they still pass — we only ADDED a type.)

- [ ] **Step 8: Commit**

```bash
git add src/engine/types.ts src/engine/run.ts src/cli/commands/run.ts src/cli/step-stream.ts bin/otto.ts && git commit -m "feat: --screencast run mode (starts ScreencastServer, emits ws port)"
```

---

## Task 4: Latency spike checkpoint (manual, against pr839)

**Files:** none (validation + go/no-go decision)

**Context:** Before building the React input layer, prove the frame pipeline works and measure feel. This is the research's flagged unknown (input-to-render latency through the transport). Decision gate: if frames render smoothly and clicks feel responsive → proceed to full interactive panel (Task 5). If latency is bad → fall back to monitor-only (render frames, skip input forwarding) and note it.

- [ ] **Step 1: Run a screencast run and capture the emitted port**

Run: `cd /Users/nas/code/si/qatest && pnpm otto run --json --screencast --role admin --suite create-study --pr 839 2>&1 | tee /tmp/qa-screencast.log`
Expected: among the NDJSON, a line `{"type":"screencast","port":<N>}` appears early; the run proceeds and passes its steps. (create-study is slower than signin, giving more time to observe frames.)

- [ ] **Step 2: Connect a throwaway ws client to confirm frames flow**

While a run is active (or script a longer one), connect to the port and confirm frames arrive. Quick check via a Node one-liner script `bin/screencast-probe.mjs` (throwaway, delete after):

```javascript
import WebSocket from 'ws'
const port = process.argv[2]
const ws = new WebSocket(`ws://127.0.0.1:${port}`)
let n = 0, bytes = 0, t0 = Date.now()
ws.on('message', (m) => {
    n++; bytes += m.length
    if (n % 10 === 0) console.log(`${n} frames, ${(bytes / 1024).toFixed(0)}KB total, ${(n / ((Date.now() - t0) / 1000)).toFixed(1)} fps`)
})
ws.on('open', () => console.log('connected'))
setTimeout(() => { ws.close(); process.exit(0) }, 15000)
```

Run it with the port from Step 1 (the run must be live; for a sustained source, temporarily add a `await page.waitForTimeout(20000)` to the create-study suite OR run signin in a loop). Expected: "connected", then frame counts climbing at a usable fps (aim ≥ 8–10 fps).

- [ ] **Step 3: Record the go/no-go**

Note: observed fps, frame size, and whether it's smooth. **Decision:**
- Smooth (≥ ~10fps, frames < ~150KB): proceed to Task 5 (full interactive panel).
- Choppy/laggy: proceed to Task 5 but build it **monitor-only** (render frames, omit the input-forwarding handlers), and document the limitation. Either way the panel work (Task 5) happens; this gate only decides whether to wire input.

- [ ] **Step 4: Clean up the probe**

```bash
rm -f bin/screencast-probe.mjs
```

(No commit — validation only. Revert any temporary `waitForTimeout` added to a suite.)

---

## Task 5: React BrowserPanel — render frames + forward input

**Files:**
- Create: `gui/frontend/src/lib/screencast.ts`
- Create: `gui/frontend/src/components/BrowserPanel.tsx`

**Context:** The webview side. `screencast.ts` is a thin ws client: connect to `ws://127.0.0.1:<port>`, decode `frame` messages, and send `InputEvent`s. `BrowserPanel` is a `<canvas>` that draws each frame and translates canvas pointer/keyboard events into `InputEvent`s with coordinates mapped from canvas space to the frame's device pixels. Input wiring is included if Task 4 said "smooth"; if "monitor-only", omit the event handlers (the plan notes both).

- [ ] **Step 1: Create `gui/frontend/src/lib/screencast.ts`**

```typescript
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
```

- [ ] **Step 2: Create `gui/frontend/src/components/BrowserPanel.tsx`**

```typescript
import { useEffect, useRef } from 'react'
import { connectScreencast, type InputEvent, type MouseButton } from '../lib/screencast'

const BUTTON: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' }

// Live browser view: paints screencast frames into a canvas and (when
// interactive) forwards mouse/keyboard back to the real Chromium. Coordinates
// are mapped from the canvas's displayed size to the frame's device pixels.
export function BrowserPanel({ port, interactive = true }: { port: number; interactive?: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const frameSize = useRef({ w: 1280, h: 720 })
    const clientRef = useRef<ReturnType<typeof connectScreencast> | null>(null)

    // ONE WebSocket per mount, shared by frames + input. Frames arrive as decoded
    // ImageBitmaps (binary path) and are drawn straight to the canvas.
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
```

(Single `connectScreencast(port)` per mount in one effect, stored in `clientRef` and shared by `onFrame` + the input handlers — no duplicate sockets.)

- [ ] **Step 3: Typecheck the frontend**

Run: `cd /Users/nas/code/si/qatest/gui/frontend && pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/nas/code/si/qatest && git add gui/frontend/src/lib/screencast.ts gui/frontend/src/components/BrowserPanel.tsx && git commit -m "feat: BrowserPanel — render screencast frames + forward input"
```

---

## Task 6: Show BrowserPanel in RunScreen + enable --screencast from the tabs

**Files:**
- Modify: `gui/frontend/src/components/RunScreen.tsx`
- Modify: `gui/frontend/src/components/SuitesTab.tsx`

**Context:** RunScreen already parses the NDJSON stream. Extend it to recognize the `screencast` envelope (port) and render `<BrowserPanel port={...}>` in the right pane during the run; on result, the ResultPanel takes over (or shows below). SuitesTab adds `--screencast` to the run args so curated runs use the embedded view.

- [ ] **Step 1: Update the StreamParser's envelope type** — `gui/frontend/src/lib/stepStream.ts` currently accepts `step`/`result`. Add `screencast`:

In the `Envelope` union add:
```typescript
export type ScreencastEnvelope = { type: 'screencast'; port: number }
```
and include it in `Envelope`, and in the `parse()` type-guard accept `t === 'screencast'`.

- [ ] **Step 2: Render BrowserPanel in RunScreen** — modify `gui/frontend/src/components/RunScreen.tsx`. Add a `port` state, set it when a screencast envelope arrives, and show `<BrowserPanel>` in the right pane while running:

Add import: `import { BrowserPanel } from './BrowserPanel'`

Add state: `const [port, setPort] = useState<number | null>(null)`

In the stream-handling loop, add a branch:
```typescript
                    if (env.type === 'step') setSteps((prev) => [...prev, env])
                    else if (env.type === 'screencast') setPort(env.port)
                    else {
                        setResult(env)
                        onDone?.(env)
                    }
```
Reset `setPort(null)` alongside the other resets at run start.

Change the right pane to prefer the live panel during the run, falling back to the result:
```typescript
            <div style={{ flex: 1 }}>
                {port && !result ? <BrowserPanel port={port} /> : result ? <ResultPanel result={result} /> : null}
            </div>
```

- [ ] **Step 3: Add `--screencast` to SuitesTab run args** — in `gui/frontend/src/components/SuitesTab.tsx`'s `run()`:
```typescript
        const args = ['otto', 'run', '--json', '--screencast', '--role', role, '--suite', suite]
```
(Replace the `--headed` flag with `--screencast` — the embedded view replaces the separate window. Keep `--pr`/`--env` logic as-is.)

- [ ] **Step 4: Typecheck + build the frontend**

Run: `cd /Users/nas/code/si/qatest/gui/frontend && pnpm exec tsc --noEmit && pnpm build`
Expected: exit 0; dist built.

- [ ] **Step 5: Root suite still green (no engine regressions)**

Run: `cd /Users/nas/code/si/qatest && pnpm test && pnpm typecheck`
Expected: all pass; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add gui/frontend/src/components/RunScreen.tsx gui/frontend/src/components/SuitesTab.tsx gui/frontend/src/lib/stepStream.ts && git commit -m "feat: embed live BrowserPanel in RunScreen; suites use --screencast"
```

---

## Task 7: Live end-to-end validation (manual, needs display + pr839)

**Files:** none (validation)

**Context:** Run the GUI and confirm the browser now renders INSIDE the app window, and (if Task 4 said interactive) that clicking/typing in the panel drives the real browser.

- [ ] **Step 1: Launch the app**

Run: `cd /Users/nas/code/si/qatest/gui && wails dev`
Expected: window opens; no separate Chromium window appears for a run.

- [ ] **Step 2: Run a curated suite with the embedded view**

Suites tab: PR # `839`, Role `admin`, Suite `create-study`, Run.
Expected: the right pane shows the **live browser frames inside the GUI** as the suite drives login + study creation; the checklist ticks alongside; on completion the ResultPanel + video show.

- [ ] **Step 3: Test interaction (if Task 4 = interactive)**

During a run (or a suite with a pause), click/scroll/type in the panel.
Expected: the real Chromium responds (cursor moves, fields focus, text enters). If monitor-only was chosen, confirm frames render (no input expected).

- [ ] **Step 4: Confirm no separate window + clean teardown**

Expected: no stray Chromium OS window; closing/finishing the run closes the ws (panel goes blank/last-frame); no leftover processes (`pgrep -fl 'chromium|Chrome for Testing'` empty after).

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "chore: validate embedded screencast browser view against pr839" || echo "nothing to commit"
```

---

## Self-Review notes (resolved during writing)

- **Answers the goal:** embeds the live Playwright browser in the GUI via CDP screencast (the research's verified path) — interactive, one window, stays in Wails. Tasks: pure codec (1), CDP↔ws server (2), `--screencast` wiring + port discovery (3), latency gate (4), React canvas + input (5), RunScreen integration (6), live validation (7).
- **Transport decision is explicit:** dedicated localhost WebSocket (not the Go event bus / NDJSON stdout) — directly addresses the research's flagged latency risk; frames never touch the step stream.
- **Risk gate built in:** Task 4 is a real go/no-go on interactive latency before the input layer is committed; fallback is monitor-only, stated.
- **Binary frame transport:** frames are raw JPEG bytes over a binary ws message (no base64/JSON per frame), decoded webview-side with `createImageBitmap` — the chosen optimization over base64-JSON. Input stays small JSON text on the same socket (needs ordering/structure). UDP was considered and rejected: webviews can't open raw UDP sockets, loopback negates UDP's loss/RTT wins, and frames exceed a datagram (would need self-rolled fragmentation/reliability).
- **Type/contract consistency:** the `InputEvent`/`MouseButton` shapes are defined in `src/engine/screencast-codec.ts` and mirrored in `gui/frontend/src/lib/screencast.ts` (hand-synced, small + stable — noted); frames carry no shared type (raw bytes). The `screencast` NDJSON envelope is added consistently to `src/engine/types.ts`, `src/cli/step-stream.ts`, and the GUI `stepStream.ts`. `toCdpMouse`/`toCdpKey` params match CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`.
- **No placeholders:** every file's code is shown; the BrowserPanel uses a single shared socket (one `connectScreencast` per mount).
- **Non-regression:** screencast is opt-in (`--screencast`); the existing separate-window headed mode and all NDJSON/step behavior are untouched (Task 6 Step 5 + Task 3 Step 7 are the guards). The earlier bug fixes (claude invocation, PATH, error surfacing) are unaffected.
- **Known carry-overs:** exact interactive latency is unmeasured until Task 4; keyboard mapping covers common keys (single-char text + key/code) — exotic IME/composition input is out of scope for v1 (note in Task 5).
```

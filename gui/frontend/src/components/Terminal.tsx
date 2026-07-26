import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import { onPtyExit, onPtyOutput, openExternal, resizePty, writeToPty } from '../lib/ipc'

// Embedded interactive terminal for the claude PTY. Renders raw PTY bytes and
// forwards keystrokes back to Go (which writes them to claude's pseudo-terminal),
// so claude runs fully interactively — including live permission prompts.
export function Terminal({ onExit }: { onExit?: (code: number | null) => void }) {
    const hostRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const host = hostRef.current
        if (!host) return
        const term = new XTerm({
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 13,
            theme: { background: '#0f1419' },
            cursorBlink: true,
            convertEol: true,
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        // Make URLs in claude's output clickable. The default handler would open in
        // the webview; route through the Wails runtime so links open in the user's
        // real browser instead. Log so a click that doesn't open can be diagnosed
        // (does the handler fire at all vs. does openExternal fail?).
        term.loadAddon(
            new WebLinksAddon((_event, uri) => {
                // biome-ignore lint/suspicious/noConsole: diagnostic for link-open issues
                console.debug('[Terminal] link activated:', uri)
                openExternal(uri)
            })
        )
        term.open(host)

        // Fit only when the host actually has a size. On a background tab the panel is
        // display:none (0×0); fitting then would resize the PTY to 0 cols/rows and
        // leave the terminal garbled until the next interaction. Skipping keeps the
        // last good size, and the ResizeObserver re-fits when the tab is shown again.
        const safeFit = () => {
            if (host.clientWidth === 0 || host.clientHeight === 0) return
            try {
                fit.fit()
                resizePty(term.rows, term.cols).catch(() => {})
            } catch {
                /* ignore transient layout */
            }
        }

        safeFit()
        // The container's final size may not be settled on first paint (flex/grid
        // layout, fonts loading). Re-fit on the next frame so the initial terminal
        // isn't sized to a too-small box.
        const raf = requestAnimationFrame(safeFit)

        // PTY bytes (base64) -> terminal. Decode base64 to a byte array so UTF-8 /
        // control sequences render correctly.
        const decode = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

        let unOut: (() => void) | undefined
        let unExit: (() => void) | undefined
        ;(async () => {
            unOut = await onPtyOutput(b64 => term.write(decode(b64)))
            unExit = await onPtyExit(code => {
                term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
                onExit?.(code)
            })
        })()

        // Keystrokes -> Go (base64-encode to preserve raw bytes).
        const dataDisp = term.onData(d => {
            const bytes = new TextEncoder().encode(d)
            let bin = ''
            bytes.forEach(b => {
                bin += String.fromCharCode(b)
            })
            writeToPty(btoa(bin)).catch(() => {})
        })

        const ro = new ResizeObserver(safeFit)
        ro.observe(host)

        return () => {
            cancelAnimationFrame(raf)
            ro.disconnect()
            dataDisp.dispose()
            unOut?.()
            unExit?.()
            term.dispose()
        }
    }, [onExit])

    // maxHeight caps the host so xterm's FitAddon computes a stable row count and
    // scrolls internally, instead of the terminal's natural height feeding back into
    // an unconstrained grid row and growing without bound. The parent still sizes it.
    return (
        <div
            ref={hostRef}
            style={{ width: '100%', height: '100%', minHeight: 360, maxHeight: '100%' }}
        />
    )
}

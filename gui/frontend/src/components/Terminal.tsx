import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { onPtyOutput, onPtyExit, writeToPty, resizePty } from '../lib/ipc'

// Embedded interactive terminal for the claude PTY. Renders raw PTY bytes and
// forwards keystrokes back to Go (which writes them to claude's pseudo-terminal),
// so claude runs fully interactively — including live permission prompts.
export function Terminal({ onExit }: { onExit?: (code: number | null) => void }) {
    const hostRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const term = new XTerm({
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 13,
            theme: { background: '#0f1419' },
            cursorBlink: true,
            convertEol: true,
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(hostRef.current!)
        fit.fit()
        resizePty(term.rows, term.cols).catch(() => {})
        // The container's final size may not be settled on first paint (flex/grid
        // layout, fonts loading). Re-fit on the next frame so the initial terminal
        // isn't sized to a too-small box.
        const raf = requestAnimationFrame(() => {
            try {
                fit.fit()
                resizePty(term.rows, term.cols).catch(() => {})
            } catch {
                /* ignore */
            }
        })

        // PTY bytes (base64) -> terminal. Decode base64 to a byte array so UTF-8 /
        // control sequences render correctly.
        const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

        let unOut: (() => void) | undefined
        let unExit: (() => void) | undefined
        ;(async () => {
            unOut = await onPtyOutput((b64) => term.write(decode(b64)))
            unExit = await onPtyExit((code) => {
                term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
                onExit?.(code)
            })
        })()

        // Keystrokes -> Go (base64-encode to preserve raw bytes).
        const dataDisp = term.onData((d) => {
            const bytes = new TextEncoder().encode(d)
            let bin = ''
            bytes.forEach((b) => (bin += String.fromCharCode(b)))
            writeToPty(btoa(bin)).catch(() => {})
        })

        const ro = new ResizeObserver(() => {
            try {
                fit.fit()
                resizePty(term.rows, term.cols).catch(() => {})
            } catch {
                /* ignore transient layout */
            }
        })
        ro.observe(hostRef.current!)

        return () => {
            cancelAnimationFrame(raf)
            ro.disconnect()
            dataDisp.dispose()
            unOut?.()
            unExit?.()
            term.dispose()
        }
    }, [])

    return <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 360 }} />
}

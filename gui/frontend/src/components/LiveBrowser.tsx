import { useState } from 'react'
import type { ConsoleLine } from '../lib/screencast'
import { BrowserPanel } from './BrowserPanel'
import { UrlBar } from './UrlBar'

// The live browser view with a URL bar header above it (a live-dot + the current
// page URL, selectable + copyable), matching the Suites testing screen. Shared by
// the Author + Validation tabs so the header + URL wiring lives in one place. Tracks
// the page URL itself (BrowserPanel surfaces it on connect + each navigation).
export function LiveBrowser({
    port,
    onConsole,
}: {
    port: number
    onConsole?: (line: ConsoleLine) => void
}) {
    const [pageUrl, setPageUrl] = useState<string | null>(null)
    return (
        <>
            <div style={headerStyle}>
                <span className="live-dot" style={{ flex: 'none' }} title="Live browser" />
                <div style={{ flex: 1, minWidth: 0 }}>
                    <UrlBar url={pageUrl} />
                </div>
            </div>
            <BrowserPanel port={port} onUrl={setPageUrl} onConsole={onConsole} />
        </>
    )
}

const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    borderBottom: '1px solid var(--line)',
} as const

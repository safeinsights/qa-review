import { useCallback, useEffect, useRef, useState } from 'react'

// A selectable, truncated URL display with a copy-to-clipboard button. Shared by
// the live-browser header (RunScreen) and the per-step snapshot footer
// (SnapshotPanel) so both format + copy a URL the same way.
export function UrlBar({ url, placeholder = 'waiting for page…' }: { url: string | null | undefined; placeholder?: string }) {
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const copy = useCallback(() => {
        if (!url) return
        void navigator.clipboard.writeText(url).then(() => {
            setCopied(true)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1400)
        })
    }, [url])
    useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            {/* Selectable, monospace, truncated — full value on hover. */}
            <span
                className="mono"
                title={url ?? undefined}
                style={{
                    flex: 1,
                    minWidth: 0,
                    userSelect: 'text',
                    cursor: 'text',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontSize: 13,
                    color: url ? 'var(--ink)' : 'var(--ink-faint)',
                    fontStyle: url ? 'normal' : 'italic',
                }}
            >
                {url ?? placeholder}
            </span>
            <button
                type="button"
                onClick={copy}
                disabled={!url}
                title={copied ? 'Copied!' : 'Copy URL'}
                aria-label="Copy URL"
                style={{
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    width: 26,
                    height: 26,
                    border: 'none',
                    borderRadius: 6,
                    background: 'transparent',
                    color: copied ? 'var(--green)' : 'var(--ink-dim)',
                    cursor: url ? 'pointer' : 'default',
                    opacity: url ? 1 : 0.4,
                }}
            >
                {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
        </div>
    )
}

// Two overlapping rounded rectangles — the standard "copy" glyph.
function CopyIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    )
}

// A checkmark shown briefly after a successful copy.
function CheckIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
        </svg>
    )
}

import { useEffect, useRef, useState } from 'react'
import type { ConsoleLevel, ConsoleLine } from '../lib/screencast'

// A scrollable browser-console view, shared by the live panel (below the live
// browser in RunScreen) and the per-step snapshot (SnapshotPanel). Rows are
// level-color-coded; in `live` mode it auto-scrolls to the newest line unless
// the user has scrolled up. A "CONSOLE" header + copy-all mirrors the UrlBar /
// ◉ SNAPSHOT / ▶ RECORDING idioms.
export function ConsoleLog({
    lines,
    live = false,
    emptyText = 'No console output.',
    maxHeight = 180,
}: {
    lines: ConsoleLine[]
    live?: boolean
    emptyText?: string
    maxHeight?: number
}) {
    const scrollRef = useRef<HTMLDivElement>(null)
    // Track whether the user is pinned to the bottom so live appends don't yank
    // them down after they've scrolled up to read earlier output.
    const atBottomRef = useRef(true)
    const [copied, setCopied] = useState(false)
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Re-pin to the bottom each time a new line arrives (while live + already at
    // bottom), so streaming output stays in view. Must depend on `lines`: the
    // scrollHeight it reads only grows because a new line just rendered, a DOM
    // dependency biome's static analysis can't see.
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-run after new lines render
    useEffect(() => {
        if (!live) return
        const el = scrollRef.current
        if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
    }, [live, lines])
    useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), [])

    const onScroll = () => {
        const el = scrollRef.current
        if (!el) return
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }

    const copyAll = () => {
        if (lines.length === 0) return
        const text = lines.map(l => `[${l.level}] ${l.text}`).join('\n')
        void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            if (copyTimer.current) clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(() => setCopied(false), 1400)
        })
    }

    return (
        <div style={{ borderTop: '1px solid var(--line)', background: 'var(--paper-sunken)' }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 16px',
                    borderBottom: lines.length ? '1px solid var(--line)' : 'none',
                }}
            >
                <span
                    className="mono"
                    style={{ color: 'var(--teal)', letterSpacing: 1, fontSize: 12 }}
                >
                    ▟ CONSOLE
                    <span className="st-dim" style={{ letterSpacing: 0, marginLeft: 8 }}>
                        {lines.length ? `· ${lines.length}` : ''}
                    </span>
                </span>
                {lines.length ? (
                    <button
                        type="button"
                        onClick={copyAll}
                        title={copied ? 'Copied!' : 'Copy all'}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            color: copied ? 'var(--green)' : 'var(--ink-dim)',
                            cursor: 'pointer',
                            fontSize: 12,
                        }}
                        className="mono"
                    >
                        {copied ? 'copied' : 'copy'}
                    </button>
                ) : null}
            </div>

            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="mono"
                style={{
                    maxHeight,
                    overflowY: 'auto',
                    padding: lines.length ? '6px 0' : 0,
                    fontSize: 12,
                }}
            >
                {lines.length === 0 ? (
                    <div className="st-dim" style={{ padding: '10px 16px', fontStyle: 'italic' }}>
                        {emptyText}
                    </div>
                ) : (
                    lines.map(l => <ConsoleRow key={`${l.at}:${l.level}:${l.text}`} line={l} />)
                )}
            </div>
        </div>
    )
}

// One console line: a level tag + its text, color-coded by level.
function ConsoleRow({ line }: { line: ConsoleLine }) {
    return (
        <div
            className={levelClass(line.level)}
            style={{
                display: 'flex',
                gap: 8,
                padding: '2px 16px',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
            }}
        >
            <span
                className="st-dim"
                style={{
                    flex: 'none',
                    textTransform: 'uppercase',
                    fontSize: 10,
                    width: 34,
                    opacity: 0.8,
                }}
            >
                {line.level}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{line.text}</span>
        </div>
    )
}

// Map a console level to a color class. `log` uses the default ink color.
function levelClass(level: ConsoleLevel): string {
    switch (level) {
        case 'error':
            return 'st-fail'
        case 'warn':
            return 'st-warn'
        case 'info':
        case 'debug':
            return 'st-dim'
        default:
            return ''
    }
}

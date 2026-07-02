import { useVideoPlayback } from '../lib/useVideoPlayback'

// A minimal custom video player. We DON'T use the native `controls` attribute
// because recordings are silent and the macOS WebKit webview ignores
// `controlsList="novolume"`, so the native bar always shows a volume slider. This
// renders our own play/pause + scrubber + time, with no volume control at all.
export function VideoPlayer({
    src,
    maxHeight,
    expanded,
    onToggleExpand,
    startAt,
    startPlaying,
    onProgress,
}: {
    src: string
    maxHeight?: number | string
    // When onToggleExpand is provided, a control-bar button toggles the full-window
    // overlay; `expanded` picks the expand (⤢) vs collapse (⤡) glyph.
    expanded?: boolean
    onToggleExpand?: () => void
    // Position handoff: seek here on mount, and resume playing if startPlaying.
    // onProgress reports (time, playing) so a sibling player can pick up where this
    // one left off when the view switches between inline and expanded.
    startAt?: number
    startPlaying?: boolean
    onProgress?: (time: number, playing: boolean) => void
}) {
    const { ref, playing, current, duration, toggle, seek } = useVideoPlayback({
        src,
        startAt,
        startPlaying,
        onProgress,
    })

    return (
        <div
            style={{
                borderRadius: 8,
                overflow: 'hidden',
                border: '1px solid var(--line)',
                background: '#000',
            }}
        >
            <video
                ref={ref}
                src={src}
                muted
                onClick={toggle}
                style={{
                    width: '100%',
                    maxHeight,
                    display: 'block',
                    cursor: 'pointer',
                    background: '#000',
                }}
            />
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    background: 'var(--paper-sunken, #1b1f24)',
                }}
            >
                <button
                    type="button"
                    onClick={toggle}
                    aria-label={playing ? 'Pause' : 'Play'}
                    style={{
                        cursor: 'pointer',
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--ink, #e6e6e6)',
                        fontSize: 14,
                        width: 22,
                        flex: 'none',
                    }}
                >
                    {playing ? '❚❚' : '▶'}
                </button>
                <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.05}
                    value={current}
                    onChange={seek}
                    aria-label="Seek"
                    style={{ flex: 1, accentColor: 'var(--teal, #0c6b5e)', cursor: 'pointer' }}
                />
                <span
                    className="mono st-dim"
                    style={{ fontSize: 11, flex: 'none', minWidth: 86, textAlign: 'right' }}
                >
                    {fmt(current)} / {fmt(duration)}
                </span>
                {onToggleExpand ? (
                    <button
                        type="button"
                        onClick={onToggleExpand}
                        aria-label={expanded ? 'Collapse' : 'Expand'}
                        title={
                            expanded
                                ? 'Collapse the recording'
                                : 'Expand the recording to fill the window'
                        }
                        style={{
                            cursor: 'pointer',
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--ink, #e6e6e6)',
                            fontSize: 22,
                            lineHeight: 1,
                            padding: '0 2px',
                            flex: 'none',
                        }}
                    >
                        {expanded ? '⤡' : '⤢'}
                    </button>
                ) : null}
            </div>
        </div>
    )
}

function fmt(s: number): string {
    if (!Number.isFinite(s) || s < 0) s = 0
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
}

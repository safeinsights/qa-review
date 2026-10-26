import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Raw markdown with a Preview toggle. Raw on purpose: a WYSIWYG editor rewrites
// tables, ids and spacing even when nobody edits, which breaks the [ID] lines and
// the hash-based sync with the Claude session.
function useCodeMirror(value: string, onChange: (text: string) => void) {
    const host = useRef<HTMLDivElement>(null)
    const view = useRef<EditorView | null>(null)
    const theme = useRef(new Compartment())
    const latestOnChange = useRef(onChange)
    latestOnChange.current = onChange
    const initialValue = useRef(value)

    useEffect(() => {
        if (!host.current) return
        const dark = window.matchMedia('(prefers-color-scheme: dark)')
        const state = EditorState.create({
            doc: initialValue.current,
            extensions: [
                lineNumbers(),
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                markdown(),
                EditorView.lineWrapping,
                theme.current.of(dark.matches ? oneDark : []),
                EditorView.updateListener.of(u => {
                    if (u.docChanged) latestOnChange.current(u.state.doc.toString())
                }),
            ],
        })
        const v = new EditorView({ state, parent: host.current })
        view.current = v
        const onScheme = (e: MediaQueryListEvent) =>
            v.dispatch({ effects: theme.current.reconfigure(e.matches ? oneDark : []) })
        dark.addEventListener('change', onScheme)
        return () => {
            dark.removeEventListener('change', onScheme)
            v.destroy()
            view.current = null
        }
        // Mount once; external value changes are applied by the effect below.
    }, [])

    // A reload from disk replaces the document without remounting (keeps undo).
    useEffect(() => {
        const v = view.current
        if (!v) return
        const current = v.state.doc.toString()
        if (current === value) return
        v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }, [value])

    return host
}

export function PlanEditor({
    value,
    onChange,
    preview,
}: {
    value: string
    onChange: (text: string) => void
    preview: boolean
}) {
    const host = useCodeMirror(value, onChange)
    return (
        <div
            style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--paper-card)',
                height: 'min(55vh, 640px)',
                overflow: 'auto',
            }}
        >
            <div ref={host} style={{ display: preview ? 'none' : 'block', height: '100%' }} />
            <PlanPreview text={value} isVisible={preview} />
        </div>
    )
}

function PlanPreview({ text, isVisible }: { text: string; isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <div style={{ padding: '12px 18px' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
    )
}

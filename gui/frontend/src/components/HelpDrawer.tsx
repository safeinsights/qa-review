import { Alert, Button, Drawer, ScrollArea } from '@mantine/core'
import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { type HelpDoc, helpDocs } from '../lib/ipc'

// The in-app Help drawer. Slides in from the right over whatever screen you're on
// and renders the plain-markdown pages under <repo>/docs/help/*.md (read by Go's
// HelpDocs). A left rail lists the pages; the selected page renders on the right.
//
// Content is intentionally NOT hardcoded here — it lives as versioned markdown in
// the repo, edited via PR and distributed to everyone by `qar sync`. This drawer is
// just the reader, so non-technical staff get an in-app manual with no terminal.
export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [docs, setDocs] = useState<HelpDoc[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [active, setActive] = useState(0)

    // Load lazily on first open so a fresh/partial checkout doesn't cost anything
    // until the user actually asks for help.
    useEffect(() => {
        if (!open || docs) return
        helpDocs()
            .then(d => {
                setDocs(d)
                setActive(0)
            })
            .catch(e => setError(String((e as { message?: string })?.message ?? e)))
    }, [open, docs])

    const current = docs?.[active] ?? null

    return (
        <Drawer
            opened={open}
            onClose={onClose}
            position="right"
            size="lg"
            title={<span className="kicker">Help</span>}
            transitionProps={{ transition: 'slide-left', duration: 200 }}
            styles={{ body: { height: 'calc(100% - 60px)', padding: 0 } }}
        >
            <HelpBody
                docs={docs}
                error={error}
                active={active}
                current={current}
                onSelect={setActive}
            />
        </Drawer>
    )
}

function HelpBody({
    docs,
    error,
    active,
    current,
    onSelect,
}: {
    docs: HelpDoc[] | null
    error: string | null
    active: number
    current: HelpDoc | null
    onSelect: (i: number) => void
}) {
    if (error)
        return (
            <Alert color="red" m="md">
                Couldn't load help: {error}
            </Alert>
        )
    if (!docs) return <div style={{ padding: 20, color: 'var(--ink-dim, #888)' }}>Loading…</div>
    if (docs.length === 0)
        return (
            <div style={{ padding: 20, color: 'var(--ink-dim, #888)' }}>
                No help pages found. Try <b>Sync</b> to pull the latest, or check that{' '}
                <span className="mono">docs/help/</span> exists in the project.
            </div>
        )

    return (
        <div style={{ display: 'flex', height: '100%' }}>
            <nav
                style={{
                    flex: '0 0 200px',
                    borderRight: '1px solid var(--line, #e5e2da)',
                    padding: '12px 8px',
                    overflowY: 'auto',
                }}
            >
                {docs.map((d, i) => (
                    <Button
                        key={d.slug}
                        variant={i === active ? 'light' : 'subtle'}
                        color="dark"
                        size="xs"
                        fullWidth
                        justify="flex-start"
                        onClick={() => onSelect(i)}
                        styles={{ root: { fontWeight: i === active ? 600 : 400, marginBottom: 2 } }}
                    >
                        {d.title}
                    </Button>
                ))}
            </nav>
            <ScrollArea style={{ flex: 1 }} type="auto">
                <article className="help-content" style={{ padding: '16px 22px' }}>
                    {current ? (
                        <>
                            <h2 style={{ marginTop: 0 }}>{current.title}</h2>
                            <Markdown remarkPlugins={[remarkGfm]}>{current.body}</Markdown>
                        </>
                    ) : null}
                </article>
            </ScrollArea>
        </div>
    )
}

import { Accordion, Anchor, Button, Loader, ScrollArea, Text } from '@mantine/core'
import { useRef, useState } from 'react'
import { type DebugReport, debugReport, type ToolProbe } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// Collapsible "Debug details" panel shown on the tools check (SetupGate) and the
// Setup Doctor. It exposes exactly why a tool resolved or didn't — the searched
// dirs, the effective PATH, and each tool's resolved path/version — so the
// Finder-PATH "installed but not found" bug is diagnosable, and lets the user
// copy that detail (the always-available fallback when `gh` can't file an issue).

// Probe the report lazily: only when the accordion is first opened, so we don't
// shell out to every tool's --version on every mount.
function useDebugReport() {
    const { run, busy, error, result } = useAsyncAction(debugReport)
    const loadedRef = useRef(false)
    const load = () => {
        if (loadedRef.current) return
        loadedRef.current = true
        void run()
    }
    return { load, busy, error, report: result }
}

export function DebugDetails() {
    const { load, busy, error, report } = useDebugReport()

    const onChange = (value: string | null) => {
        if (value === 'debug') load()
    }

    return (
        <Accordion variant="contained" chevronPosition="left" mt="md" onChange={onChange}>
            <Accordion.Item value="debug">
                <Accordion.Control>
                    <Text size="sm" fw={600}>
                        Debug details
                    </Text>
                </Accordion.Control>
                <Accordion.Panel>
                    <DebugPanelBody busy={busy} error={error} report={report} />
                </Accordion.Panel>
            </Accordion.Item>
        </Accordion>
    )
}

function DebugPanelBody({
    busy,
    error,
    report,
}: {
    busy: boolean
    error: string | null
    report: DebugReport | null
}) {
    if (busy) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                <Loader size="sm" />
                <Text size="sm">Gathering environment…</Text>
            </div>
        )
    }
    if (error) {
        return (
            <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                {error}
            </Text>
        )
    }
    if (!report) return null

    return (
        <div>
            <Field label="App version" value={report.appVersion} />
            <Field label="OS / arch" value={report.osArch} />
            <Field label="Repo dir" value={report.repoDir} />
            <Field label="Searched dirs" value={report.searchDirs.join('\n')} />
            <Field label="Effective PATH" value={report.effectivePATH} scroll />

            <Text size="sm" fw={600} mt={12} mb={4}>
                Tools
            </Text>
            {report.tools.map(t => (
                <ToolRow key={t.name} tool={t} />
            ))}

            <CopyButton markdown={report.markdown} />
        </div>
    )
}

function Field({ label, value, scroll }: { label: string; value: string; scroll?: boolean }) {
    const body = (
        <div
            className="mono st-dim"
            style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
            {value || '(none)'}
        </div>
    )
    return (
        <div style={{ marginBottom: 8 }}>
            <Text size="xs" fw={600} className="st-dim">
                {label}
            </Text>
            {scroll ? (
                <ScrollArea.Autosize mah={120} type="auto">
                    {body}
                </ScrollArea.Autosize>
            ) : (
                body
            )}
        </div>
    )
}

function ToolRow({ tool }: { tool: ToolProbe }) {
    const detail = tool.error ? `version check failed: ${tool.error}` : tool.version
    return (
        <div
            style={{
                display: 'flex',
                gap: 10,
                padding: '6px 0',
                borderTop: '1px solid var(--line)',
                alignItems: 'flex-start',
            }}
        >
            <span
                aria-hidden
                style={{
                    fontSize: 14,
                    lineHeight: '18px',
                    color: tool.found ? 'var(--green)' : 'var(--red)',
                    flex: 'none',
                }}
            >
                {tool.found ? '✓' : '✗'}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{tool.name}</div>
                <div className="mono st-dim" style={{ fontSize: 12, wordBreak: 'break-word' }}>
                    {tool.found ? tool.resolvedAt || '(resolved)' : 'not found'}
                </div>
                {tool.found && detail ? (
                    <div className="mono st-dim" style={{ fontSize: 12, wordBreak: 'break-word' }}>
                        {detail}
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function CopyButton({ markdown }: { markdown: string }) {
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const copy = () => {
        void navigator.clipboard.writeText(markdown).then(() => {
            setCopied(true)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1400)
        })
    }

    return (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button variant="default" size="xs" onClick={copy}>
                {copied ? 'Copied' : 'Copy debug log'}
            </Button>
            <Text size="xs" className="st-dim">
                Paste into a bug report if{' '}
                <Anchor href="https://cli.github.com/" target="_blank" size="xs">
                    gh
                </Anchor>{' '}
                isn't set up.
            </Text>
        </div>
    )
}

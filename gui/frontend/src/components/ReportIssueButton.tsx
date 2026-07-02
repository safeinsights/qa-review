import { Anchor, Button, Modal, Text, Textarea, TextInput } from '@mantine/core'
import { useState } from 'react'
import { reportIssue } from '../lib/ipc'
import { runStateSummary } from '../lib/runState'
import { useAsyncAction } from '../lib/useAsyncAction'

// Header "Report Issue" action: opens a GitHub issue on the qa-review repo with
// debug context auto-attached — the current Suites run state, or (on the Author
// tab) the full Claude session transcript. The user supplies a title + optional
// note; Go gathers system/repo debug info and runs `gh issue create`.
export function ReportIssueButton({ tab }: { tab: string | null }) {
    const [opened, setOpened] = useState(false)
    const [title, setTitle] = useState('')
    const [note, setNote] = useState('')

    const isAuthoring = tab === 'exploratory'
    const contextLabel = isAuthoring
        ? 'the full Claude authoring transcript'
        : 'the current Suites run state'

    const {
        run,
        busy,
        error,
        result: createdUrl,
        reset,
    } = useAsyncAction(async () => {
        // Build the Suites run summary on the JS side; Go owns the transcript.
        const runState = isAuthoring ? '' : runStateSummary()
        return await reportIssue(title, note, tab ?? 'suites', runState)
    })

    const open = () => {
        setTitle(isAuthoring ? 'Authoring issue: ' : 'Suite run issue: ')
        setNote('')
        reset()
        setOpened(true)
    }

    const submit = () => {
        void run()
    }

    return (
        <>
            <Button
                onClick={open}
                variant="outline"
                color="dark"
                radius="md"
                size="sm"
                leftSection={<span aria-hidden>⚑</span>}
                styles={{ root: { fontFamily: '"IBM Plex Mono", monospace', fontSize: 12 } }}
            >
                report issue
            </Button>

            <Modal
                opened={opened}
                onClose={() => setOpened(false)}
                title="Report an issue"
                centered
                size="lg"
            >
                {createdUrl ? (
                    <div>
                        <Text size="sm" mb={8}>
                            Issue created:
                        </Text>
                        <Anchor
                            href={createdUrl}
                            target="_blank"
                            className="mono"
                            style={{ fontSize: 13 }}
                        >
                            {createdUrl}
                        </Anchor>
                        <div style={{ marginTop: 16, textAlign: 'right' }}>
                            <Button onClick={() => setOpened(false)} size="sm" variant="default">
                                Close
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div>
                        <Text size="sm" c="dimmed" mb={10}>
                            This files a GitHub issue on{' '}
                            <span className="mono">safeinsights/qa-review</span> with {contextLabel}{' '}
                            and system/repo debug info attached automatically.
                        </Text>
                        <TextInput
                            label="Title"
                            value={title}
                            onChange={e => setTitle(e.currentTarget.value)}
                            mb={10}
                        />
                        <Textarea
                            label="What happened? (optional)"
                            placeholder="Describe what you expected vs. what occurred…"
                            value={note}
                            onChange={e => setNote(e.currentTarget.value)}
                            autosize
                            minRows={3}
                            maxRows={8}
                            mb={12}
                        />
                        {error ? (
                            <Text size="xs" c="red" mb={10} style={{ whiteSpace: 'pre-wrap' }}>
                                {error}
                            </Text>
                        ) : null}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                            <Button onClick={() => setOpened(false)} size="sm" variant="default">
                                Cancel
                            </Button>
                            <Button
                                onClick={submit}
                                loading={busy}
                                size="sm"
                                color="teal"
                                disabled={!title.trim()}
                            >
                                Create issue
                            </Button>
                        </div>
                    </div>
                )}
            </Modal>
        </>
    )
}

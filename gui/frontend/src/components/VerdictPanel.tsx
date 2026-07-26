import { Button, Group, Popover, Text } from '@mantine/core'
import { useState } from 'react'
import { sendToPty } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// After Claude has validated the ticket in the browser, the human sets the verdict.
// Both buttons tell Claude (in the PTY) to capture a screenshot of the relevant
// screen(s), post its findings as a Jira comment + attach the screenshot, and
// transition the ticket. They differ in the transition:
//   Validated → comment + screenshot, transition to "Final Review - EM & PM"
//   Rejected  → comment + screenshot, un-assign, transition to "Development"
// Claude runs in default-ish mode, so each Jira write still prompts live in the
// terminal (the human confirms there).
export function VerdictPanel({ card }: { card: string }) {
    const [opened, setOpened] = useState(false)
    const [status, setStatus] = useState('')
    const ready = !!card

    const post = (verdict: 'validated' | 'rejected') => async () => {
        const transition =
            verdict === 'validated'
                ? 'transition it to "Final Review - EM & PM"'
                : 'un-assign the assignee (set assignee to null) and transition it to "Development"'
        await sendToPty(
            `Mark ${card} ${verdict.toUpperCase()}: capture a screenshot of the relevant ` +
                `screen(s) with the chrome-devtools MCP, add a Jira comment summarizing what ` +
                `you tested and the ${verdict.toUpperCase()} verdict with reasoning, attach the ` +
                `screenshot via jira_update_issue, then resolve the transition by name ` +
                `(jira_get_transitions) and ${transition}. Confirm the comment with me before posting.`
        )
        setStatus(`Sent to Claude — confirm the ${verdict} post in the terminal.`)
    }

    const { run: validate, busy: validating } = useAsyncAction(post('validated'))
    const { run: reject, busy: rejecting } = useAsyncAction(post('rejected'))

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow width={340}>
            <Popover.Target>
                <Button
                    onClick={() => setOpened(o => !o)}
                    variant="light"
                    color="grape"
                    size="sm"
                    disabled={!ready}
                >
                    Verdict
                </Button>
            </Popover.Target>
            <Popover.Dropdown>
                <Text size="sm" mb={8}>
                    Post Claude's findings + a screenshot to{' '}
                    <span className="mono">{card || '(no card)'}</span> and set its status.
                </Text>
                <Group gap={8}>
                    <Button
                        onClick={validate}
                        loading={validating}
                        disabled={!ready}
                        size="xs"
                        color="teal"
                    >
                        Validated → Final Review
                    </Button>
                    <Button
                        onClick={reject}
                        loading={rejecting}
                        disabled={!ready}
                        size="xs"
                        color="red"
                        variant="light"
                    >
                        Rejected → Development
                    </Button>
                </Group>
                {status ? (
                    <Text
                        size="xs"
                        mt={8}
                        className="mono st-dim"
                        style={{ whiteSpace: 'pre-wrap' }}
                    >
                        {status}
                    </Text>
                ) : null}
            </Popover.Dropdown>
        </Popover>
    )
}

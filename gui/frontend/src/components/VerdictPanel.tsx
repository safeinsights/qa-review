import { Badge, Button, Group, Popover, Text } from '@mantine/core'
import { useEffect, useState } from 'react'
import { onVerdictPosted, sendToPty } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// The status move is left to the qa-validate skill's "Transition the ticket" table,
// because it depends on the target env and on open decisions, which this panel
// does not know. Each Jira write still prompts in the terminal.
export function VerdictPanel({ card }: { card: string }) {
    const [opened, setOpened] = useState(false)
    const [status, setStatus] = useState('')
    // Once Claude records a verdict (`qar verdict-posted`) — via these buttons OR a
    // manual instruction — the button is replaced by a badge showing the outcome.
    const [posted, setPosted] = useState<'validated' | 'rejected' | null>(null)
    const ready = !!card

    useEffect(() => {
        let un: (() => void) | undefined
        ;(async () => {
            un = await onVerdictPosted(v => {
                // Only react to the card this panel is showing.
                if (card && v.issue.toUpperCase() === card.toUpperCase()) setPosted(v.result)
            })
        })()
        return () => un?.()
    }, [card])

    const post = (verdict: 'validated' | 'rejected') => async () => {
        await sendToPty(
            `Mark ${card} ${verdict.toUpperCase()}: capture a screenshot of the relevant ` +
                `screen(s) with the chrome-devtools MCP, add a Jira comment summarizing what ` +
                `you tested and the ${verdict.toUpperCase()} verdict with reasoning, attach the ` +
                `screenshot via jira_update_issue, then resolve the transition by name ` +
                `(jira_get_transitions), then move and assign the card as the "Transition the ` +
                `ticket" table in the qa-validate skill says for this target. Confirm the comment with me before ` +
                `posting. After it's posted, run \`qar verdict-posted --issue ${card} ` +
                `--result ${verdict}\`.`
        )
        setStatus(`Sent to Claude — confirm the ${verdict} post in the terminal.`)
    }

    const { run: validate, busy: validating } = useAsyncAction(post('validated'))
    const { run: reject, busy: rejecting } = useAsyncAction(post('rejected'))

    // A verdict has been posted for this card — replace the button with the outcome.
    if (posted) {
        return (
            <Badge color={posted === 'validated' ? 'teal' : 'red'} variant="light" size="lg">
                {posted === 'validated' ? '✓ Validated' : '✗ Rejected'}
            </Badge>
        )
    }

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
                        Validated
                    </Button>
                    <Button
                        onClick={reject}
                        loading={rejecting}
                        disabled={!ready}
                        size="xs"
                        color="red"
                        variant="light"
                    >
                        Rejected
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

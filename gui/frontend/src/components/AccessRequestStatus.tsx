import { Alert, Anchor, Button, Group, Loader, Text, TextInput } from '@mantine/core'
import { useState } from 'react'
import { type KeyringAccess, openAccessPr, requestAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// What each state means and what the single primary button does about it. Keeping
// this as data (not branches in JSX) keeps the component readable as the state list
// grows.
const COPY: Record<string, { message: string; action: string }> = {
    'no-identity': {
        message: 'Request access to decrypt the shared account passwords and MFA codes.',
        action: 'Request access',
    },
    'no-branch': {
        message: 'Your key exists but the request was never submitted.',
        action: 'Submit request',
    },
    'branch-no-pr': {
        message: 'Your branch was pushed but no pull request was opened.',
        action: 'Open pull request',
    },
    'pr-open': {
        message: 'Your access request is open and waiting for a reviewer.',
        action: 'Check again',
    },
    'pr-closed': {
        message: 'Your access request was closed without being merged.',
        action: 'Re-open request',
    },
    'merged-awaiting-rekey': {
        message:
            'Your request was merged. A reviewer still needs to run "qar rekey" before the secrets are encrypted to your key.',
        action: 'Check again',
    },
}

function useAccessAction(state: string, onRetry: () => void) {
    // branch-no-pr is the only state whose action is PR creation; no-identity and
    // no-branch submit the request; everything else just re-checks.
    return useAsyncAction(async (name: string) => {
        if (state === 'branch-no-pr') return openAccessPr()
        if (state === 'no-identity' || state === 'no-branch' || state === 'pr-closed') {
            const out = await requestAccess(name)
            onRetry()
            return out
        }
        onRetry()
        return ''
    })
}

export function AccessRequestStatus({
    access,
    checking,
    onRetry,
}: {
    access: KeyringAccess | null
    checking: boolean
    onRetry: () => void
}) {
    const state = access?.state || 'no-identity'
    const copy = COPY[state] ?? COPY['no-identity']
    const action = useAccessAction(state, onRetry)
    // Only asked for when git has no user.name — the engine derives it otherwise.
    const [name, setName] = useState('')
    const needsName = state === 'no-identity' && !access?.branch

    return (
        <div>
            <Text size="sm" mb={10}>
                {copy.message}
            </Text>

            {access?.prURL ? (
                <Text size="sm" mb={10}>
                    <Anchor href={access.prURL} target="_blank">
                        Pull request #{access.prNumber}
                    </Anchor>
                </Text>
            ) : null}

            {access && !access.githubReachable ? (
                <Alert color="yellow" mb={10}>
                    Couldn’t reach GitHub — showing the last state we could confirm locally.
                </Alert>
            ) : null}

            <Group align="flex-end">
                {needsName ? (
                    <TextInput
                        label="Your name"
                        description="Only needed because git user.name isn’t set"
                        placeholder="Ada Lovelace"
                        value={name}
                        onChange={e => setName(e.currentTarget.value)}
                        style={{ flex: 1 }}
                    />
                ) : null}
                <Button
                    onClick={() => void action.run(name.trim())}
                    loading={action.busy || checking}
                    color="teal"
                >
                    {copy.action}
                </Button>
                {checking ? <Loader size="xs" /> : null}
            </Group>

            {action.error ? (
                <Alert color="red" mt="sm">
                    {action.error}
                </Alert>
            ) : null}
            {access?.note ? (
                <Text size="xs" mt={8} className="mono st-dim">
                    {access.note}
                </Text>
            ) : null}
        </div>
    )
}

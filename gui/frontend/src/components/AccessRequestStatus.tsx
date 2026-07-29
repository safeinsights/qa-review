import { Alert, Anchor, Button, Group, Loader, Text, TextInput } from '@mantine/core'
import { useState } from 'react'
import { type AccessState, type KeyringAccess, openAccessPr, requestAccess } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'

// What each state means and what the single primary button does about it. Keeping
// this as data (not branches in JSX) keeps the component readable as the state list
// grows. Typed as Record<AccessState, ...> (not Record<string, ...>) so adding a
// new AccessState without a COPY entry is a COMPILE ERROR, not a silently blank
// panel. The empty-string state (engine call failed/unavailable) isn't a real
// AccessState and isn't a key here — see UNKNOWN_COPY below.
const COPY: Record<AccessState, { message: string; action: string }> = {
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
        // A merged-but-not-yet-locally-pulled PR also reports this state (the
        // local clone hasn't seen the merge yet), where "closed without being
        // merged" is actively wrong and "Re-open request" pushes toward a
        // duplicate. Keep the wording accurate for both cases.
        message: 'Your access request PR is closed. If it was merged, a sync will pick that up.',
        action: 'Re-open request',
    },
    'merged-awaiting-rekey': {
        message:
            'Your request was merged. A reviewer still needs to run "qar rekey" before the secrets are encrypted to your key.',
        action: 'Check again',
    },
    ready: {
        message: 'Your key can decrypt the shared account passwords and MFA codes.',
        action: 'Check again',
    },
}

// The engine call failed or returned no status (access?.state === ''), not a real
// AccessState. Its action must be read-only — "no-identity"'s "Request access"
// would submit a fresh request off of possibly-stale local data, which is exactly
// the duplicate-request action this state must NOT offer.
const UNKNOWN_COPY = {
    message: "Couldn't determine your access request status.",
    action: 'Check again',
}

// '' covers both "no access data yet" (access === null) and "the engine call
// failed" (access.state === ''; Go returns a zero-value struct in that case, see
// gui/app.go accessStatus). Neither is a real AccessState, so it's kept out of
// the `state` type below and handled as its own case, not folded into
// 'no-identity' — that would offer "Request access", the one action able to
// duplicate a request, in response to a local failure that has nothing to do
// with whether a request already exists.
function useAccessAction(state: AccessState | '', onRetry: () => void) {
    // branch-no-pr is the only state whose action is PR creation; no-identity and
    // no-branch submit the request; everything else (including unknown/'') just
    // re-checks — a read-only retry can never duplicate a request.
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
    const state = access?.state ?? ''
    const copy = state ? COPY[state] : UNKNOWN_COPY
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
                    Couldn’t confirm your live status — showing the last state we could confirm
                    locally. See the detail below.
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

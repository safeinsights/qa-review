import { Alert, Button } from '@mantine/core'
import type { SessionKind } from '../lib/ipc'

// Shown in a tab (Author / Validation) when the OTHER tab owns the single shared
// session (one PTY + one browser at a time). The user can take over — stopping the
// other tab's session frees the slot so this tab can start its own.
const KIND_LABEL: Record<SessionKind, string> = {
    authoring: 'Author a Suite',
    validation: 'Validation',
    companion: 'run companion',
}

export function SessionUnavailable({
    ownerKind,
    onTakeOver,
}: {
    ownerKind: SessionKind
    onTakeOver: () => void
}) {
    return (
        <Alert color="yellow" title="Session unavailable">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span>
                    A <strong>{KIND_LABEL[ownerKind]}</strong> session is running. Only one session
                    (browser + Claude) can run at a time.
                </span>
                <Button onClick={onTakeOver} color="yellow" variant="light" size="sm">
                    Stop it &amp; start here
                </Button>
            </div>
        </Alert>
    )
}

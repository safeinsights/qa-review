import { Button, Modal } from '@mantine/core'
import { useState } from 'react'
import { type DoctorCheck, runDoctor } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'
import { DoctorResults } from './DoctorResults'

// "Run Setup Doctor": checks + validates every prerequisite app/state (required
// CLIs and versions, gh auth, Chrome, the cloned repo, the keyring identity) and
// shows a modal with a ✓/✗ beside each, plus any error and a remediation hint.
export function SetupDoctorButton() {
    const [opened, setOpened] = useState(false)
    const {
        run: runAction,
        busy: running,
        error,
        result: checks,
    } = useAsyncAction<[], DoctorCheck[]>(() => runDoctor())

    const run = () => {
        setOpened(true)
        void runAction()
    }

    return (
        <>
            <Button onClick={run} variant="light" color="teal" size="sm">
                Run Setup Doctor
            </Button>

            <Modal
                opened={opened}
                onClose={() => setOpened(false)}
                title="Setup Doctor"
                centered
                size="lg"
            >
                <DoctorResults running={running} error={error} checks={checks} />
                {!running && checks ? (
                    <div
                        style={{
                            marginTop: 16,
                            display: 'flex',
                            justifyContent: 'space-between',
                        }}
                    >
                        <Button onClick={run} size="xs" variant="default">
                            Re-run
                        </Button>
                        <Button onClick={() => setOpened(false)} size="xs" variant="default">
                            Close
                        </Button>
                    </div>
                ) : null}
            </Modal>
        </>
    )
}

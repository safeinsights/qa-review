import { Alert, Button, Modal } from '@mantine/core'
import { useEffect, useState } from 'react'
import { type DoctorCheck, runDoctor } from '../lib/ipc'
import { useAsyncAction } from '../lib/useAsyncAction'
import { DoctorResults, doctorFailingCount } from './DoctorResults'

// Once the doctor has passed cleanly we stop auto-opening it. Persisted so a
// clean machine doesn't get the modal on every launch, while a machine with
// issues keeps getting it until fixed.
const PASSED_KEY = 'qar.doctor.passed'

// On launch, auto-run the Setup Doctor and show results in a modal. Shown on the
// first launch and on every subsequent launch UNTIL the doctor passes once, then
// suppressed. Dismissable — the user can close it and use the app, but it returns
// next launch while any check still fails. (The manual "Run Setup Doctor" button
// in Settings stays available regardless.)
export function AutoDoctorModal() {
    const [opened, setOpened] = useState(false)
    const {
        run,
        busy: running,
        error,
        result: checks,
    } = useAsyncAction<[], DoctorCheck[]>(() => runDoctor())

    useEffect(() => {
        if (localStorage.getItem(PASSED_KEY) === '1') return
        setOpened(true)
        void run()
    }, [run])

    // Once a run comes back clean, remember it so we stop auto-opening next time.
    useEffect(() => {
        if (checks && doctorFailingCount(checks) === 0) {
            localStorage.setItem(PASSED_KEY, '1')
        }
    }, [checks])

    const failing = doctorFailingCount(checks)
    const allOk = checks !== null && failing === 0

    return (
        <Modal
            opened={opened}
            onClose={() => setOpened(false)}
            title="Setup check"
            centered
            size="lg"
        >
            <DoctorResults running={running} error={error} checks={checks} />
            {!running && checks && !allOk ? (
                <Alert color="yellow" mt="sm">
                    You can dismiss this and use the app, but runs may fail until these are
                    resolved. This check will reappear next launch until everything passes.
                </Alert>
            ) : null}
            {!running && checks ? (
                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
                    <Button onClick={() => void run()} size="xs" variant="default">
                        Re-run
                    </Button>
                    <Button onClick={() => setOpened(false)} size="xs" variant="default">
                        {allOk ? 'Done' : 'Dismiss'}
                    </Button>
                </div>
            ) : null}
        </Modal>
    )
}

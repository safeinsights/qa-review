import { useEffect, useRef, useState } from 'react'
import { TextInput, Button, Popover, Text } from '@mantine/core'
import { sendToPty, promoteSuite, suiteFileExists } from '../lib/ipc'

// "Save as suite": send claude a finalizing instruction (write the suite, then run
// + debug it until it passes), then open the PR. "Open PR" stays disabled until the
// user has clicked "Write + verify" AND claude has actually written the suite file
// — you can't promote a suite that was never authored. Once "Write + verify" is
// sent we POLL for the file so the button enables itself the moment it lands (a
// disabled button can't fire hover/focus events, so we can't rely on those).
export function SaveSuitePanel({ env, pr, role }: { env: string; pr: string; role: string }) {
    const [name, setName] = useState('')
    const [opened, setOpened] = useState(false)
    const [status, setStatus] = useState('')
    const [busy, setBusy] = useState(false)
    // Gate for "Open PR": did we ask claude to write+verify, and does the file exist?
    const [verifySent, setVerifySent] = useState(false)
    const [fileReady, setFileReady] = useState(false)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // Filesystem/branch-safe: letters, digits, hyphen, underscore, up to 40 chars.
    const valid = /^[A-Za-z0-9_-]{1,40}$/.test(name)

    const stopPolling = () => {
        if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
        }
    }

    // After "Write + verify", poll the disk until claude has written the suite
    // file, then flip the gate. Stops once found (or when the gate is reset).
    useEffect(() => {
        if (!verifySent || !valid || fileReady) {
            stopPolling()
            return
        }
        const check = async () => {
            try {
                if (await suiteFileExists(name)) {
                    setFileReady(true)
                    stopPolling()
                }
            } catch {
                /* keep polling */
            }
        }
        void check()
        pollRef.current = setInterval(check, 2000)
        return stopPolling
    }, [verifySent, valid, fileReady, name])

    // Reset the gate whenever the name changes — the old file no longer applies.
    const onNameChange = (next: string) => {
        setName(next)
        setVerifySent(false)
        setFileReady(false)
        stopPolling()
    }

    const finalize = async () => {
        if (!valid) return
        const target = pr ? `--pr ${pr}` : `--env ${env}`
        // Tell claude (in the live terminal) to author + self-verify the suite.
        await sendToPty(
            `Now write this as a suite (a TypeScript Suite object driving Playwright) to ` +
                `src/suites/${name}.ts following src/suites/types.ts and the create-study.ts template. ` +
                `Use the declarative shape: a \`steps: Step[]\` array where each entry is ` +
                `\`{ name, run: async (ctx) => { await ctx.step(name, async () => { … }) } }\`, and thread ` +
                `any shared values between steps via \`ctx.state\` (there is no \`suite.run()\`). ` +
                `Then run it with \`qar run --suite ${name} --role ${role} ${target}\` and debug until it passes. ` +
                `Tell me when it's green.`,
        )
        setFileReady(false)
        setVerifySent(true)
        setStatus('Sent to Claude. "Open PR" enables once the suite file is written.')
    }

    const openPr = async () => {
        if (!valid || !verifySent) return
        setBusy(true)
        setStatus('Checking the suite file…')
        const exists = await suiteFileExists(name).catch(() => false)
        if (!exists) {
            setFileReady(false)
            setStatus(`No src/suites/${name}.ts yet — let Claude finish writing + verifying it first.`)
            setBusy(false)
            return
        }
        setStatus('Compiling + opening PR…')
        try {
            const out = await promoteSuite(name)
            setStatus('PR opened: ' + out)
        } catch (e) {
            setStatus('Promote failed: ' + String(e))
        } finally {
            setBusy(false)
        }
    }

    const canOpenPr = valid && verifySent && fileReady

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow width={360}>
            <Popover.Target>
                <Button onClick={() => setOpened((o) => !o)} variant="light" color="teal" size="sm">
                    Save as suite
                </Button>
            </Popover.Target>
            <Popover.Dropdown>
                <Text size="sm" mb={6}>
                    Name the suite, have Claude write + verify it, then open a PR.
                </Text>
                <TextInput
                    value={name}
                    onChange={(e) => onNameChange(e.currentTarget.value)}
                    placeholder="suite name (max 40 chars)"
                    error={name && !valid ? 'letters, digits, - and _ only; max 40 chars' : undefined}
                    mb={8}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button onClick={finalize} disabled={!valid} size="xs" variant="default">
                        Write + verify
                    </Button>
                    <Button onClick={openPr} disabled={!canOpenPr} loading={busy} size="xs" color="teal">
                        Open PR
                    </Button>
                </div>
                {verifySent && !fileReady ? (
                    <Text size="xs" mt={6} className="st-dim">
                        Waiting for Claude to write the suite file…
                    </Text>
                ) : null}
                {status ? (
                    <Text size="xs" mt={8} className="mono st-dim" style={{ whiteSpace: 'pre-wrap' }}>
                        {status}
                    </Text>
                ) : null}
            </Popover.Dropdown>
        </Popover>
    )
}
